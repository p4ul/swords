// Core game: swords driven by tracked forearms, enemies flying toward the
// screen, swept-blade collision, particles, HUD.

import * as sfx from './audio.js';

// ---------------------------------------------------------------- helpers

function lerp(a, b, t) { return a + (b - a) * t; }
function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
function rand(a, b) { return a + Math.random() * (b - a); }

// Distance from point to segment.
function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(px, py, ax, ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, ax + dx * t, ay + dy * t);
}

// ---------------------------------------------------------------- sword

const SMOOTH = 0.45;          // position smoothing factor per frame
const BLADE_SCALE = 1.9;      // blade length relative to forearm length
const TRAIL_LIFE = 0.22;      // seconds a trail segment lives

class Sword {
  constructor(color) {
    this.color = color;
    this.visible = false;
    this.hot = false;         // fast enough to cut
    this.base = null;         // wrist (canvas coords)
    this.tip = null;
    this.prevBase = null;
    this.prevTip = null;
    this.tipSpeed = 0;
    this.trail = [];
    this.wasHot = false;
  }

  update(hand, mapper, dt, diag) {
    this.prevBase = this.base ? { ...this.base } : null;
    this.prevTip = this.tip ? { ...this.tip } : null;

    if (!hand) {
      this.visible = false;
      this.hot = false;
      this.fadeTrail(dt);
      return;
    }

    const wrist = mapper.point(hand.wrist);
    const elbow = mapper.point(hand.elbow);

    if (this.base && this.visible) {
      wrist.x = lerp(this.base.x, wrist.x, SMOOTH + 0.35);
      wrist.y = lerp(this.base.y, wrist.y, SMOOTH + 0.35);
    }

    const fx = wrist.x - elbow.x;
    const fy = wrist.y - elbow.y;
    const flen = Math.max(20, Math.hypot(fx, fy));
    const bladeLen = Math.min(flen * BLADE_SCALE, diag * 0.32);
    const tip = {
      x: wrist.x + (fx / flen) * bladeLen,
      y: wrist.y + (fy / flen) * bladeLen,
    };

    if (this.tip && this.visible) {
      tip.x = lerp(this.tip.x, tip.x, SMOOTH + 0.35);
      tip.y = lerp(this.tip.y, tip.y, SMOOTH + 0.35);
    }

    this.tipSpeed = this.tip && this.visible && dt > 0
      ? dist(tip.x, tip.y, this.tip.x, this.tip.y) / dt
      : 0;

    this.base = wrist;
    this.tip = tip;
    this.visible = true;

    // "Hot" when the tip sweeps faster than ~0.9 screen-diagonals per second.
    const wasHot = this.hot;
    this.hot = this.tipSpeed > diag * 0.9;
    if (this.hot && !wasHot) sfx.whoosh();

    this.trail.push({ base: { ...wrist }, tip: { ...tip }, age: 0, hot: this.hot });
    this.fadeTrail(dt);
  }

  fadeTrail(dt) {
    for (const t of this.trail) t.age += dt;
    this.trail = this.trail.filter((t) => t.age < TRAIL_LIFE);
  }

