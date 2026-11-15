// Synthesizes a 55-second cinema-ready chiptune/electro-rock soundtrack + synced SFX
// for the GravWars project cartoon -> promo/out/cartoon_music.wav
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SR = 44100;
const T = 55;
const N = SR * T;

// Separated mix buses for sidechain ducking, stereo reverb send, and crisp SFX layering
const drumL = new Float32Array(N);
const drumR = new Float32Array(N);
const synthL = new Float32Array(N);
const synthR = new Float32Array(N);
const sfxL = new Float32Array(N);
const sfxR = new Float32Array(N);
const revL = new Float32Array(N);
const revR = new Float32Array(N);
const duckEnv = new Float32Array(N).fill(1.0);

let seed = 424242;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 4294967296) * 2 - 1;
};

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const note = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Constant-power stereo bus writer with optional reverb send
function addBus(busL, busR, i, v, pan = 0, revAmt = 0) {
  if (i < 0 || i >= N) return;
  const angle = (clamp(pan, -1, 1) + 1) * 0.7853981633974483; // (pan+1)*PI/4
  const l = v * Math.cos(angle);
  const r = v * Math.sin(angle);
  busL[i] += l;
  busR[i] += r;
  if (revAmt > 0) {
    revL[i] += l * revAmt;
    revR[i] += r * revAmt;
  }
}

function stampDuck(t, depth = 0.52, rate = 11) {
  const s = Math.floor(t * SR);
  const len = Math.floor(SR * 0.35);
  for (let i = 0; i < len; i++) {
    const idx = s + i;
    if (idx < 0 || idx >= N) continue;
    const x = i / SR;
    const atk = Math.min(1, x / 0.004);
    const val = 1 - depth * atk * Math.exp(-x * rate);
    if (val < duckEnv[idx]) duckEnv[idx] = val;
  }
}

// ==================== DRUMS & PERCUSSION ====================

function kick(t, vol = 0.85, duckAmt = 0.48) {
  const s = Math.floor(t * SR);
  let ph = 0;
  for (let i = 0; i < SR * 0.34; i++) {
    const x = i / SR;
    const f = 44 + 135 * Math.exp(-x * 36) + 28 * Math.exp(-x * 8);
    ph += (2 * Math.PI * f) / SR;
    const body = Math.tanh(Math.sin(ph) * 1.4) * Math.exp(-x * 9.2);
    const click = Math.sin(2 * Math.PI * 1650 * x) * Math.exp(-x * 170) * 0.32;
    addBus(drumL, drumR, s + i, (body + click) * vol, 0, 0.03);
  }
  if (duckAmt > 0) stampDuck(t, duckAmt, 12);
}

function snare(t, vol = 0.38, clapLayer = true) {
  const s = Math.floor(t * SR);
  let prev = 0;
  let lp = 0;
  for (let i = 0; i < SR * 0.22; i++) {
    const x = i / SR;
    const n = rnd();
    const hp = n - prev * 0.85;
    prev = n;
    lp += (hp - lp) * 0.52;
    const tone = Math.sin(2 * Math.PI * (188 + 90 * Math.exp(-x * 45)) * x) * Math.exp(-x * 26);
    const wire = lp * Math.exp(-x * 21);
    addBus(drumL, drumR, s + i, (tone * 0.44 + wire * 0.62) * vol, 0, 0.14);
  }
  if (clapLayer) {
    // Stereo micro-slap clap for punchy modern pop/electro snap
    [0, 0.01, 0.021].forEach((off, idx) => {
      const cs = Math.floor((t + off) * SR);
      let p = 0;
      for (let i = 0; i < SR * 0.09; i++) {
        const x = i / SR;
        const n = rnd();
        const bp = (n - p) * 0.7;
        p = n;
        addBus(drumL, drumR, cs + i, bp * Math.exp(-x * 36) * vol * 0.28, idx === 1 ? -0.35 : 0.35, 0.18);
      }
    });
  }
}

function hat(t, vol = 0.12, open = false, pan = 0.24) {
  const s = Math.floor(t * SR);
  const dur = open ? 0.22 : 0.055;
  const decay = open ? 15 : 82;
  let p1 = 0;
  let p2 = 0;
  for (let i = 0; i < SR * dur; i++) {
    const x = i / SR;
    const n = rnd();
    const hp = n - 2 * p1 + p2;
    p2 = p1;
    p1 = n;
    const metal =
      Math.sin(2 * Math.PI * 3420 * x) * 0.25 +
      Math.sin(2 * Math.PI * 5180 * x) * 0.25 +
      Math.sin(2 * Math.PI * 7430 * x) * 0.2;
    addBus(drumL, drumR, s + i, (hp * 0.32 + metal * 0.45) * Math.exp(-x * decay) * vol, pan, open ? 0.12 : 0.04);
  }
}

function tom(t, fStart = 180, fEnd = 78, vol = 0.42, pan = 0) {
  const s = Math.floor(t * SR);
  let ph = 0;
  for (let i = 0; i < SR * 0.24; i++) {
    const x = i / SR;
    const f = fEnd + (fStart - fEnd) * Math.exp(-x * 22);
    ph += (2 * Math.PI * f) / SR;
    const v = (Math.sin(ph) + 0.18 * Math.sin(ph * 2)) * Math.exp(-x * 13) * vol;
    addBus(drumL, drumR, s + i, v, pan, 0.15);
  }
}

