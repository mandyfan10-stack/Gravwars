import { Rng } from '../math';
import { Builder, Frame, MatKind } from './core';
import { CAR_COLORS, car, CRATE_COLORS, pipe, STOREY } from './props';

/**
 * Enterable buildings, built from boxes: floor slabs every 3 m (one build level), a switchback stair core in one
 * corner (a 3 m wide ramp per storey, alternating between two lanes, through a hole in the slab above), doors at
 * street level, rooms with partitions, furniture and crates, a roof you can walk on.
 */

/** Floor slab thickness. */
const SLAB = 0.4;
/** Ground floor top above the sidewalk. */
const GF = 0.05;
/** Glazing thickness. */
const GLASS_T = 0.12;
const DOOR_W = 2.6;
const DOOR_H = 2.6;

export type BuildingStyle = 'tower' | 'office' | 'garage' | 'skeleton' | 'museum';

export interface BuildingSpec {
  /** Footprint centre (frame-local), size along the building's own x / z (≥ 12). */
  cx: number;
  cz: number;
  w: number;
  d: number;
  floors: number;
  /** Ground level (sidewalk top). */
  y0: number;
  /** Turn of the layout (multiples of π/2): the stair core sits at the building's +x / -z corner, doors on ±z. */
  yaw: number;
  style: BuildingStyle;
  /** Slab / column colour and glazing tint. */
  frame: number;
  glass: number;
}

/** Floor rectangle minus a rectangular hole (up to four boxes). */
function holed(b: Builder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number,
  hole: [number, number, number, number] | null, color: number, mat: MatKind) {
  if (!hole) { b.span(f, x0, y0, z0, x1, y1, z1, color, mat); return; }
  const [hx0, hx1, hz0, hz1] = hole;
  b.span(f, x0, y0, z0, hx0, y1, z1, color, mat);
  b.span(f, hx1, y0, z0, x1, y1, z1, color, mat);
  b.span(f, hx0, y0, z0, hx1, y1, hz0, color, mat);
  b.span(f, hx0, y0, hz1, hx1, y1, z1, color, mat);
}

/** Hole rectangle (x0, x1, z0, z1) of the run of a stair lane. */
type Rect = [number, number, number, number];

/**
 * Stair core: lanes [lx0, lx0 + 3] and [lx0 + 3, lx0 + 6] (`lanes` = 1: only the first), runs along z over
 * [r0, r0 + 6]. Storey L climbs in lane L % lanes, rising +z on even storeys, -z on odd ones. Returns, per level
 * 1..storeys, the hole that level's slab needs (over the ramp arriving at it).
 */
function stairs(b: Builder, f: Frame, lx0: number, r0: number, storeys: number, lanes: 1 | 2, base: number, color: number): Rect[] {
  const holes: Rect[] = [];
  for (let L = 0; L < storeys; L++) {
    const lane = L % lanes;
    const x0 = lx0 + lane * 3, x1 = x0 + 3;
    const y0 = base + L * STOREY, y1 = y0 + STOREY;
    const up = lanes === 1 || L % 2 === 0;
    const lo = up ? r0 : r0 + 6, hi = up ? r0 + 6 : r0;
    b.hull(f, [[x0, y0, lo], [x1, y0, lo], [x0, y0, hi], [x1, y0, hi], [x0, y1, hi], [x1, y1, hi]], color, 'concrete');
    holes.push([x0, x1, Math.min(lo, hi), Math.max(lo, hi)]);
  }
  return holes;
}

/**
 * Wall along local x at depth zc (thickness t) from x0 to x1, height y0..y1, with openings (doors, windows):
 * the solid parts are split into vertical strips between the openings' edges. Windows get see-through glazing.
 */
export function wallWithHoles(b: Builder, f: Frame, x0: number, x1: number, y0: number, y1: number, zc: number, t: number,
  holes: { x0: number; x1: number; y0: number; y1: number; glass?: boolean }[], color: number, mat: MatKind, glass = 0x9ab3b8) {
  const xs = [...new Set([x0, x1, ...holes.flatMap((h) => [h.x0, h.x1])])].filter((x) => x >= x0 && x <= x1).sort((a, c) => a - c);
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i], c = xs[i + 1];
    const cover = holes.filter((h) => h.x0 <= a + 1e-6 && h.x1 >= c - 1e-6).sort((p, q) => p.y0 - q.y0);
    let y = y0;
    for (const h of cover) {
      b.span(f, a, y, zc - t / 2, c, Math.max(y, h.y0), zc + t / 2, color, mat);
      y = Math.max(y, h.y1);
    }
    b.span(f, a, y, zc - t / 2, c, y1, zc + t / 2, color, mat);
  }
  for (const h of holes) if (h.glass) b.span(f, h.x0, h.y0, zc - 0.03, h.x1, h.y1, zc + 0.03, glass, 'window');
}