  // Does this frame's blade sweep pass within `radius` of (x, y)?
  sweepHits(x, y, radius) {
    if (!this.hot || !this.visible || !this.prevBase || !this.prevTip) return false;
    const STEPS = 5;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const ax = lerp(this.prevBase.x, this.base.x, t);
      const ay = lerp(this.prevBase.y, this.base.y, t);
      const bx = lerp(this.prevTip.x, this.tip.x, t);
      const by = lerp(this.prevTip.y, this.tip.y, t);
      if (pointSegDist(x, y, ax, ay, bx, by) < radius) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------- enemies

const ENEMY_TYPES = {
  imp:   { hp: 1, dmg: 1, zSpeed: 0.115, maxR: 0.085, score: 10, hue: 275, wobble: 0.6 },
  wisp:  { hp: 1, dmg: 1, zSpeed: 0.17,  maxR: 0.06,  score: 15, hue: 165, wobble: 2.2 },
  brute: { hp: 3, dmg: 2, zSpeed: 0.075, maxR: 0.13,  score: 30, hue: 5,   wobble: 0.3 },
};

const HITTABLE_Z = 0.82;   // enemy must be at least this close to be slashable

class Enemy {
  constructor(type, w, h, difficulty) {
    this.type = type;
    const spec = ENEMY_TYPES[type];
    this.hp = spec.hp;
    this.spec = spec;
    this.z = 1;                                   // 1 = far, 0 = at the screen
    this.zSpeed = spec.zSpeed * difficulty;
    // Drift from a spawn point near an edge toward a target in the middle band.
    const edge = Math.floor(Math.random() * 4);
    this.x = edge === 0 ? -0.1 * w : edge === 1 ? 1.1 * w : rand(0.1, 0.9) * w;
    this.y = edge === 2 ? -0.1 * h : edge === 3 ? 0.9 * h : rand(0.1, 0.7) * h;
    this.tx = rand(0.2, 0.8) * w;
    this.ty = rand(0.2, 0.65) * h;
    this.phase = rand(0, Math.PI * 2);
    this.invuln = 0;
    this.hitFlash = 0;
    this.dead = false;
    this.attacked = false;
  }

  radius(diag) {
    return lerp(diag * 0.012, diag * this.spec.maxR, 1 - this.z);
  }

  update(dt, w, h) {
    this.z -= this.zSpeed * dt;
    this.phase += dt * this.spec.wobble * 3;
    const pull = 1 - Math.pow(0.25, dt);
    this.x = lerp(this.x, this.tx + Math.sin(this.phase) * w * 0.04 * this.spec.wobble, pull);
    this.y = lerp(this.y, this.ty + Math.cos(this.phase * 1.3) * h * 0.03 * this.spec.wobble, pull);
    if (this.invuln > 0) this.invuln -= dt;
    if (this.hitFlash > 0) this.hitFlash -= dt * 5;
    if (this.z <= 0) this.attacked = true;        // reached the player
  }
}

// ---------------------------------------------------------------- game

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.swords = [new Sword('#7df9ff'), new Sword('#ffb84d')];
    this.reset();
  }

  reset() {
    this.enemies = [];
    this.particles = [];
    this.score = 0;
    this.kills = 0;
    this.hp = 5;
    this.maxHp = 5;
    this.wave = 1;
    this.waveKills = 0;
    this.waveBannerT = 2;
    this.combo = 0;
    this.comboT = 0;
    this.spawnT = 1.2;
    this.hurtFlash = 0;
    this.shake = 0;
    this.over = false;
    this.time = 0;
  }

  get difficulty() { return 1 + (this.wave - 1) * 0.18; }
  get spawnInterval() { return Math.max(0.45, 2.0 - (this.wave - 1) * 0.18); }
  get waveTarget() { return 6 + this.wave * 2; }

  spawnEnemy() {
    const w = this.canvas.width, h = this.canvas.height;
    const r = Math.random();
    let type = 'imp';
    if (this.wave >= 2 && r < 0.12 + this.wave * 0.02) type = 'brute';
    else if (this.wave >= 2 && r < 0.35 + this.wave * 0.03) type = 'wisp';
    this.enemies.push(new Enemy(type, w, h, this.difficulty));
  }

  update(dt, hands, mapper) {
    if (this.over) return;
    this.time += dt;
    const w = this.canvas.width, h = this.canvas.height;
    const diag = Math.hypot(w, h);

    this.swords[0].update(hands.left, mapper, dt, diag);
    this.swords[1].update(hands.right, mapper, dt, diag);

    // Spawning
    this.spawnT -= dt;
    if (this.spawnT <= 0) {
      this.spawnEnemy();
      this.spawnT = this.spawnInterval * rand(0.7, 1.3);
    }

    // Combo timer
    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.combo = 0;
    }

    // Enemies
    for (const e of this.enemies) {
      e.update(dt, w, h);

      if (e.attacked) {
        this.hp -= e.spec.dmg;
        this.hurtFlash = 1;
        this.shake = 14;
        sfx.hurt();
        e.dead = true;
        if (this.hp <= 0) this.endGame();
        continue;
      }

      if (e.z < HITTABLE_Z && e.invuln <= 0) {
        const r = e.radius(diag) * 1.15;
        for (const sword of this.swords) {
          if (sword.sweepHits(e.x, e.y, r)) {
            e.hp -= 1;
            e.invuln = 0.25;
            e.hitFlash = 1;
            this.spawnSparks(e, sword, diag);
            if (e.hp <= 0) {
              e.dead = true;
              this.combo += 1;
              this.comboT = 1.6;
              this.score += e.spec.score * this.combo;
              this.kills += 1;
              this.waveKills += 1;
              sfx.hit(this.combo);
            } else {
              sfx.hit(0);
            }
            break;
          }
        }
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);

    // Wave progression
    if (this.waveKills >= this.waveTarget) {
      this.wave += 1;
      this.waveKills = 0;
      this.waveBannerT = 2.2;
      this.hp = Math.min(this.maxHp, this.hp + 1);   // small heal each wave
      sfx.waveUp();
    }
    if (this.waveBannerT > 0) this.waveBannerT -= dt;
    if (this.hurtFlash > 0) this.hurtFlash -= dt * 2.5;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 60);