function crash(t, vol = 0.28, pan = -0.2) {
  const s = Math.floor(t * SR);
  let p1 = 0;
  for (let i = 0; i < SR * 1.4; i++) {
    const x = i / SR;
    const n = rnd();
    const hp = n - p1 * 0.92;
    p1 = n;
    const ring =
      Math.sin(2 * Math.PI * 2960 * x) * 0.18 +
      Math.sin(2 * Math.PI * 4210 * x) * 0.18 +
      Math.sin(2 * Math.PI * 6350 * x) * 0.16;
    const env = Math.min(1, x / 0.008) * Math.exp(-x * 2.7);
    addBus(drumL, drumR, s + i, (hp * 0.36 + ring * 0.45) * env * vol, pan, 0.32);
  }
}

function drumFill(tEnd, intensity = 1) {
  // Snappy 16th-note tom + snare fill leading right into scene boundary tEnd
  const steps = [
    { off: -0.5, type: 'snare', v: 0.26, pan: -0.2 },
    { off: -0.375, type: 'tom', f1: 230, f2: 120, v: 0.38, pan: -0.35 },
    { off: -0.25, type: 'tom', f1: 185, f2: 96, v: 0.42, pan: 0.1 },
    { off: -0.1875, type: 'snare', v: 0.28, pan: 0.2 },
    { off: -0.125, type: 'tom', f1: 145, f2: 72, v: 0.48, pan: 0.4 },
    { off: -0.0625, type: 'snare', v: 0.4, pan: 0 },
  ];
  for (const st of steps) {
    const tt = tEnd + st.off;
    if (tt < 0.1) continue;
    if (st.type === 'snare') snare(tt, st.v * intensity, false);
    else tom(tt, st.f1, st.f2, st.v * intensity, st.pan);
  }
}

// ==================== MUSICAL SYNTHS ====================

function bass(t, m, dur, vol = 0.28, bright = 0.16) {
  const s = Math.floor(t * SR);
  const f = note(m);
  let lp = 0;
  const len = Math.floor(SR * dur);
  for (let i = 0; i < len; i++) {
    const x = i / SR;
    const saw1 = 2 * ((x * f) % 1) - 1;
    const saw2 = 2 * ((x * f * 1.003) % 1) - 1;
    const sub = Math.sin(2 * Math.PI * f * x);
    const cutoff = 0.06 + bright * Math.exp(-x * 11);
    lp += ((saw1 + saw2) * 0.5 - lp) * cutoff;
    const env = Math.min(1, x * 220) * Math.min(1, (dur - x) * 45) * Math.exp(-x * 2.6);
    addBus(synthL, synthR, s + i, (sub * 0.62 + lp * 0.55) * env * vol, 0, 0.03);
  }
}

function pad(t, ms, dur, vol = 0.055, warmth = 0.22) {
  const s = Math.floor(t * SR);
  const len = Math.floor(SR * dur);
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < len; i++) {
    const x = i / SR;
    const env = Math.min(1, x * 3.5, (dur - x) * 3.2);
    let vL = 0;
    let vR = 0;
    for (let j = 0; j < ms.length; j++) {
      const f = note(ms[j]);
      // Detuned saw/tri blend per voice for lush warm stereo spread
      const sA = 2 * ((x * f * 0.9965) % 1) - 1;
      const sB = 2 * ((x * f * 1.0035) % 1) - 1;
      const sC = Math.sin(2 * Math.PI * f * x);
      const v1 = sA * 0.4 + sC * 0.45 + 0.15 * Math.sin(2 * Math.PI * f * 2 * x);
      const v2 = sB * 0.4 + sC * 0.45 + 0.15 * Math.sin(2 * Math.PI * f * 2 * x);
      const spread = j % 2 === 0 ? 0.65 : 0.35;
      vL += v1 * spread + v2 * (1 - spread);
      vR += v2 * spread + v1 * (1 - spread);
    }
    const cut = 0.05 + warmth * (0.5 + 0.5 * Math.sin(Math.PI * (x / dur)));
    lpL += (vL - lpL) * cut;
    lpR += (vR - lpR) * cut;
    const idx = s + i;
    if (idx >= 0 && idx < N) {
      synthL[idx] += lpL * env * vol;
      synthR[idx] += lpR * env * vol;
      revL[idx] += lpL * env * vol * 0.35;
      revR[idx] += lpR * env * vol * 0.35;
    }
  }
}

function synthStab(t, ms, dur = 0.45, vol = 0.09) {
  const s = Math.floor(t * SR);
  const len = Math.floor(SR * dur);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const x = i / SR;
    let v = 0;
    for (const m of ms) {
      const f = note(m);
      v += (2 * ((x * f * 0.996) % 1) - 1) * 0.5 + (2 * ((x * f * 1.004) % 1) - 1) * 0.5;
    }
    const cut = 0.08 + 0.48 * Math.exp(-x * 8);
    lp += (v - lp) * cut;
    const env = Math.min(1, x * 180) * Math.exp(-x * 4.5);
    addBus(synthL, synthR, s + i, (lp / ms.length) * env * vol, 0, 0.32);
  }
}

