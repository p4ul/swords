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
      width: { ideal: 640 },
      height: { ideal: 480 },
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

// onProgress(message, fraction) — fraction is overall init progress in [0, 1]
// (main.js reports the camera stage as 0–0.15 before calling this).
export async function createTracker(video, onProgress = () => {}) {
  const t0 = performance.now();
  const since = () => `${Math.round(performance.now() - t0)} ms`;

  onProgress('Starting GPU backend…', 0.18);
  // Fewer shader variants = much faster first-run compile on mobile GPUs.
  try { tf.env().set('WEBGL_USE_SHAPES_UNIFORMS', true); } catch {}
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
    let warmupInput = null;
    try {
      const backend = tf.backend();
      if (typeof backend.checkCompileCompletionAsync === 'function') {
        // Use a zeros tensor, NOT the video: fromPixels must not run in
        // compile-only mode (it skips the texture upload and poisons the
        // pipeline for subsequent real frames).
        warmupInput = tf.zeros([video.videoHeight || 480, video.videoWidth || 640, 3], 'int32');
        tf.env().set('ENGINE_COMPILE_ONLY', true);
        await detector.estimatePoses(warmupInput);
        tf.env().set('ENGINE_COMPILE_ONLY', false);
        // Documented sequence: wait for the driver's parallel compile, then
        // cache uniform locations — without this the compiled programs are
        // unusable (null uniform arrays on the first real inference).
        await backend.checkCompileCompletionAsync();
        if (typeof backend.getUniformLocations === 'function') backend.getUniformLocations();
        if (typeof detector.reset === 'function') detector.reset();
        log(`shaders compiled in parallel (page stayed responsive) — ${since()}`);
      }
    } catch (err) {
      try { tf.env().set('ENGINE_COMPILE_ONLY', false); } catch {}
      log('parallel shader compile unavailable, using blocking warm-up:', err.message);
    } finally {
      if (warmupInput) warmupInput.dispose();
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
    running: true,
  };

  let last = performance.now();
  let lastFpsLog = performance.now();
  (async function loop() {
    while (state.running) {
      try {
        const poses = await detector.estimatePoses(video);
        const now = performance.now();
        state.fps = state.fps * 0.9 + (1000 / Math.max(1, now - last)) * 0.1;
        last = now;
        state.hands = extractHands(poses[0]);
        if (now - lastFpsLog > 30000) {
          lastFpsLog = now;
          log(`pose tracking ~${state.fps.toFixed(0)} fps`);
        }
      } catch (err) {
        // Transient inference hiccup — keep last known hands and retry.
        log('inference hiccup (retrying):', err.message);
        await new Promise((r) => setTimeout(r, 100));
      }
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