/** Furniture and crates for one storey (free area x ∈ [ax0, ax1], z ∈ [az0, az1], floor at y). */
function furnish(b: Builder, f: Frame, rng: Rng, ax0: number, ax1: number, az0: number, az1: number, y: number,
  kind: 'office' | 'store' | 'museum', keep: (x: number, z: number) => boolean) {
  for (let k = 0, n = rng.int(1, 3); k < n; k++) {
    const x = rng.range(ax0 + 1.2, ax1 - 1.2), z = rng.range(az0 + 1.2, az1 - 1.2);
    if (keep(x, z)) continue;
    if (kind === 'museum') {
      // an exhibit on a plinth
      b.block(f, x, y, z, 0.6, 0.45, 0.6, 0xe8e4dc, 'stone');
      b.block(f, x, y + 0.9, z, 0.22, rng.range(0.3, 0.7), 0.22, rng.pick([0x6a5040, 0x9a958c, 0xb8862e]), 'metal');
    } else if (kind === 'office' && rng.chance(0.6)) {
      // desk with a monitor
      b.block(f, x, y, z, 0.8, 0.37, 0.42, 0x8a6e52, 'wood');
      b.block(f, x, y + 0.74, z - 0.15, 0.28, 0.2, 0.03, 0x1f2226, 'metal', false);
    } else b.crate(f, x, y, z, rng.pick([0.4, 0.5, 0.6]), rng.range(0, Math.PI), rng.pick(CRATE_COLORS));
  }
}

/**
 * A multi-storey building (tower, office, museum: glazed; garage: open decks with parapets; skeleton: a bare frame
 * under construction). See BuildingSpec.
 */