function pluck(t, m, vol = 0.085, pan = 0, dur = 0.28) {
  const s = Math.floor(t * SR);
  const f = note(m);
  let lp = 0;
  const len = Math.floor(SR * dur);
  for (let i = 0; i < len; i++) {
    const x = i / SR;
    const saw = 2 * ((x * f) % 1) - 1;
    const tri = 2 * Math.abs(2 * ((x * f) % 1) - 1) - 1;
    const cut = 0.07 + 0.55 * Math.exp(-x * 18);
    lp += ((saw * 0.55 + tri * 0.45) - lp) * cut;
    const env = Math.min(1, x * 240) * Math.exp(-x * 12);
    addBus(synthL, synthR, s + i, lp * env * vol, pan, 0.24);
  }
}

function lead(t, m, dur, vol = 0.11, pan = -0.1, retro = false) {
  const s = Math.floor(t * SR);
  const f0 = note(m);
  let lp = 0;
  let ph = 0;
  const len = Math.floor(SR * dur);
  for (let i = 0; i < len; i++) {
    const x = i / SR;
    const vib = x > 0.07 ? Math.sin(2 * Math.PI * 5.6 * x) * 0.0055 * Math.min(1, (x - 0.07) * 6) : 0;
    const f = f0 * (1 + vib);
    ph = (ph + f / SR) % 1;
    const pwm = 0.35 + 0.14 * Math.sin(2 * Math.PI * 2.2 * x);
    const sq = ph < pwm ? 1 : -1;
    const saw = 2 * ph - 1;
    const raw = retro ? sq : sq * 0.58 + saw * 0.42;
    lp += (raw - lp) * (retro ? 0.58 : 0.26);
    const env = Math.min(1, x * 130) * Math.min(1, (dur - x) * 35) * Math.exp(-x * 3.8);
    addBus(synthL, synthR, s + i, lp * env * vol, pan, retro ? 0.18 : 0.28);
  }
}

// ==================== CINEMA SFX ====================

function whoosh(t, dur = 0.45, vol = 0.28, fStart = 0.02, fEnd = 0.55, panDir = 1) {
  const s = Math.floor(t * SR);
  const len = Math.floor(SR * dur);
  let lp = 0;
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const x = i / SR;
    const p = x / dur;
    const n = rnd();
    hp = n - prev * 0.85;
    prev = n;
    const cut = fStart + (fEnd - fStart) * Math.pow(p, 1.3);
    lp += (hp - lp) * cut;
    const env = Math.pow(Math.sin(Math.PI * p), 1.35);
    addBus(sfxL, sfxR, s + i, lp * env * vol, (p * 2 - 1) * 0.55 * panDir, 0.25);
  }
}

function boom(t, vol = 0.95, subDrop = true) {
  kick(t, vol * 0.95, 0.72);
  const s = Math.floor(t * SR);
  let lp = 0;
  let ph = 0;
  for (let i = 0; i < SR * 1.1; i++) {
    const x = i / SR;
    lp += (rnd() - lp) * (0.03 + 0.08 * Math.exp(-x * 6));
    let sub = 0;
    if (subDrop) {
      const f = 32 + 95 * Math.exp(-x * 7.5);
      ph += (2 * Math.PI * f) / SR;
      sub = Math.sin(ph) * Math.exp(-x * 2.8) * 0.65;
    }
    const rumble = lp * Math.exp(-x * 3.9) * 1.35;
    addBus(sfxL, sfxR, s + i, (rumble + sub) * vol, 0, 0.28);
  }
  stampDuck(t, 0.78, 7.5);
}

function ding(t, freq = 1568, vol = 0.16, pan = 0.15, decay = 11) {
  const s = Math.floor(t * SR);
  for (let i = 0; i < SR * 0.42; i++) {
    const x = i / SR;
    const sig =
      Math.sin(2 * Math.PI * freq * x) +
      0.5 * Math.sin(2 * Math.PI * freq * 1.5 * x) * Math.exp(-x * 6) +
      0.28 * Math.sin(2 * Math.PI * freq * 2.99 * x) * Math.exp(-x * 14);
    const env = Math.min(1, x * 500) * Math.exp(-x * decay);
    addBus(sfxL, sfxR, s + i, sig * env * vol, pan, 0.32);
  }
}

function click(t, vol = 0.24, pitch = 340, pan = 0) {
  const s = Math.floor(t * SR);
  for (let i = 0; i < SR * 0.065; i++) {
    const x = i / SR;
    const tone = Math.sin(2 * Math.PI * (pitch - x * 2100) * x) * Math.exp(-x * 55);
    const snap = rnd() * Math.exp(-x * 130) * 0.4;
    addBus(sfxL, sfxR, s + i, (tone + snap) * vol, pan, 0.08);
  }
}

