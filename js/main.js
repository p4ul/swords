// Boot / app state machine: menu → loading → playing → game over.

import { openCamera, createTracker, createWorkerTracker, workerTrackingSupported, makeMapper } from './pose.js';
import { Game } from './game.js';
import * as sfx from './audio.js';

const video = document.getElementById('cam');
const canvas = document.getElementById('game');
const $ = (id) => document.getElementById(id);
const panels = { menu: $('menu'), loading: $('loading'), gameover: $('gameover'), error: $('error') };

function showPanel(name) {
  for (const [k, el] of Object.entries(panels)) el.classList.toggle('hidden', k !== name);
  if (!name) for (const el of Object.values(panels)) el.classList.add('hidden');
}

const BUILD = 'v8';

const log = (...args) => console.log('[SwordStorm]', ...args);
log(`build ${BUILD}`);
const buildTag = document.getElementById('buildTag');
if (buildTag) buildTag.textContent = `build ${BUILD}`;

// Loading-screen progress: message + overall fraction, mirrored to console.
let lastProgressAt = Date.now();
function setProgress(msg, frac) {
  lastProgressAt = Date.now();
  if (msg) $('loadMsg').textContent = msg;
  if (frac != null) {
    const pct = Math.round(frac * 100);
    $('loadBar').style.width = `${pct}%`;
    $('loadPct').textContent = `${pct}%`;
  }
  if (msg) log(frac != null ? `${msg} (${Math.round(frac * 100)}%)` : msg);
}

// Watchdog that fires only when initialization STALLS (no progress event for
// 60 s) — a slow device that is still making progress never times out.
let watchdogTimer = null;
function stallWatchdog() {
  lastProgressAt = Date.now();
  return new Promise((_, reject) => {
    watchdogTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > 60000) {
        clearInterval(watchdogTimer);
        reject(new Error('Loading stalled (no progress for 60 s). Close this tab fully and reopen the page. If it keeps happening, your browser may lack WebGL acceleration — try ?backend=cpu.'));
      }
    }, 5000);
  });
}
function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

function resize() {
  // Cap the backing store to a fixed pixel budget — canvas fill rate is a
  // primary cost on tablets and full devicePixelRatio buys little here.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const MAX_PIXELS = 1300000;
  const area = window.innerWidth * window.innerHeight * dpr * dpr;
  const scale = area > MAX_PIXELS ? dpr * Math.sqrt(MAX_PIXELS / area) : dpr;
  canvas.width = Math.round(window.innerWidth * scale);
  canvas.height = Math.round(window.innerHeight * scale);
  canvas.style.width = '100%';
  canvas.style.height = '100%';
}
window.addEventListener('resize', resize);
resize();

const BEST_KEY = 'swordstorm_best';
const best = () => Number(localStorage.getItem(BEST_KEY) || 0);
if (best() > 0) $('bestLine').textContent = `Best score: ${best()}`;

let tracker = null;
let game = null;
let running = false;
let wakeLock = null;

async function requestFullscreenAndWakeLock() {
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch {}
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && running && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
});

// Debug mode (?mock=1): no camera or model — swords are driven by synthetic
// swinging arms. Useful for developing gameplay on a machine without a camera.
const MOCK = new URLSearchParams(location.search).has('mock');

function createMockTracker() {
  const t0 = performance.now();
  return {
    fps: 60,
    get hands() {
      const t = (performance.now() - t0) / 1000;
      return {
        left: {
          elbow: { x: 430, y: 330 },
          wrist: { x: 430 + Math.cos(t * 5.1) * 90, y: 260 + Math.sin(t * 5.1) * 140 },
          score: 1,
        },
        right: {
          elbow: { x: 210, y: 330 },
          wrist: { x: 210 - Math.cos(t * 4.3) * 90, y: 260 + Math.sin(t * 4.3 + 1.7) * 140 },
          score: 1,
        },
      };
    },
  };
}

// One shared init attempt: double-taps on START and retries after a watchdog
// error re-attach to the SAME in-flight initialization instead of spawning a
// second detector that contends with the first (that produced "pose tracking"
// console logs from an orphaned init while the visible one appeared stuck).
let initPromise = null;
function ensureTracker() {
  if (!initPromise) {
    initPromise = (async () => {
      setProgress('Requesting camera…', 0.03);
      await openCamera(video);
      setProgress('Camera ready', 0.15);
      // Prefer the worker tracker (inference off the main thread); ?noworker
      // forces the in-thread path for debugging.
      const noWorker = new URLSearchParams(location.search).has('noworker');
      if (!noWorker && workerTrackingSupported()) {
        try {
          return await createWorkerTracker(video, setProgress);
        } catch (err) {
          log('worker tracker failed, falling back to main thread:', err.message);
        }
      }
      return createTracker(video, setProgress);
    })().catch((err) => {
      initPromise = null; // real failure — allow a fresh attempt on retry
      throw err;
    });
  }
  return initPromise;
}

let starting = false;

async function start() {
  if (starting || running) return; // ignore double-taps
  starting = true;
  sfx.unlockAudio();
  showPanel('loading');
  setProgress('Starting…', 0);
  await requestFullscreenAndWakeLock();

  try {
    if (!tracker) {
      if (MOCK) {
        log('mock mode — synthetic arms, no camera or model');
        tracker = createMockTracker();
      } else {
        tracker = await Promise.race([ensureTracker(), stallWatchdog()]);
      }
    }
  } catch (err) {
    console.error('[SwordStorm] init failed:', err);
    $('errMsg').textContent = err.name === 'NotAllowedError'
      ? 'Camera access was denied. The game needs the front camera to track your sword arms — allow camera access and reload.'
      : err.message.includes('stalled')
        ? err.message
        : `Could not start: ${err.message}. The page must be served over HTTPS (or localhost) for camera access.`;
    showPanel('error');
    return;
  } finally {
    starting = false;
    stopWatchdog();
  }

  showPanel(null);
  log('fight! game started');
  game = new Game(canvas);
  running = true;
  requestAnimationFrame(frame);
}

let lastT = 0;
let renderFps = 0;
let lastFpsLog = 0;
function frame(t) {
  if (!running) return;
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
  lastT = t;
  renderFps = renderFps * 0.92 + (1 / Math.max(0.001, dt)) * 0.08;
  if (t - lastFpsLog > 30000) {
    lastFpsLog = t;
    log(`render ~${renderFps.toFixed(0)} fps, pose ~${(tracker.fps || 0).toFixed(0)} fps`);
  }

  const mapper = makeMapper(
    video.videoWidth || 640, video.videoHeight || 480,
    canvas.width, canvas.height,
  );

  game.stats.render = renderFps;
  game.stats.pose = tracker.fps || 0;
  game.update(dt, tracker.hands, mapper);
  game.render(video, mapper);

  if (game.over) {
    running = false;
    finishGame();
    return;
  }
  requestAnimationFrame(frame);
}

function finishGame() {
  log(`game over — score ${game.score}, wave ${game.wave}, ${game.kills} kills`);
  const isBest = game.score > best();
  if (isBest) localStorage.setItem(BEST_KEY, String(game.score));
  $('finalScore').textContent = `${game.score} pts${isBest ? ' — NEW BEST! 🏆' : ''}`;
  $('finalStats').textContent = `Wave ${game.wave} · ${game.kills} demons slain`;
  showPanel('gameover');
}

$('startBtn').addEventListener('click', start);
$('retryBtn').addEventListener('click', start);
$('reloadBtn').addEventListener('click', () => location.reload());