export function building(b: Builder, parent: Frame, rng: Rng, s: BuildingSpec) {
  const f = parent.sub(s.cx, s.y0, s.cz, s.yaw);
  const X = s.w / 2, Z = s.d / 2;
  const glazed = s.style === 'tower' || s.style === 'office' || s.style === 'museum';
  const inset = glazed ? GLASS_T : 0;
  const XI = X - inset, ZI = Z - inset;
  const N = s.floors;
  const top = GF + N * STOREY;
  const roofless = s.style === 'skeleton';
  // stair core in the +x / -z corner
  const lx0 = XI - 6;
  const core = Math.min(12, 2 * ZI);
  const r0 = -ZI + (core - 6) / 2;
  const lanes: 1 | 2 = N > 1 ? 2 : 1;
  const climbs = roofless ? N - 1 : N; // a skeleton has no roof to climb onto
  const holes = stairs(b, f, lx0, r0, climbs, lanes, GF, s.style === 'skeleton' ? 0xb9b4a8 : 0xc9c4b8);
  const doorX = -3;
  const keepClear = (x: number, z: number) =>
    (x > lx0 - 1.5 && z < -ZI + core + 1.5) // stair core
    || (Math.abs(x - doorX) < DOOR_W / 2 + 1 && Math.abs(z) > ZI - 3.5) // door corridors
    || Math.abs(x - doorX) < 1.6; // the way between the doors

  // ground floor
  b.span(f, -X, -0.1, -Z, X, GF, Z, s.style === 'garage' || s.style === 'skeleton' ? 0x8f8a82 : 0xb9b2a6,
    s.style === 'garage' || s.style === 'skeleton' ? 'concrete' : 'paving');
  // slabs (the top one is the roof), each with the hole of the ramp arriving at it
  const edge = glazed ? 0.1 : 0;
  for (let L = 1; L <= N; L++) {
    if (roofless && L === N) break;
    const y = GF + L * STOREY;
    holed(b, f, -X - edge, X + edge, -Z - edge, Z + edge, y - SLAB, y, holes[L - 1] ?? null, s.frame, 'concrete');
  }

  // columns: corners (+ mid points on long sides of the open styles)
  const colTop = roofless ? top - STOREY : top;
  const cols: [number, number][] = [[-X, -Z], [X, -Z], [-X, Z], [X, Z]];
  if (!glazed) for (const sx of [-1, 1]) for (let z = -Z + 6; z < Z - 1; z += 6) cols.push([sx * X, z]);
  for (const [x, z] of cols) {
    const cx = x - Math.sign(x) * 0.25, cz = z === -Z || z === Z ? z - Math.sign(z) * 0.25 : z;
    b.span(f, cx - 0.25, GF, cz - 0.25, cx + 0.25, colTop, cz + 0.25, s.style === 'tower' ? 0x5b6168 : s.frame, s.style === 'tower' ? 'metal' : 'concrete');
  }

  // facades
  for (let k = 0; k < 4; k++) {
    const yaw = (k * Math.PI) / 2;
    const side = f.sub(0, 0, 0, yaw); // the side's outward normal is its local +z
    const len = k % 2 === 0 ? X : Z; // half length of this side
    const depth = k % 2 === 0 ? Z : X;
    const door = k % 2 === 0; // doors on the building's ±z sides
    // door x along this side: the side's local x is the building's x for k = 0, -x for k = 2
    const dx = k === 0 ? doorX : -doorX;
    if (glazed) {
      const zc = depth - GLASS_T / 2;
      const a0 = -len + 0.5, a1 = len - 0.5;
      if (door) {
        b.span(side, a0, 0, zc - GLASS_T / 2, dx - DOOR_W / 2, GF + DOOR_H, zc + GLASS_T / 2, s.glass, 'window');
        b.span(side, dx + DOOR_W / 2, 0, zc - GLASS_T / 2, a1, GF + DOOR_H, zc + GLASS_T / 2, s.glass, 'window');
        b.span(side, a0, GF + DOOR_H, zc - GLASS_T / 2, a1, top - SLAB, zc + GLASS_T / 2, s.glass, 'window');
        // door frame + canopy
        for (const e of [-1, 1]) b.span(side, dx + e * DOOR_W / 2 - 0.08, GF, zc - 0.1, dx + e * DOOR_W / 2 + 0.08, GF + DOOR_H, zc + 0.1, 0x2f3236, 'metal', false);
        b.span(side, dx - DOOR_W / 2 - 0.6, GF + DOOR_H + 0.25, depth, dx + DOOR_W / 2 + 0.6, GF + DOOR_H + 0.4, depth + 1.4, 0x3a3d40, 'metal', false);
      } else b.span(side, a0, 0, zc - GLASS_T / 2, a1, top - SLAB, zc + GLASS_T / 2, s.glass, 'window');
    } else {
      // open decks: a parapet on every level above the street (none on the ground floor: you walk in anywhere)
      for (let L = 1; L <= N; L++) {
        if (roofless) break;
        const y = GF + L * STOREY;
        b.span(side, -len + 0.5, y, depth - 0.25, len - 0.5, y + 1, depth, s.frame, 'concrete');
      }
    }
  }
  // roof: parapet, rail around the stair hole, machinery
  if (!roofless) {
    if (glazed) for (let k = 0; k < 4; k++) {
      const side = f.sub(0, 0, 0, (k * Math.PI) / 2);
      const len = k % 2 === 0 ? X : Z, depth = k % 2 === 0 ? Z : X;
      b.span(side, -len, top, depth - 0.3, len, top + 1, depth + 0.1, s.frame, 'concrete');
    }
    const h = holes[N - 1];
    if (h) {
      // rails on the hole's long sides (the open end is where the ramp arrives; the facade side has the parapet)
      b.span(f, h[0] - 0.1, top, h[2], h[0], top + 1, h[3], 0x2f3236, 'metal');
      if (h[1] < XI - 0.5) b.span(f, h[1], top, h[2], h[1] + 0.1, top + 1, h[3], 0x2f3236, 'metal');
      const far = N % 2 === 1 ? h[2] : h[3]; // the low end of the last ramp: closed
      b.span(f, h[0], top, far - 0.05, h[1], top + 1, far + 0.05, 0x2f3236, 'metal');
    }
    if (s.style !== 'garage') {
      b.block(f, -X / 2, top, Z / 2, 1.4, 0.8, 1.1, 0x9a9da2, 'metal');
      if (rng.chance(0.5)) pipe(b, f, [-X / 2 + 2, top, Z / 2 - 2], [-X / 2 + 2, top + 2.6, Z / 2 - 2], 0.3, 0x8a8f96);
    }
    if (s.style === 'tower') b.block(f, -X / 2, top + 1.6, Z / 2, 0.2, 3, 0.2, 0x5b6168, 'metal', false);
  }

  // inside: a ceiling light, a partition with a doorway, furniture and crates on every storey
  for (let L = 0; L < N; L++) {
    const y = GF + L * STOREY;
    const ceil = y + STOREY - SLAB;
    if (s.style !== 'skeleton')
      b.span(f, doorX - 0.15, ceil - 0.05, -ZI + 1.5, doorX + 0.15, ceil - 0.03, ZI - 1.5, 0xfff4dc, 'glow', false);
    if (glazed && s.d >= 18 && L > 0) {
      const zp = -ZI + core;
      wallWithHoles(b, f, -XI, lx0, y, y + STOREY - SLAB, zp + 0.1, 0.2, [{ x0: doorX - 1, x1: doorX + 1, y0: y, y1: y + 2.3 }], 0xe4dfd4, 'plaster');
    }
    if (s.style === 'garage') {
      if (L > 0) for (let k = 0, n = rng.int(1, 3); k < n; k++) {
        const x = -XI + 3 + k * 3.2;
        if (x > lx0 - 2) break;
        car(b, f, x, ZI - 3.2, rng.chance(0.5) ? 0 : Math.PI, rng.pick(CAR_COLORS), y);
      }
    } else if (s.style !== 'skeleton' || L < N - 1)
      furnish(b, f, rng, -XI, XI, -ZI, ZI, y, s.style === 'museum' ? 'museum' : s.style === 'skeleton' ? 'store' : 'office', keepClear);
  }
  if (s.style === 'skeleton') {
    // scaffolding along the -x side and rebar sticking out of the unfinished top
    const sx = -X - 1.2;
    for (let z = -Z; z <= Z; z += 3) pipe(b, f, [sx, 0, z], [sx, top - STOREY + 1, z], 0.06, 0x8a8f96, false);
    for (let L = 1; L < N; L++) b.span(f, sx - 0.6, GF + L * STOREY - 0.1, -Z, sx + 0.6, GF + L * STOREY, Z, 0x8f6a42, 'wood');
    for (const [x, z] of cols) for (let k = 0; k < 3; k++)
      b.box(f, x - Math.sign(x) * (0.15 + k * 0.1), colTop + 0.6, z - Math.sign(z || 1) * 0.15, 0.02, 0.6, 0.02, 0x5a4a3c, 'metal', false);
  }
}

