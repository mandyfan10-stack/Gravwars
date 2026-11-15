// Synthesizes the promo soundtrack (music + SFX synced to promo.html) into promo/out/music.wav
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SR = 44100, T = 41, N = SR * T;
const L = new Float32Array(N), R = new Float32Array(N);
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
const add = (i, v, pan = 0) => { if (i < 0 || i >= N) return; L[i] += v * (1 - Math.max(0, pan)); R[i] += v * (1 + Math.min(0, pan)); };
const note = (m) => 440 * Math.pow(2, (m - 69) / 12);

function kick(t, vol = 0.9) {
  const s = Math.floor(t * SR); let ph = 0;
  for (let i = 0; i < SR * 0.35; i++) { const x = i / SR; const f = 45 + 110 * Math.exp(-x * 30); ph += 2 * Math.PI * f / SR; add(s + i, Math.sin(ph) * Math.exp(-x * 9) * vol); }
}
function snare(t, vol = 0.35) {
  const s = Math.floor(t * SR); let prev = 0;
  for (let i = 0; i < SR * 0.2; i++) { const x = i / SR; const n = rnd(); const hp = n - prev; prev = n; add(s + i, (hp * 0.6 + Math.sin(2 * Math.PI * 190 * x) * 0.4) * Math.exp(-x * 22) * vol); }
}
function hat(t, vol = 0.12) {
  const s = Math.floor(t * SR); let prev = 0;
  for (let i = 0; i < SR * 0.05; i++) { const x = i / SR; const n = rnd(); add(s + i, (n - prev) * Math.exp(-x * 90) * vol, 0.3); prev = n; }
}
function bass(t, m, dur, vol = 0.22) {
  const s = Math.floor(t * SR), f = note(m); let lp = 0;
  for (let i = 0; i < SR * dur; i++) { const x = i / SR; const saw = 2 * ((x * f) % 1) - 1; lp += (saw - lp) * 0.08; const env = Math.min(1, x * 200) * Math.exp(-x * 3); add(s + i, lp * env * vol); }
}
function pluck(t, m, vol = 0.07, pan = 0) {
  const s = Math.floor(t * SR), f = note(m);
  for (let i = 0; i < SR * 0.3; i++) { const x = i / SR; const tri = 2 * Math.abs(2 * ((x * f) % 1) - 1) - 1; add(s + i, tri * Math.exp(-x * 12) * vol, pan); }
}
function pad(t, ms, dur, vol = 0.035) {
  const s = Math.floor(t * SR);
  for (let i = 0; i < SR * dur; i++) { const x = i / SR; const env = Math.min(1, x * 3, (dur - x) * 3); let v = 0; for (const m of ms) v += Math.sin(2 * Math.PI * note(m) * x) + 0.3 * Math.sin(2 * Math.PI * note(m) * 2.003 * x); add(s + i, v * env * vol); }
}
function whoosh(t, dur = 0.45, vol = 0.22) {
  const s = Math.floor(t * SR); let lp = 0;
  for (let i = 0; i < SR * dur; i++) { const x = i / SR, p = x / dur; const a = 0.02 + 0.4 * p; lp += (rnd() - lp) * a; add(s + i, lp * Math.sin(Math.PI * p) * vol, Math.sin(p * 3) * 0.5); }
}
function boom(t, vol = 0.8) {
  kick(t, vol); const s = Math.floor(t * SR); let lp = 0;
  for (let i = 0; i < SR * 0.8; i++) { const x = i / SR; lp += (rnd() - lp) * 0.05; add(s + i, lp * Math.exp(-x * 5) * vol * 1.5); }
}
function ding(t, vol = 0.12) {
  const s = Math.floor(t * SR);
  for (let i = 0; i < SR * 0.25; i++) { const x = i / SR; add(s + i, (Math.sin(2 * Math.PI * 1568 * x) + 0.6 * Math.sin(2 * Math.PI * 2093 * x)) * Math.exp(-x * 14) * vol, 0.2); }
}
function click(t, vol = 0.25) {
  const s = Math.floor(t * SR);
  for (let i = 0; i < SR * 0.06; i++) { const x = i / SR; add(s + i, Math.sin(2 * Math.PI * (300 - x * 2000) * x) * Math.exp(-x * 60) * vol + rnd() * Math.exp(-x * 120) * vol * 0.4); }
}
function shot(t, vol = 0.2) {
  const s = Math.floor(t * SR); let prev = 0;
  for (let i = 0; i < SR * 0.09; i++) { const x = i / SR; const n = rnd(); add(s + i, (n - prev * 0.5) * Math.exp(-x * 40) * vol, -0.2); prev = n; }
}
function shatter(t) { for (let k = 0; k < 14; k++) ding(t + k * 0.018 + Math.abs(rnd()) * 0.03, 0.07); boom(t, 0.5); }