    // Particles
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 900 * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  spawnSparks(enemy, sword, diag) {
    const dx = sword.tip.x - (sword.prevTip ? sword.prevTip.x : sword.tip.x);
    const dy = sword.tip.y - (sword.prevTip ? sword.prevTip.y : sword.tip.y);
    const mag = Math.max(1, Math.hypot(dx, dy));
    for (let i = 0; i < 16; i++) {
      const spread = rand(-1.2, 1.2);
      const speed = rand(0.2, 0.9) * diag * 0.7;
      const angle = Math.atan2(dy, dx) + spread;
      this.particles.push({
        x: enemy.x, y: enemy.y,
        vx: Math.cos(angle) * speed + (dx / mag) * 200,
        vy: Math.sin(angle) * speed + (dy / mag) * 200,
        life: rand(0.25, 0.6),
        maxLife: 0.6,
        hue: enemy.spec.hue,
        size: rand(2, 6),
      });
    }
  }

  endGame() {
    this.over = true;
    sfx.gameOver();
  }

  // -------------------------------------------------------------- render

  render(video, mapper) {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    const diag = Math.hypot(w, h);

    ctx.save();
    if (this.shake > 0) {
      ctx.translate(rand(-this.shake, this.shake), rand(-this.shake, this.shake));
    }

    // Mirrored camera feed, cover-fitted (solid backdrop in mock mode).
    if (video.videoWidth > 0) {
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(
        video,
        mapper.offsetX, mapper.offsetY,
        video.videoWidth * mapper.scale, video.videoHeight * mapper.scale,
      );
      ctx.restore();
      // Dark arena tint so game elements pop.
      ctx.fillStyle = 'rgba(15, 5, 35, 0.45)';
    } else {
      ctx.fillStyle = '#160a2e';
    }
    ctx.fillRect(-40, -40, w + 80, h + 80);

    // Enemies far-to-near so close ones draw on top.
    const sorted = [...this.enemies].sort((a, b) => b.z - a.z);
    for (const e of sorted) this.drawEnemy(e, diag);

    this.drawParticles();
    for (const sword of this.swords) this.drawSword(sword);
    ctx.restore();

    if (this.hurtFlash > 0) {
      ctx.fillStyle = `rgba(255, 30, 30, ${this.hurtFlash * 0.35})`;
      ctx.fillRect(0, 0, w, h);
    }

    this.drawHUD(w, h);
  }