function shot(t, vol = 0.26, pan = -0.15, pitch = 190) {
  const s = Math.floor(t * SR);
  let prev = 0;
  for (let i = 0; i < SR * 0.14; i++) {
    const x = i / SR;
    const n = rnd();
    const crack = (n - prev * 0.6) * Math.exp(-x * 36);
    prev = n;
    const punch = Math.sin(2 * Math.PI * (pitch * Math.exp(-x * 28) + 60) * x) * Math.exp(-x * 32) * 0.65;
    addBus(sfxL, sfxR, s + i, (crack + punch) * vol, pan, 0.16);
  }
}

function gravityFlipSfx(tStart) {
  // 9.6-10.5s: Rising anti-gravity sweep + deep inversion thud + crystalline gravity lock chime
  const s = Math.floor(tStart * SR);
  const dur = 0.9;
  const len = Math.floor(SR * dur);
  let ph = 0;
  let ph2 = 0;
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const x = i / SR;
    const p = x / dur;
    const f = 95 * Math.pow(5.5, p);
    ph += (2 * Math.PI * f) / SR;
    ph2 += (2 * Math.PI * (f * 1.498)) / SR;
    lp += (rnd() - lp) * (0.04 + 0.45 * p);
    const sweep = (Math.sin(ph) * 0.5 + Math.sin(ph2) * 0.3 + lp * 0.85) * Math.sin(Math.PI * p);
    addBus(sfxL, sfxR, s + i, sweep * 0.34, Math.sin(p * 4) * 0.5, 0.34);
  }
  whoosh(tStart + 0.05, 0.65, 0.32, 0.04, 0.6, -1);
  // Deep gravity-shift thud at 10.1s & 10.4s
  boom(tStart + 0.78, 0.68, true);
  // Gravity lock chime cluster
  [587.33, 880, 1174.66, 1760].forEach((f, idx) => ding(tStart + 0.8 + idx * 0.045, f, 0.13, (idx - 1.5) * 0.3, 8));
}

function applePickup(t) {
  ding(t, 987.77, 0.14, -0.25, 14);
  ding(t + 0.06, 1318.5, 0.16, -0.2, 11);
}

function pondSplash(t) {
  const s = Math.floor(t * SR);
  let lp = 0;
  for (let i = 0; i < SR * 0.42; i++) {
    const x = i / SR;
    const cut = 0.1 + 0.25 * Math.exp(-x * 6);
    lp += (rnd() - lp) * cut;
    addBus(sfxL, sfxR, s + i, lp * Math.exp(-x * 7.5) * 0.36, -0.22, 0.24);
  }
  // Resonant water bubble blips
  [0.04, 0.11, 0.17, 0.24].forEach((off, idx) => {
    const bs = Math.floor((t + off) * SR);
    const baseF = 340 + idx * 140;
    let ph = 0;
    for (let i = 0; i < SR * 0.075; i++) {
      const x = i / SR;
      ph += (2 * Math.PI * (baseF + x * 2400)) / SR;
      addBus(sfxL, sfxR, bs + i, Math.sin(ph) * Math.exp(-x * 42) * 0.15, -0.25 + idx * 0.06, 0.2);
    }
  });
}

function fishCatch(t) {
  // Fast reel whirr then celebratory catch chime
  for (let i = 0; i < 4; i++) click(t - 0.18 + i * 0.04, 0.13, 620 + i * 90, -0.18);
  [880, 1108.73, 1318.51, 1760].forEach((f, i) => ding(t + i * 0.048, f, 0.14, -0.15 + i * 0.1, 10));
}

function glassBreak(t, vol = 0.14, heavy = false) {
  // Sharp glass crack transient
  const s = Math.floor(t * SR);
  let prev = 0;
  for (let i = 0; i < SR * 0.12; i++) {
    const x = i / SR;
    const n = rnd();
    const hp = n - prev;
    prev = n;
    addBus(sfxL, sfxR, s + i, hp * Math.exp(-x * 42) * vol * 1.9, 0, 0.28);
  }
  // High-Q crystal/glass shard scatter
  const count = heavy ? 18 : 11;
  for (let k = 0; k < count; k++) {
    const dt = k * 0.016 + Math.abs(rnd()) * 0.032;
    const f = 1450 + Math.abs(rnd()) * (heavy ? 2600 : 2100);
    ding(t + dt, f, vol * (0.55 + Math.abs(rnd()) * 0.5), (k % 2 ? 1 : -1) * (0.15 + Math.abs(rnd()) * 0.45), 14);
  }
  if (heavy) boom(t, 0.72, true);
}

function coinShower(t) {
  const freqs = [1567.98, 2093.0, 1760.0, 2349.32, 1975.53, 2637.02];
  freqs.forEach((f, i) => {
    ding(t + i * 0.055, f, 0.13, (i - 2.5) * 0.18, 12);
  });
}

function powerChime(t) {
  [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) =>
    ding(t + i * 0.058, f, 0.13, (i - 2) * 0.18, 8.5),
  );
}

