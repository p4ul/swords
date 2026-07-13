// Pose tracking worker: MoveNet inference runs here, fully off the main
// thread, so the game renderer never shares its frame budget with the model.
// The main thread sends ImageBitmap camera frames; we reply with tracked
// hands. Classic worker (importScripts) because tf.js ships as UMD bundles.
importScripts('../vendor/tf.min.js', '../vendor/pose-detection.min.js');

const MIN_SCORE = 0.3;
const MODEL_BYTES = 4650216;

const log = (msg) => postMessage({ type: 'log', msg });
const progress = (msg, frac) => postMessage({ type: 'progress', msg, frac });

function makeHand(elbow, wrist) {
  if (!elbow || !wrist) return null;
  const score = Math.min(elbow.score, wrist.score);
  if (score < MIN_SCORE) return null;
  return {
    elbow: { x: elbow.x, y: elbow.y },
    wrist: { x: wrist.x, y: wrist.y },
    score,
  };
}

function extractHands(pose) {
  if (!pose) return { left: null, right: null };
  const kp = {};
  for (const k of pose.keypoints) kp[k.name] = k;
  return {
    left: makeHand(kp.left_elbow, kp.left_wrist),
    right: makeHand(kp.right_elbow, kp.right_wrist),
  };
}

// Count model weight bytes as they stream through fetch (same trick as the
// main-thread path) so the loading bar shows real download progress.
async function withDownloadProgress(onBytes, run) {
  const orig = self.fetch.bind(self);
  self.fetch = async (input, init) => {
    const res = await orig(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.includes('movenet-lightning.bin') || !res.body) return res;
    const total = Number(res.headers.get('Content-Length')) || MODEL_BYTES;
    const reader = res.body.getReader();
    let loaded = 0;
    const counted = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        loaded += value.byteLength;
        onBytes(Math.min(1, loaded / total), loaded);
        controller.enqueue(value);
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  try {
    return await run();
  } finally {
    self.fetch = orig;
  }
}

let videoW = 480;
let videoH = 360;

function scaleHand(hand, fx, fy) {
  if (!hand) return null;
  return {
    elbow: { x: hand.elbow.x * fx, y: hand.elbow.y * fy },
    wrist: { x: hand.wrist.x * fx, y: hand.wrist.y * fy },
    score: hand.score,
  };
}

async function initBackend(forced) {
  const chain = forced ? [forced] : ['webgl', 'wasm', 'cpu'];
  for (const name of chain) {
    try {
      if (name === 'wasm') {
        importScripts('../vendor/wasm/tf-backend-wasm.min.js');
        tf.wasm.setWasmPaths('../vendor/wasm/');
      }
      await tf.setBackend(name);
      await tf.ready();
      return name;
    } catch (err) {
      log(`backend '${name}' unavailable in worker: ${err.message}`);
    }
  }
  throw new Error('no usable TF.js backend in worker');
}

let detector = null;

async function init(opts) {
  const t0 = performance.now();
  const since = () => `${Math.round(performance.now() - t0)} ms`;

  progress('Starting inference engine (worker)…', 0.18);
  try { tf.env().set('WEBGL_USE_SHAPES_UNIFORMS', true); } catch {}
  try { tf.env().set('WEBGL_FORCE_F16_TEXTURES', true); } catch {}
  videoW = opts.videoW || 480;
  videoH = opts.videoH || 360;
  await initBackend(opts.backend);
  log(`worker tf backend '${tf.getBackend()}' ready — ${since()}`);
  // Log the WORKER's GPU: on some Android devices the page gets the real GPU
  // but OffscreenCanvas WebGL in a worker silently falls back to a software
  // rasterizer — this log is how we tell.
  try {
    const oc = new OffscreenCanvas(1, 1);
    const gl = oc.getContext('webgl2') || oc.getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) log(`worker GPU: ${gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}`);
  } catch { /* diagnostics only */ }

  progress('Loading sword-tracking model…', 0.25);
  detector = await withDownloadProgress(
    (frac, bytes) => progress(
      `Loading sword-tracking model… ${(bytes / 1048576).toFixed(1)} MB`,
      0.25 + frac * 0.55,
    ),
    () => poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        modelUrl: '../vendor/movenet/movenet-lightning.json',
      },
    ),
  );
  log(`MoveNet detector created in worker — ${since()}`);

  progress('Compiling shaders (worker)…', 0.88);
  const h = opts.videoH || 360;
  const w = opts.videoW || 480;
  if (tf.getBackend() === 'webgl') {
    const backend = tf.backend();
    if (typeof backend.checkCompileCompletionAsync === 'function') {
      const warmupInput = tf.zeros([h, w, 3], 'int32');
      try {
        tf.env().set('ENGINE_COMPILE_ONLY', true);
        await detector.estimatePoses(warmupInput);
        tf.env().set('ENGINE_COMPILE_ONLY', false);
        const done = await Promise.race([
          backend.checkCompileCompletionAsync().then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 20000)),
        ]);
        if (!done) log('worker parallel compile poll timed out — finishing synchronously');
        if (typeof backend.getUniformLocations === 'function') backend.getUniformLocations();
        if (typeof detector.reset === 'function') detector.reset();
      } catch (err) {
        try { tf.env().set('ENGINE_COMPILE_ONLY', false); } catch {}
        log(`worker parallel compile failed (${err.message}) — blocking warm-up`);
      } finally {
        warmupInput.dispose();
      }
    }
  }
  const z = tf.zeros([h, w, 3], 'int32');
  await detector.estimatePoses(z);
  z.dispose();
  if (typeof detector.reset === 'function') detector.reset();
  log(`worker warm, first inference done — ${since()}`);
  progress('Ready!', 1);
}

let inferBusy = false;

onmessage = async (e) => {
  const d = e.data;
  if (d.type === 'init') {
    try {
      await init(d);
      postMessage({ type: 'ready' });
    } catch (err) {
      postMessage({ type: 'error', message: err.message });
    }
  } else if (d.type === 'frame') {
    if (!detector || inferBusy) { d.bitmap.close(); return; }
    inferBusy = true;
    const t = performance.now();
    // Frames arrive downscaled; report keypoints in original video coords.
    const fx = videoW / d.bitmap.width;
    const fy = videoH / d.bitmap.height;
    try {
      const poses = await detector.estimatePoses(d.bitmap);
      const hands = extractHands(poses[0]);
      postMessage({
        type: 'hands',
        hands: { left: scaleHand(hands.left, fx, fy), right: scaleHand(hands.right, fx, fy) },
        inferMs: performance.now() - t,
      });
    } catch (err) {
      postMessage({ type: 'hands', hands: { left: null, right: null }, inferMs: 0, error: err.message });
    } finally {
      inferBusy = false;
      d.bitmap.close();
    }
  }
};