/**
 * Old-town house: two storeys under a tiled gable roof (ridge along local x), plaster walls with real windows and a
 * door, a straight ramp up to the upper floor. Footprint w × d centred at (cx, cz), ground at y0.
 */
export function house(b: Builder, parent: Frame, rng: Rng, cx: number, cz: number, w: number, d: number, yaw: number, y0: number,
  wall: number, roof: number) {
  const f = parent.sub(cx, y0, cz, yaw);
  const X = w / 2, Z = d / 2, T = 0.25;
  const XI = X - T, ZI = Z - T;
  const top = GF + 2 * STOREY;
  b.span(f, -X, -0.1, -Z, X, GF, Z, 0xa58a6a, 'wood');
  // upper floor with the stair hole; the ramp along the +x wall
  const [hole] = stairs(b, f, XI - 3, -3, 1, 1, GF, 0xb8a888);
  holed(b, f, -XI, XI, -ZI, ZI, GF + STOREY - 0.3, GF + STOREY, hole, 0x9c7e5c, 'wood');
  // walls: door in front (-z side), windows everywhere else
  for (let k = 0; k < 4; k++) {
    const side = f.sub(0, 0, 0, (k * Math.PI) / 2);
    const len = k % 2 === 0 ? X : Z - T, depth = k % 2 === 0 ? Z : X; // the ±z walls cover the corners
    const holes: { x0: number; x1: number; y0: number; y1: number; glass?: boolean }[] = [];
    for (let L = 0; L < 2; L++) {
      const y = GF + L * STOREY;
      if (k === 2 && L === 0) {
        holes.push({ x0: -2.6, x1: -0.6, y0: GF, y1: GF + 2.4 }); // door
        holes.push({ x0: 1, x1: 2.8, y0: y + 1, y1: y + 2.3, glass: true });
      } else {
        const wx = rng.pick([-len / 2, 0, len / 2]);
        holes.push({ x0: wx - 0.9, x1: wx + 0.9, y0: y + 1, y1: y + 2.3, glass: true });
      }
    }
    wallWithHoles(b, side, -len, len, 0, top, depth - T / 2, T, holes, wall, 'plaster');
    // window sills / a door canopy
    for (const h of holes) if (h.glass) b.span(side, h.x0 - 0.1, h.y0 - 0.08, depth, h.x1 + 0.1, h.y0, depth + 0.15, 0xe8e2d4, 'stone', false);
  }
  // roof: a tiled prism with a little overhang (its triangles are the gables)
  const rh = rng.range(2.2, 3.2);
  b.hull(f, [[-X - 0.3, top, -Z - 0.45], [X + 0.3, top, -Z - 0.45], [-X - 0.3, top, Z + 0.45], [X + 0.3, top, Z + 0.45],
    [-X - 0.3, top + rh, 0], [X + 0.3, top + rh, 0]], roof, 'tile');
  // lamps inside and a few things on both floors
  for (let L = 0; L < 2; L++) {
    const y = GF + L * STOREY;
    b.span(f, -1.5, y + STOREY - 0.36, -0.15, 1.5, y + STOREY - 0.33, 0.15, 0xfff0d0, 'glow', false);
    if (rng.chance(0.7)) b.crate(f, -XI + 1, y, ZI - 1, 0.45, rng.range(0, 1), rng.pick(CRATE_COLORS));
    if (rng.chance(0.6)) b.block(f, -XI + 1.6, y, -ZI + 3.5, 0.9, 0.38, 0.5, 0x7a5a3a, 'wood');
  }
}
