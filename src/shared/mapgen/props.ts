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

export function car(b: Builder, f: Frame, x: number, z: number, yaw: number, color: number, y0 = 0) {
  const c = f.sub(x, y0 + 0.02, z, yaw);
  b.box(c, 0, 0.75, 0, 0.95, 0.42, 2.15, color, 'car');
  b.box(c, 0, 1.5, 0.15, 0.82, 0.33, 1.15, 0x2a3440, 'glass');
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    b.box(c, sx * 0.9, 0.33, sz * 1.35, 0.12, 0.33, 0.33, 0x18181a, 'metal', false);
  for (const sx of [-1, 1]) {
    b.box(c, sx * 0.6, 0.85, -2.17, 0.22, 0.07, 0.025, 0xfff2c8, 'glow', false);
    b.box(c, sx * 0.6, 0.85, 2.17, 0.22, 0.07, 0.025, 0xc81e1e, 'paint', false);
  }
}

export function bus(b: Builder, f: Frame, x: number, z: number, yaw: number, color: number) {
  const c = f.sub(x, 0.02, z, yaw);
  b.box(c, 0, 1.75, 0, 1.25, 1.35, 5.8, color, 'car');
  b.box(c, 0, 0.42, 0, 1.2, 0.12, 5.7, 0x2a2a2e, 'metal', false); // skirt
  for (const s of [-1, 1]) b.box(c, s * 1.27, 2.15, 0.4, 0.025, 0.55, 4.9, 0x24303a, 'glass', false);
  b.box(c, 0, 2.05, -5.83, 1.1, 0.75, 0.03, 0x24303a, 'glass', false); // windscreen
  b.box(c, 0, 2.95, -5.84, 0.8, 0.14, 0.03, 0xffb43a, 'glow', false); // route sign
  b.box(c, 0, 3.13, 0, 1.15, 0.03, 5.6, 0xe9e5dc, 'paint', false); // roof
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    b.box(c, sx * 1.15, 0.45, sz * 3.9, 0.16, 0.45, 0.45, 0x18181a, 'metal', false);
}

export function lamp(b: Builder, f: Frame, x: number, z: number, yaw: number, y0 = SW) {
  const l = f.sub(x, y0, z, yaw);
  b.block(l, 0, 0, 0, 0.07, 2.5, 0.07, 0x2f3a33, 'metal');
  b.box(l, 0, 4.95, 0.6, 0.05, 0.05, 0.6, 0x2f3a33, 'metal', false);
  b.box(l, 0, 4.85, 1.15, 0.18, 0.08, 0.3, 0xfff1cf, 'glow', false);
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
