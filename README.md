# ⚔️ Sword Storm

A motion-controlled sword-fighting game for Android tablets (and any device
with a front camera). The camera tracks your body in real time — **your
forearms become glowing swords** — and you physically slash flying demons
out of the air before they reach you.

No controller, no install, no app store: it runs fullscreen in the browser.

## How it works

- **Player tracking** uses [MoveNet](https://www.tensorflow.org/hub/tutorials/movenet)
  (SinglePose Lightning) via TensorFlow.js — a YOLO-class real-time human
  keypoint detector that runs on the tablet's GPU through WebGL at 30–50 fps.
  All inference happens **on-device**; no camera frames ever leave the tablet.
- Each detected **elbow → wrist** segment is extended into a blade. Swing
  your arm fast enough and the blade goes *hot* (it glows white and whooshes) —
  only a hot blade cuts. Collision uses the blade's swept area between frames,
  so fast slashes never tunnel through enemies.
- Enemies fly toward the screen from a distance (they grow as they approach).
  Slash them before they reach you or you lose a heart.

## Gameplay

| | |
|---|---|
| 🗡️ **Slash** | Swing either arm fast through an enemy |
| 👿 **Imps** (purple) | 1 hit, steady approach |
| 💨 **Wisps** (green) | 1 hit, fast and zig-zaggy |
| 👹 **Brutes** (red) | 3 hits, slow but deal 2 damage |
| 🔥 **Combos** | Chain kills within 1.6 s for multiplied score |
| 🌊 **Waves** | Clear the kill quota to advance; +1 heart per wave |
| ❤️ **5 hearts** | An enemy reaching the screen costs you 1–2 |

## Running it

Camera access requires a **secure context** (HTTPS or `localhost`).

### Easiest: GitHub Pages

1. Repo → **Settings → Pages → Deploy from branch**, pick this branch, root folder.
2. Open the published URL in **Chrome on the tablet**.
3. Tap **START**, allow camera access.
4. Optional: Chrome menu → *Add to Home screen* for a fullscreen app icon.

### Local network (dev)

```bash
npx serve .        # then open https://<your-ip>:3000 …
```

…but plain HTTP from another device won't get camera access. For quick LAN
testing use a tunneling tool that gives you HTTPS, e.g.:

```bash
npx serve . &
npx localtunnel --port 3000
```

Or on the tablet itself, `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
can whitelist your dev machine's origin (dev only).

## Playing tips

- Prop the tablet up in **landscape** at roughly chest height.
- Stand **1.5–2 m back** so the camera sees your head, arms, and torso.
- Good, even lighting helps tracking a lot; avoid strong backlight.
- Big, committed swings register better than small wrist flicks — which is
  the fun part anyway.

## Tech notes

- Plain ES modules, zero build step. TensorFlow.js and the pose-detection
  library are vendored in `vendor/` (no CDN dependency); only the MoveNet
  model weights are fetched from TF Hub on first run. A service worker
  caches everything after the first visit so subsequent loads are fast.
- **Debug mode:** append `?mock=1` to the URL to play without a camera —
  the swords are driven by synthetic swinging arms. Handy for tuning
  gameplay on a laptop.
- `js/pose.js` — camera setup, MoveNet inference loop, video→screen
  coordinate mapping (mirrored, cover-fit).
- `js/game.js` — swords, swept-blade collision, enemy AI/waves, particles,
  canvas rendering, HUD.
- `js/audio.js` — all SFX synthesized with WebAudio (whoosh, clang, hurt,
  wave fanfare); no audio files.
- `js/main.js` — state machine (menu → loading → playing → game over),
  fullscreen + screen wake lock, best-score persistence.
