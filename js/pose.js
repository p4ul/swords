// Camera + MoveNet pose tracking.
// MoveNet (SinglePose Lightning) is a real-time human keypoint detector in the
// same family as YOLO-pose — it runs ~30-50 fps on a tablet GPU via WebGL.
// We only care about elbows + wrists: each forearm becomes a sword.

const MIN_SCORE = 0.3;

export async function openCamera(video) {
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
  return stream;
}

export async function createTracker(video, onStatus = () => {}) {
  onStatus('Warming up GPU…');
  // ?backend=cpu overrides (debug / broken-WebGL devices); otherwise try
  // WebGL and fall back to CPU rather than failing outright.
  const forced = new URLSearchParams(location.search).get('backend');
  try {
    await tf.setBackend(forced || 'webgl');
  } catch {
    await tf.setBackend('cpu');
  }
  await tf.ready();

  onStatus('Loading pose model…');
  // Model weights are vendored with the app (no TF Hub / Kaggle fetch —
  // that host is slow or blocked on many networks and used to hang here).
  const detector = await poseDetection.createDetector(
    poseDetection.SupportedModels.MoveNet,
    {
      modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
      modelUrl: './vendor/movenet/movenet-lightning.json',
    },
  );

  onStatus('First inference (compiling shaders)…');
  await detector.estimatePoses(video);

  // Latest tracked hands, updated by a free-running estimation loop so the
  // render loop never blocks on inference.
  const state = {
    hands: { left: null, right: null },
    fps: 0,
    running: true,
  };

  let last = performance.now();
  (async function loop() {
    while (state.running) {
      try {
        const poses = await detector.estimatePoses(video);
        const now = performance.now();
        state.fps = state.fps * 0.9 + (1000 / Math.max(1, now - last)) * 0.1;
        last = now;
        state.hands = extractHands(poses[0]);
      } catch {
        // Transient inference hiccup — keep last known hands and retry.
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
