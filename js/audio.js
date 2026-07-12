// All sound effects are synthesized with WebAudio — no audio assets needed.

let ctx = null;

export function unlockAudio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
}

function now() { return ctx ? ctx.currentTime : 0; }

function env(gainNode, t0, peak, attack, decay) {
  const g = gainNode.gain;
  g.setValueAtTime(0.0001, t0);
  g.exponentialRampToValueAtTime(peak, t0 + attack);
  g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function noiseBuffer() {
  const len = ctx.sampleRate * 0.5;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

let cachedNoise = null;

export function whoosh() {
  if (!ctx) return;
  const t0 = now();
  cachedNoise = cachedNoise || noiseBuffer();
  const src = ctx.createBufferSource();
  src.buffer = cachedNoise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(400, t0);
  filter.frequency.exponentialRampToValueAtTime(2400, t0 + 0.12);
  filter.Q.value = 1.2;
  const gain = ctx.createGain();
  env(gain, t0, 0.25, 0.02, 0.16);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(t0);
  src.stop(t0 + 0.25);
}

export function hit(combo = 1) {
  if (!ctx) return;
  const t0 = now();
  // Metallic clang: two detuned triangles + a noise burst.
  const base = 520 + Math.min(combo, 10) * 40;
  for (const mult of [1, 1.5]) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(base * mult, t0);
    osc.frequency.exponentialRampToValueAtTime(base * mult * 0.7, t0 + 0.18);
    const gain = ctx.createGain();
    env(gain, t0, 0.22, 0.005, 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.25);
  }
  cachedNoise = cachedNoise || noiseBuffer();
  const src = ctx.createBufferSource();
  src.buffer = cachedNoise;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 3000;
  const gain = ctx.createGain();
  env(gain, t0, 0.15, 0.002, 0.08);
  src.connect(hp).connect(gain).connect(ctx.destination);
  src.start(t0);
  src.stop(t0 + 0.1);
}

export function hurt() {
  if (!ctx) return;
  const t0 = now();
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(160, t0);
  osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.35);
  const gain = ctx.createGain();
  env(gain, t0, 0.35, 0.01, 0.35);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.4);
}

export function waveUp() {
  if (!ctx) return;
  const t0 = now();
  [440, 554, 659, 880].forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const gain = ctx.createGain();
    env(gain, t0 + i * 0.09, 0.18, 0.01, 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + i * 0.09);
    osc.stop(t0 + i * 0.09 + 0.35);
  });
}

export function gameOver() {
  if (!ctx) return;
  const t0 = now();
  [392, 311, 233, 155].forEach((f, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = f;
    const gain = ctx.createGain();
    env(gain, t0 + i * 0.22, 0.12, 0.02, 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + i * 0.22);
    osc.stop(t0 + i * 0.22 + 0.45);
  });
}