  drawEnemy(e, diag) {
    const { ctx } = this;
    const r = e.radius(diag);
    const depth = 1 - e.z;
    const alpha = Math.min(1, depth * 3);
    const hue = e.hitFlash > 0 ? 55 : e.spec.hue;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(e.x, e.y);

    // Aura
    const glow = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 1.8);
    glow.addColorStop(0, `hsla(${hue}, 95%, 65%, 0.55)`);
    glow.addColorStop(1, `hsla(${hue}, 95%, 65%, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Body
    const body = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
    body.addColorStop(0, `hsl(${hue}, 85%, ${e.hitFlash > 0 ? 85 : 62}%)`);
    body.addColorStop(1, `hsl(${hue}, 80%, 28%)`);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // Horns
    ctx.fillStyle = `hsl(${hue}, 60%, 20%)`;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * r * 0.45, -r * 0.75);
      ctx.quadraticCurveTo(s * r * 0.85, -r * 1.5, s * r * 0.35, -r * 1.25);
      ctx.quadraticCurveTo(s * r * 0.4, -r * 1.0, s * r * 0.15, -r * 0.9);
      ctx.fill();
    }

    // Eyes — angrier as they get closer.
    const squint = depth * r * 0.12;
    ctx.fillStyle = '#fff';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * r * 0.35, -r * 0.15, r * 0.22, r * 0.28 - squint, s * depth * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#1a0322';
    const lookX = Math.sin(e.phase * 0.7) * r * 0.06;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * r * 0.35 + lookX, -r * 0.12, r * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // Angry mouth (inverted arc = frown)
    ctx.strokeStyle = '#1a0322';
    ctx.lineWidth = Math.max(1.5, r * 0.08);
    ctx.beginPath();
    ctx.arc(0, r * 0.62, r * 0.3, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();

    // HP pips for multi-hit enemies.
    if (e.spec.hp > 1) {
      for (let i = 0; i < e.spec.hp; i++) {
        ctx.fillStyle = i < e.hp ? '#ffd76e' : 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.arc((i - (e.spec.hp - 1) / 2) * r * 0.35, -r * 1.45, r * 0.09, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Proximity warning ring when about to strike.
    if (e.z < 0.22) {
      ctx.strokeStyle = `rgba(255, 60, 60, ${0.4 + 0.6 * Math.abs(Math.sin(this.time * 12))})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  drawSword(sword) {
    const { ctx } = this;
    if (!sword.visible && sword.trail.length === 0) return;

    // Trail ribbon
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const seg of sword.trail) {
      const a = Math.max(0, 1 - seg.age / TRAIL_LIFE) * (seg.hot ? 0.5 : 0.12);
      ctx.strokeStyle = seg.hot
        ? `rgba(255, 240, 200, ${a})`
        : hexWithAlpha(sword.color, a);
      ctx.lineWidth = seg.hot ? 10 : 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(seg.base.x, seg.base.y);
      ctx.lineTo(seg.tip.x, seg.tip.y);
      ctx.stroke();
    }
    ctx.restore();

    if (!sword.visible) return;
    const { base, tip } = sword;

    // Blade glow
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hexWithAlpha(sword.color, sword.hot ? 0.9 : 0.45);
    ctx.lineWidth = sword.hot ? 16 : 10;
    ctx.lineCap = 'round';
    ctx.shadowColor = sword.color;
    ctx.shadowBlur = sword.hot ? 30 : 12;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();

    // Bright core
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = sword.hot ? 5 : 3;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.restore();

    // Hilt at the wrist
    ctx.save();
    ctx.fillStyle = sword.color;
    ctx.beginPath();
    ctx.arc(base.x, base.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  drawParticles() {
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      const a = p.life / p.maxLife;
      ctx.fillStyle = `hsla(${p.hue}, 95%, 70%, ${a})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawHUD(w, h) {
    const { ctx } = this;
    const pad = Math.max(16, w * 0.02);

    // Hearts
    const heartSize = Math.max(20, w * 0.022);
    for (let i = 0; i < this.maxHp; i++) {
      ctx.font = `${heartSize}px serif`;
      ctx.textBaseline = 'top';
      ctx.globalAlpha = i < this.hp ? 1 : 0.25;
      ctx.fillText(i < this.hp ? '❤️' : '🖤', pad + i * (heartSize + 8), pad);
    }
    ctx.globalAlpha = 1;

    // Score + wave
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd76e';
    ctx.font = `700 ${Math.max(22, w * 0.026)}px 'Segoe UI', sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 6;
    ctx.fillText(String(this.score).padStart(6, '0'), w - pad, pad);
    ctx.fillStyle = '#c9b8ee';
    ctx.font = `600 ${Math.max(14, w * 0.015)}px 'Segoe UI', sans-serif`;
    ctx.fillText(`WAVE ${this.wave} · ${this.waveKills}/${this.waveTarget}`, w - pad, pad + Math.max(28, w * 0.032));
    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';

    // Combo
    if (this.combo > 1 && this.comboT > 0) {
      ctx.save();
      ctx.textAlign = 'center';
      const pop = 1 + Math.min(0.4, (this.comboT > 1.4 ? (this.comboT - 1.4) * 3 : 0));
      ctx.font = `800 ${Math.max(30, w * 0.04) * pop}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = `hsla(${45 + this.combo * 8}, 100%, 65%, ${Math.min(1, this.comboT)})`;
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 8;
      ctx.fillText(`${this.combo}× COMBO`, w / 2, h * 0.14);
      ctx.restore();
    }

    // Wave banner
    if (this.waveBannerT > 0) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.globalAlpha = Math.min(1, this.waveBannerT);
      ctx.font = `800 ${Math.max(40, w * 0.06)}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(150, 80, 255, 0.9)';
      ctx.shadowBlur = 24;
      ctx.fillText(`WAVE ${this.wave}`, w / 2, h * 0.4);
      ctx.restore();
    }

    // Tracking hint when no arms are visible.
    if (!this.swords[0].visible && !this.swords[1].visible && !this.over) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(this.time * 3);
      ctx.font = `600 ${Math.max(16, w * 0.018)}px 'Segoe UI', sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 6;
      ctx.fillText('Step back so the camera can see your arms 🙌', w / 2, h * 0.85);
      ctx.restore();
    }
  }
}

function hexWithAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