function crossbowSequence(tCharge, tFire, tHeadshot) {
  // 23.0-23.2s: 3-level charge hum + mechanical ratchet clicks
  const s = Math.floor(tCharge * SR);
  const dur = Math.max(0.15, tFire - tCharge);
  const len = Math.floor(SR * dur);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const x = i / SR;
    const p = x / dur;
    const tier = Math.floor(p * 3) / 3;
    const f = 220 + tier * 260 + p * 180;
    ph += (2 * Math.PI * f) / SR;
    const hum = (Math.sin(ph) * 0.6 + (2 * ((x * f * 0.5) % 1) - 1) * 0.3) * Math.min(1, p * 4);
    addBus(sfxL, sfxR, s + i, hum * 0.18, -0.25, 0.15);
  }
  click(tCharge, 0.16, 480, -0.25);
  click(tCharge + dur * 0.33, 0.18, 620, -0.25);
  click(tCharge + dur * 0.66, 0.21, 780, -0.25);

  // 23.2s: Snappy twang + cyan bolt zip
  const sf = Math.floor(tFire * SR);
  for (let i = 0; i < SR * 0.26; i++) {
    const x = i / SR;
    const f = 210 + 340 * Math.exp(-x * 20);
    const tw = (Math.sin(2 * Math.PI * f * x) + 0.45 * Math.sin(2 * Math.PI * f * 2.02 * x)) * Math.exp(-x * 14);
    const snap = rnd() * Math.exp(-x * 95) * 0.55;
    addBus(sfxL, sfxR, sf + i, (tw + snap) * 0.36, -0.1, 0.2);
  }
  whoosh(tFire + 0.01, 0.26, 0.26, 0.2, 0.72, 1);

  // 23.55s: Crisp headshot ding + critical sparkle!
  ding(tHeadshot, 1864.66, 0.2, 0.35, 9);
  ding(tHeadshot + 0.04, 2793.83, 0.14, 0.4, 11);
}

function hookAndGrapple(tLatch, tZipEnd) {
  // Metallic hook latch clank
  ding(tLatch, 740, 0.16, 0.15, 22);
  ding(tLatch, 1190, 0.14, 0.18, 25);
  click(tLatch, 0.3, 440, 0.15);

  // Grapple winch zip
  const s = Math.floor((tLatch + 0.1) * SR);
  const dur = Math.max(0.2, tZipEnd - (tLatch + 0.1));
  const len = Math.floor(SR * dur);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const x = i / SR;
    const p = x / dur;
    const f = 320 + 780 * p;
    ph += (2 * Math.PI * f) / SR;
    const zip = ((2 * ((ph / (2 * Math.PI)) % 1) - 1) * 0.35 + Math.sin(ph) * 0.45) * Math.sin(Math.PI * p);
    addBus(sfxL, sfxR, s + i, zip * 0.16, (p - 0.5) * 0.5, 0.18);
  }
  whoosh(tLatch + 0.12, dur, 0.25, 0.08, 0.55, 1);
}

function shieldChargeToMegaBlast(tStart, tBlast) {
  // 31.2-33.2s: Rising harmonic shield hum & pulsing energy build -> 33.2s Mega Blast!
  const s = Math.floor(tStart * SR);
  const dur = tBlast - tStart;
  const len = Math.floor(SR * dur);
  let ph1 = 0;
  let ph2 = 0;
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const x = i / SR;
    const p = x / dur;
    const f = 130 * Math.pow(4.8, Math.pow(p, 1.35));
    ph1 += (2 * Math.PI * f) / SR;
    ph2 += (2 * Math.PI * (f * 1.503)) / SR;
    const pulse = 0.55 + 0.45 * Math.sin(2 * Math.PI * (4 + p * 18) * x);
    lp += (rnd() - lp) * (0.04 + 0.38 * p);
    const sig = (Math.sin(ph1) * 0.5 + Math.sin(ph2) * 0.35 + lp * 0.5) * pulse * Math.pow(p, 0.7);
    addBus(sfxL, sfxR, s + i, sig * 0.3, Math.sin(p * 10) * 0.35, 0.34);
  }
  // Mega Blast at 33.2s!
  boom(tBlast, 1.05, true);
  crash(tBlast, 0.34, 0.1);
  whoosh(tBlast, 0.85, 0.38, 0.5, 0.05, -1);
  // Brief stunned ringing tone right after blast
  const sr = Math.floor((tBlast + 0.06) * SR);
  for (let i = 0; i < SR * 0.85; i++) {
    const x = i / SR;
    addBus(sfxL, sfxR, sr + i, Math.sin(2 * Math.PI * 2250 * x) * Math.exp(-x * 4.5) * 0.055, 0, 0.3);
  }
}

function retro8BitSweep(tStart) {
  // 43.8-45.2s: Authentic stepped 8-bit chiptune arpeggio + bitcrushed retro sweep around 44.0s!
  const arpNotes = [69, 72, 76, 81, 84, 88, 84, 81, 76, 72, 76, 81, 88, 93, 96, 88];
  arpNotes.forEach((m, idx) => {
    const tt = tStart + idx * 0.055;
    const s = Math.floor(tt * SR);
    const f = note(m);
    const stepHold = 4; // subtle sample-and-hold lo-fi 8-bit crunch
    let held = 0;
    for (let i = 0; i < SR * 0.085; i++) {
      const x = i / SR;
      if (i % stepHold === 0) {
        const sq = ((x * f) % 1) < 0.25 ? 1 : -1;
        held = Math.round(sq * 7) / 7;
      }
      addBus(sfxL, sfxR, s + i, held * Math.exp(-x * 24) * 0.14, (idx % 2 ? 1 : -1) * 0.42, 0.22);
    }
  });
  // Stepped retro frequency wipe
  const s = Math.floor((tStart + 0.08) * SR);
  const dur = 0.72;
  let ph = 0;
  let held = 0;
  for (let i = 0; i < SR * dur; i++) {
    const x = i / SR;
    const p = x / dur;
    const qStep = Math.floor(p * 16) / 16;
    const f = 240 + 1450 * qStep;
    ph += (2 * Math.PI * f) / SR;
    if (i % 6 === 0) held = (ph % (2 * Math.PI)) < Math.PI ? 1 : -1;
    const env = Math.sin(Math.PI * p) * 0.14;
    addBus(sfxL, sfxR, s + i, held * env, (p * 2 - 1) * 0.6, 0.22);
  }
}

