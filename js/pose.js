// Camera + MoveNet pose tracking.
// MoveNet (SinglePose Lightning) is a real-time human keypoint detector in the
// same family as YOLO-pose — it runs ~30-50 fps on a tablet GPU via WebGL.
// We only care about elbows + wrists: each forearm becomes a sword.

const MIN_SCORE = 0.3;
const MODEL_BYTES = 4650216; // size of movenet-lightning.bin, progress fallback

const log = (...args) => console.log('[SwordStorm]', ...args);

export async function openCamera(video) {
  const t0 = performance.now();
  log('requesting front camera…');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      // MoveNet only sees a 192x192 crop internally — 480x360 capture keeps
      // the per-frame GPU upload (fromPixels) cheap with no tracking loss.
      width: { ideal: 480 },
      height: { ideal: 360 },
    },
  });
  video.srcObject = stream;
  await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve();
  });
  await video.play();
  log(`camera open ${video.videoWidth}x${video.videoHeight} — ${Math.round(performance.now() - t0)} ms`);
  return stream;
}

// Temporarily wrap window.fetch so the model weight download reports byte
// progress (TF.js loads the weights with fetch; we count the stream as it
// passes through — no double download).
async function withDownloadProgress(onBytes, run) {
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
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
    window.fetch = orig;
  }
}

// Preferred tracker: inference in a Web Worker, completely off the main
// thread — the game renderer keeps its whole frame budget. Falls back to
// createTracker (below) if workers/ImageBitmap aren't available.
export function workerTrackingSupported() {
  return typeof Worker !== 'undefined'
    && typeof createImageBitmap === 'function'
    && typeof OffscreenCanvas !== 'undefined';
}

const BACKEND_KEY = 'swordstorm_backend_v2';
const SLOW_INFER_MS = 150;   // current engine slower than this → try the other
const BENCH_FRAMES = 40;     // frames sampled per engine
// Downscale camera frames before transfer: MoveNet only sees a 192px crop,
// so a 256x192 bitmap costs far less to create, transfer, and upload.
const FRAME_W = 256;
const FRAME_H = 192;

export async function createWorkerTracker(video, onProgress = () => {}) {
  const params = new URLSearchParams(location.search);
  const forced = params.get('backend');
  if (params.has('rebench')) localStorage.removeItem(BACKEND_KEY);
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(BACKEND_KEY) || 'null'); } catch {}

  const state = {
    hands: { left: null, right: null },
    fps: 0,
    inferMs: 0,
    engine: '',
    running: true,
    worker: true,
  };

  let worker = null;
  let engine = forced || (stored && stored.engine) || 'webgl';
  let last = performance.now();
  let lastFpsLog = last;

  // Self-healing engine selection: every run re-measures the current engine
  // over BENCH_FRAMES. If it's slow, hot-swap to the other engine, compare,
  // keep the faster one, persist {engine, ms}. Never persist a choice when
  // the alternative failed to start — a webgl-worker that silently falls
  // back to a software rasterizer (common on Android) must not get locked in.
  let phase = forced ? 'fixed' : 'sampling';
  let triedOther = false;
  const results = {};
  let sampleSum = 0;
  let sampleN = 0;

  const spawn = (backend, quiet) => new Promise((resolve, reject) => {
    const w = new Worker('js/pose-worker.js');
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress' && !quiet) onProgress(d.msg, d.frac);
      else if (d.type === 'log') log(d.msg);
      else if (d.type === 'ready') resolve(w);
      else if (d.type === 'error') { w.terminate(); reject(new Error(d.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(`worker failed: ${e.message || 'script error'}`)); };
    w.postMessage({ type: 'init', backend, videoW: video.videoWidth, videoH: video.videoHeight });
  });

  const grabFrame = async () => {
    try {
      return await createImageBitmap(video, {
        resizeWidth: FRAME_W,
        resizeHeight: FRAME_H,
        resizeQuality: 'low',
      });
    } catch {
      return createImageBitmap(video); // older browsers: no resize options
    }
  };

  const sendFrame = async () => {
    if (!state.running) { if (worker) worker.terminate(); return; }
    try {
      const bitmap = await grabFrame();
      worker.postMessage({ type: 'frame', bitmap }, [bitmap]);
    } catch {
      setTimeout(sendFrame, 100); // camera frame not available yet
    }
  };

  const onHands = (d) => {
    if (d.error) log('worker inference error:', d.error);
    const now = performance.now();
    state.fps = state.fps * 0.9 + (1000 / Math.max(1, now - last)) * 0.1;
    last = now;
    state.hands = d.hands;
    if (d.inferMs > 0) state.inferMs = state.inferMs * 0.9 + d.inferMs * 0.1;
    if (now - lastFpsLog > 30000) {
      lastFpsLog = now;
      log(`pose tracking (worker/${engine}) ~${state.fps.toFixed(0)} fps (inference ${Math.round(state.inferMs)} ms)`);
    }
    if (phase === 'sampling' && d.inferMs > 0) {
      sampleSum += d.inferMs;
      sampleN += 1;
      if (sampleN >= BENCH_FRAMES) evaluateSample();
    }
    sendFrame();
  };

  const attach = (w) => {
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'log') log(d.msg);
      else if (d.type === 'hands') onHands(d);
    };
    w.onerror = (e) => log('worker error:', e.message || 'script error');
  };

  const swapTo = async (backend) => {
    try {
      const w2 = await spawn(backend, true); // model is SW-cached: fast init
      const old = worker;
      old.onmessage = null;
      old.terminate();
      worker = w2;
      engine = backend;
      state.engine = backend;
      attach(w2);
      sampleSum = 0;
      sampleN = 0;
      sendFrame(); // old worker's in-flight frame died with it
      return true;
    } catch (err) {
      log(`could not start ${backend} engine:`, err.message);
      return false;
    }
  };

  const evaluateSample = () => {
    const avg = sampleSum / sampleN;
    results[engine] = avg;
    sampleSum = 0;
    sampleN = 0;
    if (avg <= SLOW_INFER_MS || triedOther) {
      let best = engine;
      for (const [name, ms] of Object.entries(results)) {
        if (ms < results[best]) best = name;
      }
      phase = 'fixed';
      try {
        localStorage.setItem(BACKEND_KEY, JSON.stringify({ engine: best, ms: Math.round(results[best]) }));
      } catch {}
      if (best !== engine) {
        log(`${best} engine wins (${results[best].toFixed(0)} ms vs ${avg.toFixed(0)} ms) — switching`);
        swapTo(best);
      } else {
        log(`${engine} engine confirmed (${avg.toFixed(0)} ms avg inference)`);
      }
    } else {
      triedOther = true;
      const other = engine === 'webgl' ? 'wasm' : 'webgl';
      log(`${engine} inference slow (${avg.toFixed(0)} ms avg) — benchmarking ${other} engine…`);
      swapTo(other).then((ok) => {
        if (!ok) {
          phase = 'fixed'; // stay on what works; do NOT persist — retry next run
          log(`staying on ${engine} (${other} unavailable)`);
        }
      });
    }
  };

  worker = await spawn(engine, false);
  state.engine = engine;
  attach(worker);
  sendFrame();
  log(`pose tracking running in worker thread (${engine}) — renderer unblocked`);
  return state;
}

