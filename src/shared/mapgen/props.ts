import { Vector3 } from 'three';
import { Rng } from '../math';
import { Builder, Frame, V3 } from './core';

/** Sidewalk height. */
export const SW = 0.15;
/**
 * City grid of a face: tiles of TILE metres, each a block of half size BLOCK ringed by half a road (12 m roads).
 * Everything is a multiple of the 6 m build cell, so the streets line up with the build grid.
 */
export const TILE = 36;
export const BLOCK = 12;
/** Storey height = one build level. */
export const STOREY = 3;

export const WALL_COLORS = [0xe8dcc0, 0xdcc9a0, 0xe3b48f, 0xc98f6e, 0x9fc4b8, 0x7fb0a8, 0xb9c98f, 0xe6d27a, 0xd99a8a, 0xcfd3cf, 0xa9c2d6];
export const ROOF_COLORS = [0xc8643a, 0xb5532f, 0xd47a45, 0xa94a30, 0xc06a48, 0x9c5a3c];
export const CAR_COLORS = [0xd9d9d9, 0x2a2a2e, 0xb3261e, 0x2b5cad, 0xe0b020, 0x3a7d44, 0x8a8f99, 0xf2f2f2];
export const BUS_COLORS = [0xd8a531, 0x3a78b8, 0xc4442f, 0x3f8f5a];
export const CONTAINER_COLORS = [0xb5482f, 0x2f6fa3, 0x3f7f4a, 0xc58b2a, 0x7a7f86];
export const FRAME_COLORS = [0xd8cdb6, 0xc9c0ad, 0xbfc6c4, 0xd2c2a4, 0xb8bcc2, 0x9a9da2];
export const GLASS_COLORS = [0x6f9fb4, 0x7fa7a0, 0x8e9fb8, 0x5f8a9e, 0x9ab3b8];
export const CRATE_COLORS = [0xa0764a, 0x8f6a42, 0xb08458, 0x7d5b3a];

/**
 * Car body sizes (front = local -Z): half length, lights height, and the cabin (z range, roof). The model is drawn
 * by the client (render/models.ts) to the same numbers; here only colliders and lights.
 */
export const CAR_SHAPES: Record<'sedan' | 'hatch' | 'van', { half: number; light: number; belt: number; roof: number; cabin: [number, number] }> = {
  sedan: { half: 2.15, light: 0.78, belt: 0.98, roof: 1.48, cabin: [-0.7, 1.35] },
  hatch: { half: 1.9, light: 0.8, belt: 1.0, roof: 1.52, cabin: [-0.55, 1.75] },
  van: { half: 2.2, light: 0.85, belt: 1.12, roof: 1.98, cabin: [-1.45, 2.2] },
};
const CAR_KINDS = ['sedan', 'sedan', 'hatch', 'van'] as const;

export function car(b: Builder, f: Frame, x: number, z: number, yaw: number, color: number, y0 = 0) {
  const c = f.sub(x, y0 + 0.02, z, yaw);
  // the kind follows from where it is parked (no extra random draws: the rest of the map stays the same)
  const kind = CAR_KINDS[Math.abs(Math.round(x * 3.1 + z * 7.3 + color)) % CAR_KINDS.length];
  const s = CAR_SHAPES[kind];
  b.decor(c, kind, 0, 0, 0, 0, color);
  b.solid(c, 0, 0.05, 0, 0.95, (s.belt - 0.05) / 2, s.half);
  b.solid(c, 0, s.belt, (s.cabin[0] + s.cabin[1]) / 2, 0.82, (s.roof - s.belt) / 2, (s.cabin[1] - s.cabin[0]) / 2);
  for (const sx of [-1, 1]) {
    b.box(c, sx * 0.62, s.light, -s.half - 0.01, 0.2, 0.06, 0.025, 0xfff2c8, 'glow', false);
    b.box(c, sx * 0.66, s.light + 0.04, s.half + 0.01, 0.16, 0.06, 0.025, 0xc81e1e, 'paint', false);
  }
}

/** City bus: 11.6 m, front = local -Z. */
export function bus(b: Builder, f: Frame, x: number, z: number, yaw: number, color: number) {
  const c = f.sub(x, 0.02, z, yaw);
  b.decor(c, 'bus', 0, 0, 0, 0, color);
  b.solid(c, 0, 0.05, 0, 1.25, 1.55, 5.8);
  b.box(c, 0, 2.95, -5.88, 0.8, 0.13, 0.03, 0xffb43a, 'glow', false); // route sign
  for (const sx of [-1, 1]) {
    b.box(c, sx * 0.95, 0.75, -5.88, 0.18, 0.08, 0.03, 0xfff2c8, 'glow', false);
    b.box(c, sx * 1.0, 0.9, 5.82, 0.12, 0.12, 0.03, 0xc81e1e, 'paint', false);
  }
}

/** Street lamp: a 5 m pole with the light hanging over the road 1.2 m out (local +Z). */
export function lamp(b: Builder, f: Frame, x: number, z: number, yaw: number, y0 = SW) {
  const l = f.sub(x, y0, z, yaw);
  b.decor(l, 'lamp', 0, 0, 0, 0, 0x2f3a33);
  b.solid(l, 0, 0, 0, 0.09, 2.5, 0.09);
  b.box(l, 0, 4.83, 1.22, 0.17, 0.025, 0.11, 0xfff1cf, 'glow', false);
}

