// Boot / app state machine: menu → loading → playing → game over.

import { openCamera, createTracker, makeMapper } from './pose.js';
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

function resize() {
  canvas.width = window.innerWidth * (window.devicePixelRatio > 1.5 ? 1.5 : window.devicePixelRatio);
  canvas.height = window.innerHeight * (window.devicePixelRatio > 1.5 ? 1.5 : window.devicePixelRatio);
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

async function start() {
  sfx.unlockAudio();
  showPanel('loading');
  await requestFullscreenAndWakeLock();

  try {
    if (!tracker) {
      if (MOCK) {
        tracker = createMockTracker();
      } else {
        $('loadMsg').textContent = 'Requesting camera…';
        await openCamera(video);
        // Watchdog: initialization should take a few seconds at most now
        // that the model ships with the app — never hang the loading screen.
        tracker = await Promise.race([
          createTracker(video, (msg) => { $('loadMsg').textContent = msg; }),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('Initialization timed out. Close this tab fully and reopen the page — a stale cached version may be loaded.')),
            45000,
          )),
        ]);
      }
    }
  } catch (err) {
    console.error(err);
    $('errMsg').textContent = err.name === 'NotAllowedError'
      ? 'Camera access was denied. The game needs the front camera to track your sword arms — allow camera access and reload.'
      : `Could not start: ${err.message}. The page must be served over HTTPS (or localhost) for camera access.`;
    showPanel('error');
    return;
  }

  showPanel(null);
  game = new Game(canvas);
  running = true;
  requestAnimationFrame(frame);
}

let lastT = 0;
function frame(t) {
  if (!running) return;
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
  lastT = t;

  const mapper = makeMapper(
    video.videoWidth || 640, video.videoHeight || 480,
    canvas.width, canvas.height,
  );

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
  const isBest = game.score > best();
  if (isBest) localStorage.setItem(BEST_KEY, String(game.score));
  $('finalScore').textContent = `${game.score} pts${isBest ? ' — NEW BEST! 🏆' : ''}`;
  $('finalStats').textContent = `Wave ${game.wave} · ${game.kills} demons slain`;
  showPanel('gameover');
}

$('startBtn').addEventListener('click', start);
$('retryBtn').addEventListener('click', start);
$('reloadBtn').addEventListener('click', () => location.reload());