// onProgress(message, fraction) — fraction is overall init progress in [0, 1]
// (main.js reports the camera stage as 0–0.15 before calling this).
export async function createTracker(video, onProgress = () => {}) {
  const t0 = performance.now();
  const since = () => `${Math.round(performance.now() - t0)} ms`;

  onProgress('Starting GPU backend…', 0.18);
  // Fewer shader variants = much faster first-run compile on mobile GPUs.
  try { tf.env().set('WEBGL_USE_SHAPES_UNIFORMS', true); } catch {}
  // Half-float textures: ~2x faster on mobile GPUs, plenty of precision for
  // pose keypoints.
  try { tf.env().set('WEBGL_FORCE_F16_TEXTURES', true); } catch {}
  // ?backend=cpu overrides (debug / broken-WebGL devices); otherwise try
  // WebGL and fall back to CPU rather than failing outright.
  const forced = new URLSearchParams(location.search).get('backend');
  try {
    await tf.setBackend(forced || 'webgl');
  } catch {
    log('webgl backend failed, falling back to cpu');
    await tf.setBackend('cpu');
  }
  await tf.ready();
  log(`tf backend '${tf.getBackend()}' ready — ${since()}`);
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
      || document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) log('GPU:', gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch { /* diagnostics only */ }

  onProgress('Loading sword-tracking model…', 0.25);
  // Model weights are vendored with the app (no TF Hub / Kaggle fetch —
  // that host is slow or blocked on many networks and used to hang here).
  const detector = await withDownloadProgress(
    (frac, bytes) => onProgress(
      `Loading sword-tracking model… ${(bytes / 1048576).toFixed(1)} MB`,
      0.25 + frac * 0.55,
    ),
    () => poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
        modelUrl: './vendor/movenet/movenet-lightning.json',
      },
    ),
  );
  log(`MoveNet detector created — ${since()}`);

  onProgress('Compiling GPU shaders — first run can take a minute…', 0.88);
  // Shader compilation is the one stage that can block the main thread hard
  // (the screen freezes and the progress bar stops repainting). Two guards:
  // 1. Yield two frames so the 88% state is actually painted before any block.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))));
  // 2. Prefer TF.js's parallel shader compilation (KHR_parallel_shader_compile):
  //    shaders compile on GPU driver threads while we await, so the page stays
  //    responsive. Falls back to the plain blocking warm-up if unsupported.
  if (tf.getBackend() === 'webgl') {
    const backend = tf.backend();
    if (typeof backend.checkCompileCompletionAsync === 'function') {
      // Use a zeros tensor, NOT the video: fromPixels must not run in
      // compile-only mode (it skips the texture upload and poisons the
      // pipeline for subsequent real frames).
      const warmupInput = tf.zeros([video.videoHeight || 480, video.videoWidth || 640, 3], 'int32');
      try {
        tf.env().set('ENGINE_COMPILE_ONLY', true);
        await detector.estimatePoses(warmupInput);
        tf.env().set('ENGINE_COMPILE_ONLY', false);
        // Wait for the driver's parallel (background-thread) compile, but cap
        // it at 20 s — on some drivers this poll never resolves, which froze
        // loading at 88%. IMPORTANT: only this wait may be raced; once
        // compile-only programs exist, getUniformLocations() below is
        // mandatory before any real inference (it also blocks until the
        // driver finishes linking, so it doubles as the synchronous
        // fallback when the async poll times out).
        const done = await Promise.race([
          backend.checkCompileCompletionAsync().then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 20000)),
        ]);
        if (!done) {
          log('parallel compile poll timed out after 20 s — finishing synchronously (screen may pause)');
          onProgress('Compiling GPU shaders (slow path)…', 0.92);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))));
        }
        if (typeof backend.getUniformLocations === 'function') backend.getUniformLocations();
        if (typeof detector.reset === 'function') detector.reset();
        log(`shaders compiled ${done ? 'in parallel (page stayed responsive)' : 'via synchronous fallback'} — ${since()}`);
      } catch (err) {
        try { tf.env().set('ENGINE_COMPILE_ONLY', false); } catch {}
        log('parallel shader compile failed, using blocking warm-up:', err.message);
      } finally {
        warmupInput.dispose();
      }
    } else {
      log('parallel shader compile unsupported, using blocking warm-up');
    }
  }
  await detector.estimatePoses(video);
  log(`first inference done, shaders compiled — ${since()}`);
  onProgress('Ready!', 1);

  // Latest tracked hands, updated by a free-running estimation loop so the
  // render loop never blocks on inference.
  const state = {
    hands: { left: null, right: null },
    fps: 0,
    inferMs: 0,
    engine: `${tf.getBackend()} (main thread)`,
    running: true,
  };

  let last = performance.now();
  let lastFpsLog = performance.now();
  (async function loop() {
    while (state.running) {
      let inferMs = 0;
      try {
        const t = performance.now();
        const poses = await detector.estimatePoses(video);
        inferMs = performance.now() - t;
        state.inferMs = state.inferMs * 0.9 + inferMs * 0.1;
        const now = performance.now();
        state.fps = state.fps * 0.9 + (1000 / Math.max(1, now - last)) * 0.1;
        last = now;
        state.hands = extractHands(poses[0]);
        if (now - lastFpsLog > 30000) {
          lastFpsLog = now;
          log(`pose tracking ~${state.fps.toFixed(0)} fps (inference ${inferMs.toFixed(0)} ms)`);
        }
      } catch (err) {
        // Transient inference hiccup — keep last known hands and retry.
        log('inference hiccup (retrying):', err.message);
        await new Promise((r) => setTimeout(r, 100));
      }
      // CRITICAL: yield a real display frame between inferences. Awaits that
      // resolve as microtasks never give the browser a chance to paint, so
      // without this the loop starves rendering — JS keeps running (console
      // logs flow, the game "starts") but the screen stays frozen on the
      // last painted frame (the 88% loading panel).
      await tf.nextFrame();
      // Adaptive throttle: inference shares the main thread with the game
      // renderer, so give rendering breathing room proportional to how
      // expensive inference is on this device. Fast GPU → no idle, pose runs
      // at full rate; slow GPU → pose rate drops so gameplay stays smooth.
      const idle = Math.min(90, inferMs * 0.9);
      if (idle > 8) await new Promise((r) => setTimeout(r, idle));
    }
  })();

  return state;
}

function extractHands(pose) {
  if (!pose) return { left: null, right: null };
  const kp = {};
  for (const k of pose.keypoints) kp[k.name] = k;

  // Note: MoveNet labels are anatomical (person's left arm). Because the
  // display is mirrored, the person's right hand appears on the right side
  // of the screen — the game doesn't care which is which, it just needs
  // both forearms.
  return {
    left: makeHand(kp.left_elbow, kp.left_wrist),
    right: makeHand(kp.right_elbow, kp.right_wrist),
  };
}

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

// Map a point from (unmirrored) video coordinates to mirrored,
// cover-fitted canvas coordinates.
export function makeMapper(videoW, videoH, canvasW, canvasH) {
  const s = Math.max(canvasW / videoW, canvasH / videoH);
  const ox = (canvasW - videoW * s) / 2;
  const oy = (canvasH - videoH * s) / 2;
  return {
    scale: s,
    offsetX: ox,
    offsetY: oy,
    point(p) {
      return { x: canvasW - (p.x * s + ox), y: p.y * s + oy };
    },
  };
}