// ==================== MUSIC TIMELINE (120 BPM, bar = 2.0s) ====================
// Progression for main battle/journey: Am - F - C - G
// Triumphant outro progression (46.5-55.0s): Fmaj7 - G6 - Am9 - Cmaj9 -> F - G - C!
const chordsMain = [
  [57, 60, 64, 67], // Am7
  [53, 57, 60, 64], // Fmaj7
  [48, 52, 55, 59], // Cmaj7
  [55, 59, 62, 64], // G6
];
const rootsMain = [33, 29, 36, 31];
const melodyA = [69, 72, 76, 72, 74, 72, 69, 67];
const melodyB = [76, 79, 81, 79, 76, 74, 72, 74];

for (let bar = 0; bar * 2 < T; bar++) {
  const t0 = bar * 2;
  const c = bar % 4;
  const isIntroPre = t0 < 2.0;
  const isS2 = t0 >= 6.0 && t0 < 13.5;
  const isS3 = t0 >= 13.5 && t0 < 21.0;
  const isHighEnergy = t0 >= 21.0 && t0 < 38.5;
  const isTech = t0 >= 38.5 && t0 < 46.5;
  const isOutro = t0 >= 46.0;

  let ch = chordsMain[c];
  let rt = rootsMain[c];
  if (isOutro) {
    // Uplifting finale progression: Fmaj7 -> G6 -> Am9 -> Cmaj7 -> C
    const outroIdx = bar - 23;
    const outroChords = [
      [53, 57, 60, 64], // Fmaj7 (46s)
      [55, 59, 62, 67], // G6    (48s)
      [57, 60, 64, 71], // Am9   (50s)
      [48, 55, 60, 64], // C     (52s)
      [48, 52, 55, 60], // C     (54s)
    ];
    const outroRoots = [29, 31, 33, 36, 36];
    const oi = Math.min(outroChords.length - 1, Math.max(0, outroIdx));
    ch = outroChords[oi];
    rt = outroRoots[oi];
  }

  // Warm layered pad
  const padVol = isOutro ? 0.068 : isHighEnergy ? 0.056 : isIntroPre ? 0.048 : 0.045;
  const padWarmth = isHighEnergy || isOutro ? 0.34 : isIntroPre ? 0.14 : 0.22;
  if (t0 < T - 1.2) {
    pad(t0, ch, Math.min(2.1, T - t0), padVol, padWarmth);
  }

  // Intro build (0.0-2.0s)
  if (isIntroPre) {
    bass(0.0, 33, 1.85, 0.2, 0.05);
  }

  // Beat grid (4 beats per 2s bar)
  for (let b = 0; b < 4; b++) {
    const tb = t0 + b * 0.5;
    if (tb < 2.0 || tb >= T - 1.8) continue;

    // Punchy Kick
    const kickVol = isHighEnergy || isOutro ? 0.96 : isS3 ? 0.82 : 0.86;
    kick(tb, kickVol, isHighEnergy || isOutro ? 0.55 : 0.42);
    // Syncopated extra kick in S4/S5/S7 for driving energy
    if ((isHighEnergy || isOutro) && b === 2 && tb + 0.375 < T - 2.0) {
      kick(tb + 0.375, 0.65, 0.3);
    }

    // Crisp Snare + Clap
    if (b % 2 === 1) {
      snare(tb, isHighEnergy || isOutro ? 0.44 : 0.33, !isS2);
    }

    // Hats (closed offbeat + 16th energy hats + occasional open hat)
    hat(tb + 0.25, isHighEnergy ? 0.14 : 0.11, b === 3 && !isS2);
    if (isHighEnergy || isOutro) {
      hat(tb + 0.125, 0.07, false, -0.25);
      hat(tb + 0.375, 0.08, false, 0.3);
    } else if (isS3 || isTech) {
      hat(tb + 0.125, 0.045, false, -0.2);
    }

    // Punchy Bass (octave bounce; funkier syncopation in S3/S6)
    const bassBright = isHighEnergy ? 0.22 : isS3 ? 0.18 : 0.14;
    bass(tb, rt, 0.23, isHighEnergy || isOutro ? 0.31 : 0.26, bassBright);
    if (isS3 && b % 2 === 1) {
      bass(tb + 0.25, rt + 12, 0.19, 0.19, bassBright);
      bass(tb + 0.375, rt + 7, 0.12, 0.14, bassBright);
    } else {
      bass(tb + 0.25, rt + 12, 0.21, 0.2, bassBright);
    }
  }

  // 16th-note stereo plucks & expressive melody leads
  for (let k = 0; k < 16; k++) {
    const tk = t0 + k * 0.125;
    if (tk < 2.0 && k % 2) continue;
    if (tk >= T - 1.9) break;

    const arpNote = ch[[0, 1, 2, 3, 2, 1, 0, 2][k % 8]] + 12 + (k >= 8 && k % 3 === 0 ? 12 : 0);
    const pluckVol = isIntroPre ? 0.055 + (tk / 2.0) * 0.03 : isHighEnergy ? 0.082 : 0.07;
    pluck(tk, arpNote, pluckVol, k % 2 ? 0.42 : -0.42);

    // Lead melody lines tailored to sections
    const playLead =
      (tk >= 2.0 && tk < 6.3) ||
      (tk >= 10.5 && tk < 13.3) ||
      (tk >= 21.0 && tk < 38.3) ||
      (tk >= 38.5 && tk < 46.2 && k % 4 === 0) ||
      tk >= 46.7;

    if (playLead && k % 2 === 0) {
      const mSet = isHighEnergy || isOutro ? melodyB : melodyA;
      const shift = isOutro ? (bar === 26 ? 0 : 0) : c === 1 ? -4 : c === 2 ? -5 : 0;
      const mNote = mSet[(k / 2 + bar) % mSet.length] + shift;
      const lVol = isOutro ? 0.12 : isHighEnergy ? 0.105 : 0.078;
      lead(tk, mNote, 0.23, lVol, isTech ? 0.2 : -0.14, isTech);
    }
  }
}