// ---- music: 120 bpm, Am F C G (one bar = 2 s)
const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const roots = [33, 29, 36, 31];
for (let bar = 0; bar * 2 < T; bar++) {
  const t0 = bar * 2, c = bar % 4;
  pad(t0, chords[c], 2.05);
  const drums = t0 >= 1.5 || false;
  for (let b = 0; b < 4; b++) {
    const tb = t0 + b * 0.5;
    if (tb >= 1.5 && tb < T - 1) { kick(tb); if (b % 2) snare(tb); hat(tb + 0.25); }
    if (tb >= 1.5) { bass(tb, roots[c], 0.24); bass(tb + 0.25, roots[c] + 12, 0.22, 0.14); }
  }
  for (let k = 0; k < 16; k++) {
    const tk = t0 + k * 0.125;
    if (tk < 1.5 && k % 2) continue;
    const ch = chords[c];
    pluck(tk, ch[[0, 1, 2, 1][k % 4]] + 12 + (k >= 8 ? 12 : 0) * (k % 3 === 0 ? 1 : 0), 0.05, k % 2 ? 0.4 : -0.4);
  }
  void drums;
}
// riser into the drop
whoosh(0.3, 1.2, 0.18);

// ---- SFX synced with the animation
[4.5, 10.5, 16.5, 22.5, 28, 28 + 5 / 3, 28 + 10 / 3, 33, 37].forEach((t) => whoosh(t - 0.2));
boom(1.5, 0.9);                       // logo slam
whoosh(6.4, 0.6, 0.3); boom(6.5, 0.4); // world flips
for (let t = 12.5; t < 13.5; t += 0.1) shot(t);
shatter(13.5); shatter(14.6); shatter(14.9);
ding(15.2, 0.15); ding(15.35, 0.15); // crown
// coins
for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) ding(16.5 + 1.6 + i * 0.3 + j * 0.12 + 0.5, 0.1);
click(16.5 + 4.6, 0.4); ding(16.5 + 4.65, 0.15);
// bridge pieces
for (let i = 0; i < 14; i++) click(22.5 + 0.2 + i * 0.22, 0.22);
whoosh(22.5 + 3.85, 0.5, 0.25);
// fights
shot(28 + 0.25, 0.35);
click(28 + 0.95, 0.3);
boom(28 + 5 / 3 + 0.3, 0.8);
click(28 + 10 / 3 + 0.2, 0.3); whoosh(28 + 10 / 3 + 0.5, 0.6, 0.25);
// controls rows
for (let i = 0; i < 5; i++) click(33 + 0.3 + i * 0.32, 0.25);
boom(37, 0.6);

// ---- master: fade, soft clip, 16-bit WAV
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const x = i / SR, fade = Math.min(1, x / 0.05, (T - x) / 1.2);
  const l = Math.tanh(L[i] / peak * 1.6) * 0.9 * fade, r = Math.tanh(R[i] / peak * 1.6) * 0.9 * fade;
  buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
}
mkdirSync(join(here, 'out'), { recursive: true });
writeFileSync(join(here, 'out', 'music.wav'), buf);
console.log('music.wav written');
