import { generateMap } from '../../src/shared/map';
const m = generateMap();
const c = m.boxes.filter(b => b.collide);
const by: Record<string, number> = {};
for (const b of c) { const k = `${b.mat}`; by[k] = (by[k] ?? 0) + 1; }
console.log('colliding boxes', c.length, by);
const small = c.filter(b => Math.max(...b.half) < 0.6);
const sb: Record<string, number> = {};
for (const b of small) sb[b.mat] = (sb[b.mat] ?? 0) + 1;
console.log('small (<0.6 half)', small.length, sb);
console.log('hulls colliding', m.hulls.filter(h => h.collide).length, 'crates', m.crates.length, 'trees', m.trees.length);