// Extra Outro triumphant fanfare chords & final ring-out at 52.5s
synthStab(2.0, [57, 60, 64, 69], 0.65, 0.12);
synthStab(46.7, [53, 57, 60, 65, 69], 0.85, 0.14);
synthStab(48.5, [55, 59, 62, 67, 71], 0.75, 0.13);
synthStab(50.5, [57, 60, 64, 69, 72], 0.9, 0.13);
synthStab(52.5, [48, 55, 60, 64, 67, 72], 1.8, 0.16);
kick(52.5, 0.92, 0.5);
crash(52.5, 0.28, 0.25);

// ==================== SCENE TRANSITIONS & FILLS ====================
const transitions = [6.5, 13.5, 21.0, 29.0, 38.5, 46.5];
transitions.forEach((t, idx) => {
  drumFill(t, idx >= 2 ? 1.1 : 0.9);
  whoosh(t - 0.22, 0.45, 0.28, 0.04, 0.58, idx % 2 ? -1 : 1);
  if (idx === 2 || idx === 3 || idx === 5) crash(t, 0.26, idx % 2 ? -0.25 : 0.25);
});

// ==================== SYNCED SFX TIMELINE ====================

// S1 (0..6.5s): Rising cube tension -> Title slam at 2.0s!
whoosh(0.45, 1.5, 0.24, 0.02, 0.62, 1);
boom(2.0, 1.0, true);
crash(2.0, 0.34, 0);
powerChime(2.04);

// S2 (6.5..13.5s): Footsteps on bridge -> 90deg gravity flip at 9.6-10.5s
for (let i = 0; i < 6; i++) {
  click(7.2 + i * 0.32, 0.2, 310 + (i % 2) * 35, -0.15 + i * 0.04);
}
gravityFlipSfx(9.6);

// S3 (13.5..21.0s): Apple, Pond splash, Fish catch, Glass bottle break, Bandit shots + Coins, Shop chime
applePickup(14.8);
pondSplash(16.0);
fishCatch(16.7);
glassBreak(17.7, 0.13, false); // bottle smash
click(18.52, 0.18, 720, 0.2); // bandit alert '!'
shot(18.6, 0.24, -0.15, 210);
shot(18.76, 0.24, -0.1, 225);
coinShower(19.0);
click(20.1, 0.34, 460, 0.25);
powerChime(20.14); // shop purchase!

// S4 (21.0..29.0s): Windy AK burst -> Crossbow charge+twang+headshot -> Rocket jump -> Grapple + Build
whoosh(21.2, 1.3, 0.16, 0.08, 0.32, 1); // wind gust bed
for (let i = 0; i < 4; i++) shot(21.6 + i * 0.14, 0.25, -0.22 + i * 0.06, 185);
crossbowSequence(23.0, 23.2, 23.55);
boom(24.5, 1.02, true); // Rocket jump mega boom!
crash(24.5, 0.24, -0.3);
whoosh(24.58, 0.78, 0.34, 0.12, 0.68, 1); // upward air rush
hookAndGrapple(26.3, 27.1);
for (let i = 0; i < 6; i++) {
  click(27.3 + i * 0.18, 0.26, 360 + i * 65, -0.25 + i * 0.1);
}