export function bench(b: Builder, f: Frame, x: number, z: number, yaw: number, y0 = SW) {
  const c = f.sub(x, y0, z, yaw);
  b.block(c, 0, 0.42, 0, 0.85, 0.04, 0.24, 0x8a5a36, 'wood');
  b.block(c, 0, 0.55, -0.24, 0.85, 0.2, 0.03, 0x8a5a36, 'wood', false);
  for (const s of [-1, 1]) b.block(c, s * 0.7, 0, 0, 0.04, 0.21, 0.22, 0x2a2d30, 'metal', false);
}

export function bin(b: Builder, f: Frame, x: number, z: number, y0 = SW) {
  b.block(f, x, y0, z, 0.28, 0.45, 0.28, 0x3c5a44, 'metal');
  b.block(f, x, y0 + 0.9, z, 0.3, 0.03, 0.3, 0x2a2d30, 'metal', false);
}

export function cone(b: Builder, f: Frame, x: number, z: number, y0 = 0) {
  b.hull(f, [[x - 0.2, y0, z - 0.2], [x + 0.2, y0, z - 0.2], [x - 0.2, y0, z + 0.2], [x + 0.2, y0, z + 0.2], [x, y0 + 0.7, z]], 0xff7a1a, 'paint', false);
}

/** Concrete jersey barrier, 2 m long along local X after yaw. */
export function barrier(b: Builder, f: Frame, x: number, z: number, yaw: number, y0 = 0) {
  const c = f.sub(x, y0, z, yaw);
  const pts: number[][] = [];
  for (const sx of [-1, 1]) pts.push([sx, 0, -0.32], [sx, 0, 0.32], [sx, 0.25, -0.3], [sx, 0.25, 0.3], [sx, 0.85, -0.12], [sx, 0.85, 0.12]);
  b.hull(c, pts, 0xc9c4b8, 'concrete');
}

/** Octagonal pipe from a to b (local points), radius r. */
export function pipe(b: Builder, f: Frame, a: V3, c: V3, r: number, color = 0x8a8f96, collide = true) {
  const A = new Vector3(...a), B = new Vector3(...c);
  const d = B.clone().sub(A).normalize();
  const u = Math.abs(d.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const s1 = new Vector3().crossVectors(d, u).normalize();
  const s2 = new Vector3().crossVectors(d, s1).normalize();
  const pts: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const o = s1.clone().multiplyScalar(Math.cos(ang) * r).addScaledVector(s2, Math.sin(ang) * r);
    pts.push(A.clone().add(o).toArray(), B.clone().add(o).toArray());
  }
  b.hull(f, pts, color, 'metal', collide);
}

/** Shipping container, 6 m long along local Z after yaw. */
export function container(b: Builder, f: Frame, x: number, y0: number, z: number, yaw: number, color: number) {
  const c = f.sub(x, y0, z, yaw);
  b.block(c, 0, 0, 0, 1.22, 1.3, 3.05, color, 'paint');
  for (let k = -2; k <= 2; k++) for (const s of [-1, 1]) b.block(c, s * 1.25, 0.05, k * 1.2, 0.03, 1.2, 0.08, color, 'paint', false);
  b.block(c, 0, 0.05, 3.08, 1.1, 1.2, 0.03, 0x3a3d40, 'metal', false);
}

export function busStop(b: Builder, f: Frame, x: number, z: number, yaw: number) {
  const c = f.sub(x, SW, z, yaw);
  for (const s of [-1, 1]) b.block(c, s * 1.6, 0, -0.5, 0.05, 1.25, 0.05, 0x2a2d30, 'metal');
  b.block(c, 0, 2.5, -0.1, 1.8, 0.06, 0.75, 0x2a2d30, 'metal', false);
  b.block(c, 0, 0.3, -0.65, 1.55, 1.1, 0.02, 0xa9c4cc, 'glass', false);
  bench(b, c, 0, -0.25, 0, 0);
  b.block(c, 1.95, 0, 0.3, 0.04, 1.5, 0.04, 0x2a2d30, 'metal', false);
  b.box(c, 1.95, 3.2, 0.3, 0.22, 0.22, 0.03, 0x2b8a4a, 'paint', false);
}

export function hydrant(b: Builder, f: Frame, x: number, z: number) {
  b.block(f, x, SW, z, 0.14, 0.38, 0.14, 0xc8352a, 'paint');
}

/** A small heap of crates (and sometimes a barrel) around (x, z) on height y0. */
export function crates(b: Builder, f: Frame, rng: Rng, x: number, y0: number, z: number) {
  const h0 = rng.pick([0.5, 0.6]);
  b.crate(f, x, y0, z, h0, rng.range(-0.3, 0.3), rng.pick(CRATE_COLORS));
  if (rng.chance(0.5)) b.crate(f, x + rng.range(-0.1, 0.1), y0 + 2 * h0, z + rng.range(-0.1, 0.1), 0.4, rng.range(0, Math.PI), rng.pick(CRATE_COLORS));
  for (let k = 0, n = rng.int(0, 2); k < n; k++) {
    const a = rng.range(0, Math.PI * 2);
    b.crate(f, x + Math.cos(a) * 1.5, y0, z + Math.sin(a) * 1.5, rng.pick([0.35, 0.45]), rng.range(0, Math.PI), rng.pick(CRATE_COLORS));
  }
  if (rng.chance(0.35)) b.barrel(f, x + rng.pick([-1.8, 1.8]), y0, z + rng.range(-0.6, 0.6), rng.pick([0x2f6fa3, 0xb5482f, 0x3f7f4a, 0x6a6d74]));
}