// S5 (29.0..38.5s): Crystal Stage 1 -> Shield charge -> Mega Blast -> Stage 2 -> Victory chord
for (let i = 0; i < 6; i++) {
  const st = 29.8 + i * 0.11;
  shot(st, 0.24, -0.15, 195);
  ding(st + 0.03, 1480 + i * 110, 0.065, 0.25, 18); // crystal hit ping
}
glassBreak(30.6, 0.15, true); // Stage 1 crystal shatter!
shieldChargeToMegaBlast(31.2, 33.2); // Rising shield hum -> 33.2s Mega Blast!
for (let i = 0; i < 5; i++) {
  const st = 34.6 + i * 0.115;
  shot(st, 0.25, -0.12, 200);
  ding(st + 0.03, 1650 + i * 130, 0.075, 0.25, 16);
}
glassBreak(35.5, 0.18, true); // Stage 2 crystal shatter!
shot(36.8, 0.34, 0, 140); // Final elimination blast
powerChime(37.3); // Team eliminated!

// S6 (38.5..46.5s): Bot cards, PeerJS connection chime, Retro shader 8-bit arpeggio/sweep at 44.0s
click(39.4, 0.25, 420, -0.45);
ding(39.42, 988, 0.08, -0.45, 16);
click(40.2, 0.25, 480, 0.0);
ding(41.8, 1174.66, 0.14, 0, 10);
ding(41.98, 1567.98, 0.14, 0.1, 10);
ding(42.16, 2093.0, 0.13, -0.1, 9);
retro8BitSweep(43.85);

// S7 (46.5..55.0s): Victory boom, fanfare & confetti sparkles
boom(46.7, 0.88, true);
powerChime(46.9);
for (let i = 0; i < 18; i++) {
  const st = 47.4 + i * 0.34;
  if (st >= T - 1.2) break;
  const f = [1568, 1975.5, 2093, 2349.3, 2637][i % 5];
  ding(st, f, 0.065, Math.sin(i * 1.9) * 0.75, 12);
}

// ==================== STEREO REVERB & MASTERING ====================
// 4-tap damped stereo Schroeder comb network for lush space without mud
const tapsL = [1307, 1637, 1913, 2341];
const tapsR = [1361, 1693, 1979, 2411];
const combsL = tapsL.map((len) => ({ buf: new Float32Array(len), idx: 0, lp: 0 }));
const combsR = tapsR.map((len) => ({ buf: new Float32Array(len), idx: 0, lp: 0 }));

const mixL = new Float32Array(N);
const mixR = new Float32Array(N);

for (let i = 0; i < N; i++) {
  const inL = revL[i];
  const inR = revR[i];
  let outRL = 0;
  let outRR = 0;
  for (let c = 0; c < 4; c++) {
    const cL = combsL[c];
    const yL = cL.buf[cL.idx];
    cL.lp += (yL - cL.lp) * 0.38;
    cL.buf[cL.idx] = inL + cL.lp * 0.56;
    cL.idx = (cL.idx + 1) % cL.buf.length;
    outRL += yL;

    const cR = combsR[c];
    const yR = cR.buf[cR.idx];
    cR.lp += (yR - cR.lp) * 0.38;
    cR.buf[cR.idx] = inR + cR.lp * 0.56;
    cR.idx = (cR.idx + 1) % cR.buf.length;
    outRR += yR;
  }
  // Slight stereo cross-blend on reverb wet return
  const wetL = (outRL * 0.8 + outRR * 0.2) * 0.14;
  const wetR = (outRR * 0.8 + outRL * 0.2) * 0.14;

  const dk = duckEnv[i];
  mixL[i] = drumL[i] * 0.92 + synthL[i] * dk * 1.05 + sfxL[i] * 1.12 + wetL;
  mixR[i] = drumR[i] * 0.92 + synthR[i] * dk * 1.05 + sfxR[i] * 1.12 + wetR;
}

// Compute RMS to set consistent punchy master drive, then apply smooth peak limiter + soft clip
let sumSq = 0;
for (let i = 0; i < N; i++) {
  sumSq += mixL[i] * mixL[i] + mixR[i] * mixR[i];
}
const rms = Math.sqrt(sumSq / (2 * N)) || 1;
const driveGain = 0.27 / rms;

const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + N * 4, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(N * 4, 40);

let env = 0;
const relCoeff = Math.exp(-1 / (SR * 0.11));
let outPeak = 0;

for (let i = 0; i < N; i++) {
  const x = i / SR;
  const fade = Math.min(1, x / 0.03, (T - x) / 1.5);
  const ml = mixL[i] * driveGain * fade;
  const mr = mixR[i] * driveGain * fade;

  const absP = Math.max(Math.abs(ml), Math.abs(mr));
  env = absP > env ? absP : env * relCoeff + absP * (1 - relCoeff);
  const lim = env > 1.45 ? 1.45 / env : 1;

  const l = Math.tanh(ml * lim * 1.2) * 0.97;
  const r = Math.tanh(mr * lim * 1.2) * 0.97;
  outPeak = Math.max(outPeak, Math.abs(l), Math.abs(r));

  buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
}

mkdirSync(join(here, 'out'), { recursive: true });
const outPath = join(here, 'out', 'cartoon_music.wav');
writeFileSync(outPath, buf);
console.log(
  `cartoon_music.wav written: ${T}s (${N} samples @ ${SR}Hz), ${(buf.length / (1024 * 1024)).toFixed(2)} MB, peak=${outPeak.toFixed(3)}`,
);
