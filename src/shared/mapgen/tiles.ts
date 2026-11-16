import { PLAYER_HEIGHT } from '../constants';
import { Rng } from '../math';
import type { TeamDef } from '../teams';
import type { BlockMaterial } from '../blocks';
import { building, house } from './buildings';
import { Builder, Frame, StatueDef } from './core';
import {
  BLOCK, bench, bus, BUS_COLORS, busStop, CAR_COLORS, car, cone, container, CONTAINER_COLORS, crates, fountain,
  FRAME_COLORS, GLASS_COLORS, pipe, ROOF_COLORS, STOREY, SW, WALL_COLORS,
} from './props';

/** Random city sections, plus the special tiles of team faces (hall) and neutral faces (square, market, museum). */
export type TileKind = 'tower' | 'office' | 'houses' | 'park' | 'pond' | 'greenpond'
  | 'parking' | 'construction' | 'plaza' | 'museum' | 'abyss' | 'pipes' | 'pipeline'
  | 'bar' | 'store' | 'court' | 'hall' | 'square' | 'market';
export interface Tile { i: number; j: number; kind: TileKind }

/** Pond of a tile, relative to the tile centre: centre offset and half size. */
export const PONDS: Partial<Record<TileKind, { dx: number; dz: number; hx: number; hz: number }>> = {
  park: { dx: 3, dz: 2, hx: 4.5, hz: 3.5 },
  pond: { dx: 0, dz: 1, hx: 8, hz: 6 },
  greenpond: { dx: 0, dz: 0, hx: 9.5, hz: 9.5 },
};
export const pondRect = (kind: TileKind, cx: number, cz: number) => {
  const p = PONDS[kind]!;
  return { x0: cx + p.dx - p.hx, x1: cx + p.dx + p.hx, z0: cz + p.dz - p.hz, z1: cz + p.dz + p.hz };
};

/** Through-slab chasm pit carved into the void (`abyss` and `pipes`). */
export const ABYSS: Partial<Record<TileKind, { dx: number; dz: number; hx: number; hz: number }>> = {
  abyss: { dx: 0, dz: 0, hx: 8.5, hz: 8.5 },
  pipes: { dx: 0, dz: 0, hx: 8.5, hz: 8.5 },
};
export const abyssRect = (kind: TileKind, cx: number, cz: number) => {
  const a = ABYSS[kind]!;
  return { x0: cx + a.dx - a.hx, x1: cx + a.dx + a.hx, z0: cz + a.dz - a.hz, z1: cz + a.dz + a.hz };
};

/** Tiles whose block is not a uniform paved sidewalk (their own ground or open pit). */
export const OWN_GROUND = new Set<TileKind>(['park', 'pond', 'greenpond', 'parking', 'abyss', 'pipes', 'court']);

/** Neutral shops' colour. */
export const NEUTRAL = 0x4f7f9f;

const yawOf = (rng: Rng) => rng.int(0, 3) * (Math.PI / 2);

// --- random sections --------------------------------------------------------------------------

/** Tall skyscraper: high-ceilinged glazed storeys (capped automatically under `maxH` including roof spire). */
function tileTower(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, maxH?: number) {
  const spireReserve = 8.4; // roof equipment (1.6 m) + 6 m tower spire + curb/SW margin
  const storeyH = maxH ? 3.2 : STOREY * 2.5;
  const maxFloors = maxH ? Math.max(2, Math.floor((maxH - spireReserve) / storeyH)) : 7;
  const floors = maxH ? Math.min(3, maxFloors) : rng.int(5, 7);
  building(b, f, rng, {
    cx, cz, w: 18, d: 18, floors, storeyH, y0: SW, yaw: yawOf(rng), style: 'tower',
    frame: rng.pick([0x9aa3a8, 0xb8bcc2, 0x7d868c]), glass: rng.pick(GLASS_COLORS),
  });
  for (const s of [-1, 1]) b.tree(f, cx + s * 10.5, SW, cz - 10.5, rng.range(0.6, 0.8), 'bush');
}

/** Office block: 3–6 storeys (clamped if `maxH` is set), sometimes with a courtyard of crates behind it. */
function tileOffice(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, maxH?: number) {
  const wide = rng.chance(0.5);
  const yaw = rng.chance(0.5) ? 0 : Math.PI;
  const maxFloors = maxH ? Math.max(2, Math.floor((maxH - 2.6) / STOREY)) : 6;
  const floors = Math.min(rng.int(3, 6), maxFloors);
  building(b, f, rng, {
    cx, cz: wide ? cz : cz - 3, w: 18, d: wide ? 18 : 12, floors, y0: SW, yaw, style: 'office',
    frame: rng.pick(FRAME_COLORS), glass: rng.pick(GLASS_COLORS),
  });
  if (!wide) {
    crates(b, f, rng, cx + rng.range(-6, 6), SW, cz + 7.5);
    for (const x of [-8, 8]) b.tree(f, cx + x, SW, cz + 8, rng.range(0.7, 1), 'tree');
  }
}

/** Two or three old-town houses with yards. */
function tileHouses(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  const spots: [number, number][] = [[-6, -6], [6, -6], [-6, 6], [6, 6]];
  const n = rng.int(2, 3);
  for (let k = 0; k < 4; k++) {
    const [x, z] = spots.splice(rng.int(0, spots.length - 1), 1)[0];
    if (k < n) {
      // the door looks out of the block (towards the nearer street)
      const yaw = z < 0 ? 0 : Math.PI;
      house(b, f, rng, cx + x, cz + z, 10, 10, yaw, SW, rng.pick(WALL_COLORS), rng.pick(ROOF_COLORS));
    } else {
      // a yard: trees, a bench, crates in non-overlapping spots
      const sx = Math.sign(x), sz = Math.sign(z);
      b.block(f, cx + x, SW, cz + z, 5.5, 0.02, 5.5, 0x6f9a45, 'grass', false);
      b.tree(f, cx + x + sx * rng.range(1.0, 2.0), SW, cz + z + sz * rng.range(0.6, 1.8), rng.range(0.8, 1.15), 'tree');
      b.tree(f, cx + x - sx * rng.range(1.6, 2.6), SW, cz + z + sz * rng.range(1.6, 2.4), rng.range(0.5, 0.7), 'bush');
      bench(b, f, cx + x, cz + z + (z < 0 ? 4 : -4), z < 0 ? Math.PI : 0);
      if (rng.chance(0.6)) crates(b, f, rng, cx + x - sx * 2.5, SW, cz + z - sz * 1.5);
    }
  }
}

/** Multi-storey car park: open decks, cars on every level, a ramp core up to the roof deck. */
function tileParking(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  b.block(f, cx, 0, cz, BLOCK, SW / 2, BLOCK, 0x6e6b66, 'asphalt');
  building(b, f, rng, {
    cx, cz, w: 18, d: 18, floors: rng.int(2, 4), y0: SW, yaw: yawOf(rng), style: 'garage', frame: 0xb4aea2, glass: 0,
  });
  for (let k = 0; k < 4; k++) cone(b, f, cx + rng.range(-8.5, 8.5), cz + rng.pick([-10.5, 10.5]), SW);
  // ticket booth along the west edge, clear of the corner lamp at (-11.5, -11.5)
  const bx = cx - 10.3, bz = cz - 6.5;
  b.block(f, bx, SW, bz, 0.75, 0.525, 0.75, 0xe0d6c0, 'plaster');
  b.block(f, bx + 0.78, SW + 1.0, bz, 0.12, 0.04, 0.55, 0x3a3d40, 'metal', false);
  for (const sx of [-0.67, 0.67]) for (const sz of [-0.67, 0.67])
    b.block(f, bx + sx, SW + 1.05, bz + sz, 0.08, 0.48, 0.08, 0x2f3236, 'metal');
  b.block(f, bx, SW + 1.05, bz, 0.68, 0.48, 0.68, 0x6f9fb4, 'window');
  b.block(f, bx, SW + 2.01, bz, 0.75, 0.17, 0.75, 0xe0d6c0, 'plaster');
  b.block(f, bx, SW + 2.35, bz, 0.95, 0.08, 0.95, 0x3a3d40, 'metal', false);
}

/** Construction site: unfinished concrete skeleton, detailed solid crane (scaled under `maxH` if set), containers & materials. */
function tileConstruction(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, maxH?: number) {
  b.block(f, cx, 0, cz, BLOCK - 0.5, SW / 2 + 0.01, BLOCK - 0.5, 0x8a7356, 'dirt');
  const storeyH = maxH ? 3.8 : STOREY * 2.5;
  const floors = maxH ? Math.min(3, Math.max(2, Math.floor((maxH - 2.0) / storeyH))) : rng.int(3, 4);
  building(b, f, rng, {
    cx: cx + 3, cz: cz - 3, w: 12, d: 12, floors, storeyH, y0: SW, yaw: 0, style: 'skeleton', frame: 0xb9b4a8, glass: 0,
  });
  // fence along the street sides with gaps, inset from the corner street lamps
  for (const s of [-1, 1]) for (const a of [-8.4, -4.6, 4.6, 8.4])
    b.block(f, cx + a, SW, cz + s * 11.3, 1.7, 1.1, 0.04, 0xd9b35a, 'paint');
  container(b, f, cx - 7, SW, cz - 1.5, 0, rng.pick(CONTAINER_COLORS));
  if (rng.chance(0.5)) container(b, f, cx - 7, SW + 2.6, cz - 1.5, 0, rng.pick(CONTAINER_COLORS));
  const px = cx + 4, pz = cz + 7;
  for (let k = 0; k < 3; k++) pipe(b, f, [px - 3, SW + 0.5 + (k === 2 ? 0.85 : 0), pz + (k - 1) - (k === 2 ? 1 : 0)],
    [px + 3, SW + 0.5 + (k === 2 ? 0.85 : 0), pz + (k - 1) - (k === 2 ? 1 : 0)], 0.48, 0x7d8a92);
  crates(b, f, rng, cx - 6.6, SW, cz - 7.1);
  crates(b, f, rng, cx - 1.8, SW, cz + 6.8);
  for (let k = 0; k < 5; k++) cone(b, f, cx + rng.range(-8.5, 8.5), cz + rng.pick([-10.2, 10.2]), SW);
  // sand heap
  b.hull(f, [[cx - 9, SW, cz + 9], [cx - 5, SW, cz + 9], [cx - 9, SW, cz + 5.5], [cx - 5, SW, cz + 5.5], [cx - 7, SW + 1.6, cz + 7.2]], 0xc9a86a, 'dirt');
  // detailed tower crane with full physics colliders
  const mx = cx - 8.6, mz = cz - 8.6;
  const cr = f.sub(mx, SW, mz, -Math.PI * 0.18);
  const topY = maxH ? Math.max(9.0, maxH - 5.5) : 34.5;
  const apexH = maxH ? 3.2 : 6.4;
  const hoistDrop = Math.min(12.2, topY - 4.2);
  b.block(cr, 0, 0, 0, 1.35, 0.45, 1.35, 0x5c5f63, 'concrete'); // ballast foundation
  for (const sx of [-0.46, 0.46]) for (const sz of [-0.46, 0.46]) {
    b.block(cr, sx, 0.9, sz, 0.14, (topY - 0.9) / 2, 0.14, 0xe0b020, 'metal'); // 4 main mast chords
  }
  for (let y = 3.0; y < topY - 1; y += 3.2) {
    b.box(cr, 0, y, 0, 0.58, 0.12, 0.58, 0xd4a418, 'metal', true); // stiffening collars
  }
  // turntable + operator cab + warning beacon
  b.block(cr, 0, topY, 0, 0.72, 0.45, 0.72, 0x3b3f44, 'metal');
  b.block(cr, 0.85, topY + 0.25, 0.75, 0.55, 0.95, 0.58, 0xe0b020, 'metal');
  b.box(cr, 1.28, topY + 1.15, 0.75, 0.18, 0.65, 0.45, 0x8db6c4, 'window', true);
  // A-frame apex pinnacle
  b.hull(cr, [[-0.55, topY + 0.9, -0.55], [0.55, topY + 0.9, -0.55], [-0.55, topY + 0.9, 0.55], [0.55, topY + 0.9, 0.55], [0, topY + apexH, 0]], 0xe0b020, 'metal', true);
  b.box(cr, 0, topY + apexH + 0.25, 0, 0.16, 0.2, 0.16, 0xff3b2f, 'glow', false);
  // main jib (+x) + counter-jib (-x) + counterweights
  b.box(cr, 8.6, topY + 1.35, 0, 9.6, 0.42, 0.56, 0xe0b020, 'metal', true);
  b.box(cr, 8.6, topY + 1.82, 0, 9.5, 0.05, 0.58, 0x45494e, 'metal', true); // solid walkable catwalk top
  b.box(cr, -3.4, topY + 1.25, 0, 3.2, 0.36, 0.52, 0xe0b020, 'metal', true);
  b.block(cr, -5.1, topY + 0.95, 0, 1.25, 0.78, 0.75, 0x70747a, 'concrete'); // concrete counterweight blocks
  b.block(cr, -3.5, topY + 0.95, 0, 0.55, 0.72, 0.72, 0x82868c, 'concrete');
  // diagonal stay pipes from apex to jibs
  pipe(b, cr, [0, topY + apexH - 0.2, 0], [15.5, topY + 1.7, 0], 0.06, 0x3b3f44, false);
  pipe(b, cr, [0, topY + apexH - 0.2, 0], [-5.8, topY + 1.6, 0], 0.06, 0x3b3f44, false);
  // trolley + twin hoist cables + solid hook block + suspended steel I-beam
  const tx = 11.4;
  b.block(cr, tx, topY + 0.65, 0, 0.55, 0.25, 0.62, 0x2f3236, 'metal');
  pipe(b, cr, [tx - 0.18, topY + 0.65, 0], [tx - 0.18, topY - hoistDrop, 0], 0.035, 0x2a2d30, false);
  pipe(b, cr, [tx + 0.18, topY + 0.65, 0], [tx + 0.18, topY - hoistDrop, 0], 0.035, 0x2a2d30, false);
  b.block(cr, tx, topY - hoistDrop - 0.8, 0, 0.42, 0.4, 0.35, 0xe0b020, 'metal');
  b.block(cr, tx, topY - hoistDrop - 1.6, 0, 0.45, 0.22, 2.8, 0x626970, 'metal'); // suspended steel beam load
}

/** Grass, trees, a path with benches; `pond`: a small pond with a jetty in one corner. */
function tilePark(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, team: string, kind: 'park' | 'pond') {
  const P = pondRect(kind, cx, cz);
  const grass = 0x6f9a45;
  // grass around the sunken pond (4 slabs leave a hole), pond bottom + water surface + stone rim
  b.span(f, cx - BLOCK, 0, cz - BLOCK, cx + BLOCK, SW, P.z0, grass, 'grass');
  b.span(f, cx - BLOCK, 0, P.z1, cx + BLOCK, SW, cz + BLOCK, grass, 'grass');
  b.span(f, cx - BLOCK, 0, P.z0, P.x0, SW, P.z1, grass, 'grass');
  b.span(f, P.x1, 0, P.z0, cx + BLOCK, SW, P.z1, grass, 'grass');
  const px = (P.x0 + P.x1) / 2, pz = (P.z0 + P.z1) / 2, phx = (P.x1 - P.x0) / 2, phz = (P.z1 - P.z0) / 2;
  b.span(f, P.x0, -1, P.z0, P.x1, -0.9, P.z1, 0x5a4a38, 'dirt');
  b.span(f, P.x0, -0.26, P.z0, P.x1, -0.25, P.z1, 0x3f9fb0, 'water', false);
  for (const s of [-1, 1]) {
    b.block(f, px, -0.9, pz + s * (phz - 0.15), phx, 0.55, 0.15, 0xb8ae98, 'stone');
    b.block(f, px + s * (phx - 0.15), -0.9, pz, 0.15, 0.55, phz - 0.3, 0xb8ae98, 'stone');
  }
  b.data.ponds.push({ team, pos: f.p(px, -0.25, pz), up: f.up(), quat: f.rot(0), half: [phx, phz] });
  // wooden jetty for fishing
  b.span(f, P.x0 - 0.2, -0.15, pz - 0.8, P.x0 + 2.6, 0.05, pz + 0.8, 0x8a6240, 'wood');
  // path, benches, trees and bushes
  b.span(f, cx - BLOCK, SW, cz - 9.4, cx + BLOCK, SW + 0.03, cz - 7.6, 0xd9ccaf, 'paving', false);
  for (const x of [-6, 0, 6]) bench(b, f, cx + x, cz - 10.4, 0);
  const blocked = (x: number, z: number) =>
    (x > P.x0 - 1.8 && x < P.x1 + 1.8 && z > P.z0 - 1.8 && z < P.z1 + 1.8) // pond + jetty
    || z < cz - 6.8 // path & benches strip
    || (kind === 'pond' && x > cx + 4.2 && z > cz + 6.5); // boathouse & crates
  const placed: [number, number][] = [];
  for (let i = 0, target = kind === 'park' ? 10 : 6; i < target; i++) {
    for (let tries = 0; tries < 24; tries++) {
      const x = cx + rng.range(-9.6, 9.6), z = cz + rng.range(-6.6, 9.6);
      if (blocked(x, z) || placed.some(([tx, tz]) => Math.hypot(x - tx, z - tz) < 2.6)) continue;
      placed.push([x, z]);
      b.tree(f, x, SW, z, rng.range(0.7, 1.3), rng.chance(0.55) ? 'tree' : 'bush');
      break;
    }
  }
  if (kind === 'pond') {
    // a boat house with crates clearly in front of it
    b.span(f, cx + 6, SW, cz + 9, cx + 11, SW + 2.6, cz + 11.5, 0x8a6240, 'wood');
    crates(b, f, rng, cx + 7.2, SW, cz + 6.5);
  }
}

/** Fountain square with fishable water basin, trees, benches and a kiosk. */
function tilePlaza(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, team: string) {
  fountain(b, f, cx, cz, team, 3.6);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    bench(b, f, cx + Math.cos(a) * 6.5, cz + Math.sin(a) * 6.5, -a - Math.PI / 2);
    b.tree(f, cx + Math.cos(a) * 9, SW, cz + Math.sin(a) * 9, rng.range(0.8, 1.1), 'tree');
  }
  // kiosk you can walk into
  const k = f.sub(cx + 8, SW, cz, -Math.PI / 2);
  b.span(k, -1.6, 0, -1.2, 1.6, 2.6, -1.0, 0xe9e1cc, 'plaster');
  for (const s of [-1, 1]) b.span(k, s * 1.6 - 0.1, 0, -1.2, s * 1.6 + 0.1, 2.6, 1.2, 0xe9e1cc, 'plaster');
  b.span(k, -1.8, 2.6, -1.4, 1.8, 2.8, 1.5, 0x3a78b8, 'paint');
  b.span(k, -1.5, 0, 0.6, 1.5, 1.0, 0.9, 0x5c5f63, 'metal');
  if (rng.chance(0.6)) busStop(b, f, cx + rng.pick([-4, 4]), cz - BLOCK + 0.9, Math.PI);
}

/** Green moss river/pond covering most of the block, crossed by a grand pedestrian arched bridge (fishable). */
function tileGreenPond(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, team: string) {
  const P = pondRect('greenpond', cx, cz);
  const moss = 0x548342;
  b.span(f, cx - BLOCK, 0, cz - BLOCK, cx + BLOCK, SW, P.z0, moss, 'grass');
  b.span(f, cx - BLOCK, 0, P.z1, cx + BLOCK, SW, cz + BLOCK, moss, 'grass');
  b.span(f, cx - BLOCK, 0, P.z0, P.x0, SW, P.z1, moss, 'grass');
  b.span(f, P.x1, 0, P.z0, cx + BLOCK, SW, P.z1, moss, 'grass');
  const px = (P.x0 + P.x1) / 2, pz = (P.z0 + P.z1) / 2, phx = (P.x1 - P.x0) / 2, phz = (P.z1 - P.z0) / 2;
  b.span(f, P.x0, -1.05, P.z0, P.x1, -0.95, P.z1, 0x3d4a34, 'dirt');
  b.span(f, P.x0, -0.24, P.z0, P.x1, -0.22, P.z1, 0x388854, 'water', false); // green water
  for (const s of [-1, 1]) {
    b.block(f, px, -0.95, pz + s * (phz - 0.15), phx, 0.58, 0.15, 0x8d8876, 'stone');
    b.block(f, px + s * (phx - 0.15), -0.95, pz, 0.15, 0.58, phz - 0.3, 0x8d8876, 'stone');
  }
  b.data.ponds.push({ team, pos: f.p(px, -0.22, pz), up: f.up(), quat: f.rot(0), half: [phx, phz] });
  // Big arched timber & stone pedestrian bridge spanning east-west across the pond
  const bw = 1.65;
  b.hull(f, [[cx - 10.6, SW, cz - bw], [cx - 10.6, SW, cz + bw], [cx - 5.2, SW, cz - bw], [cx - 5.2, SW, cz + bw],
    [cx - 5.2, SW + 2.2, cz - bw], [cx - 5.2, SW + 2.2, cz + bw]], 0x7c5938, 'wood');
  b.hull(f, [[cx + 10.6, SW, cz - bw], [cx + 10.6, SW, cz + bw], [cx + 5.2, SW, cz - bw], [cx + 5.2, SW, cz + bw],
    [cx + 5.2, SW + 2.2, cz - bw], [cx + 5.2, SW + 2.2, cz + bw]], 0x7c5938, 'wood');
  b.span(f, cx - 5.2, SW + 1.85, cz - bw, cx + 5.2, SW + 2.2, cz + bw, 0x8d6742, 'wood');
  for (const sx of [-4.2, 4.2]) for (const sz of [-1.25, 1.25]) b.span(f, cx + sx - 0.35, -0.95, cz + sz - 0.28, cx + sx + 0.35, SW + 1.9, cz + sz + 0.28, 0x7e796d, 'stone');
  for (const sz of [-bw + 0.08, bw - 0.08]) {
    b.span(f, cx - 5.2, SW + 2.2, cz + sz - 0.06, cx + 5.2, SW + 3.05, cz + sz + 0.06, 0x2f3236, 'metal', false);
    for (const pxPost of [-5.1, -2.5, 0, 2.5, 5.1]) {
      b.block(f, cx + pxPost, SW + 2.2, cz + sz, 0.08, 0.55, 0.08, 0x5c422a, 'wood');
      if (pxPost === 0) b.box(f, cx, SW + 3.35, cz + sz, 0.14, 0.16, 0.14, 0xffe4a0, 'glow', false);
    }
  }
  // lily pads & lakeside fishing jetty
  b.span(f, px - 1.5, -0.15, P.z0 - 0.2, px + 1.5, 0.05, P.z0 + 2.5, 0x8a6240, 'wood');
  for (let k = 0; k < 6; k++) b.box(f, px + rng.range(-6.5, 6.5), -0.18, pz + rng.range(-6.5, 6.5), 0.45, 0.02, 0.45, 0x45924a, 'grass', false);
  for (const sx of [-10.3, 10.3]) for (const sz of [-10.3, 10.3]) b.tree(f, cx + sx, SW, cz + sz, rng.range(0.75, 1.05), 'tree');
  bench(b, f, cx - 5.5, cz - 10.5, 0);
  bench(b, f, cx + 5.5, cz + 10.5, Math.PI);
}

/** Crooked abyss pit punched directly through the island into outer void, ringed with hazards & broken walkways. */
function tileAbyss(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  const A = abyssRect('abyss', cx, cz);
  // surrounding broken asphalt + sidewalk apron around the void pit
  b.span(f, cx - BLOCK, 0, cz - BLOCK, cx + BLOCK, SW, A.z0, 0x77736d, 'asphalt');
  b.span(f, cx - BLOCK, 0, A.z1, cx + BLOCK, SW, cz + BLOCK, 0x77736d, 'asphalt');
  b.span(f, cx - BLOCK, 0, A.z0, A.x0, SW, A.z1, 0x77736d, 'asphalt');
  b.span(f, A.x1, 0, A.z0, cx + BLOCK, SW, A.z1, 0x77736d, 'asphalt');
  // crooked overhanging jagged shelves sticking over the pit opening so the hole looks organic/crooked
  const ledges: [number, number, number, number, number][] = [
    [A.x0, A.x0 + 3.4, A.z0, A.z0 + 5.2, -0.25],
    [A.x1 - 3.6, A.x1, A.z0 + 2.2, A.z1 - 2.0, -0.35],
    [A.x0 + 2.6, A.x1 - 4.0, A.z1 - 3.3, A.z1, -0.2],
  ];
  for (const [x0, x1, z0, z1, drop] of ledges) {
    b.span(f, x0, drop - 1.4, z0, x1, SW + drop, z1, 0x827d73, 'concrete');
    pipe(b, f, [x0 + 0.5, SW + drop - 0.3, (z0 + z1) / 2], [x1 + 1.1, SW + drop - 0.2, (z0 + z1) / 2], 0.05, 0x453b34, false);
  }
  // crooked narrow steel-and-plank catwalk cutting diagonally from (-9.2, 2.5) to (2.5, -9.2)
  const plank = f.sub(cx - 2.6, SW, cz - 2.6, -Math.PI * 0.25);
  b.span(plank, -0.95, -0.05, -7.8, 0.95, 0.14, 7.8, 0x8d633c, 'wood');
  for (const sx of [-0.9, 0.9]) b.box(plank, sx, 0.55, 0, 0.04, 0.45, 7.6, 0x3a3d40, 'metal', false);
  // warning beacons & cones
  for (const [dx, dz] of [[-9.4, -9.2], [9.4, -9.2], [-9.4, 9.2], [9.4, 9.2]]) {
    cone(b, f, cx + dx, cz + dz, SW);
    b.box(f, cx + dx * 0.9, SW + 0.7, cz + dz * 0.9, 0.16, 0.16, 0.16, 0xff7e26, 'glow', false);
  }
  crates(b, f, rng, cx + 9.6, SW, cz + 8.6);
}

/** Void pit crossed overhead by a tall rectangular gantry bridge carried on two massive parallel iron pipes. */
function tilePipes(b: Builder, f: Frame, _rng: Rng, cx: number, cz: number) {
  const A = abyssRect('pipes', cx, cz);
  // Industrial concrete collars framing the square chasm pit
  b.span(f, cx - BLOCK, 0, cz - BLOCK, cx + BLOCK, SW + 0.04, A.z0, 0x918c82, 'concrete');
  b.span(f, cx - BLOCK, 0, A.z1, cx + BLOCK, SW + 0.04, cz + BLOCK, 0x918c82, 'concrete');
  b.span(f, cx - BLOCK, 0, A.z0, A.x0, SW + 0.04, A.z1, 0x918c82, 'concrete');
  b.span(f, A.x1, 0, A.z0, cx + BLOCK, SW + 0.04, A.z1, 0x918c82, 'concrete');
  for (const sz of [-1, 1]) {
    const zb = sz < 0 ? A.z0 : A.z1;
    b.span(f, A.x0, SW, zb - 0.18, A.x1, SW + 0.35, zb + 0.18, 0xd8a832, 'paint');
  }
  for (const sx of [-1, 1]) {
    const xb = sx < 0 ? A.x0 : A.x1;
    b.span(f, xb - 0.18, SW, A.z0, xb + 0.18, SW + 0.35, A.z1, 0xd8a832, 'paint');
  }
  // Approach ramps & tall towers at z = ±9.6 rising up to bridge height y = 4.8 m
  const topY = SW + 4.8;
  for (const sz of [-1, 1]) {
    const rz0 = cz + sz * 11.4, rz1 = cz + sz * 6.8;
    b.hull(f, [[cx - 2.1, SW, rz0], [cx + 2.1, SW, rz0], [cx - 2.1, SW, rz1], [cx + 2.1, SW, rz1],
      [cx - 2.1, topY, rz1], [cx + 2.1, topY, rz1]], 0x62676e, 'metal');
    for (const sx of [-1.8, 1.8]) b.span(f, cx + sx - 0.25, SW, cz + sz * 7.2 - 0.25, cx + sx + 0.25, topY + 0.2, cz + sz * 7.2 + 0.25, 0x45494e, 'metal');
  }
  // Two giant parallel iron pipes spanning across the abyss void + rectangular steel catwalk deck between/atop them
  for (const sx of [-1.45, 1.45]) {
    pipe(b, f, [cx + sx, topY - 0.72, cz - 7.8], [cx + sx, topY - 0.72, cz + 7.8], 0.78, 0x5d646b, true);
    pipe(b, f, [cx + sx, topY - 0.72, cz - 7.8], [cx + sx, topY - 0.72, cz - 7.3], 0.92, 0x3b4046, true);
    pipe(b, f, [cx + sx, topY - 0.72, cz + 7.3], [cx + sx, topY - 0.72, cz + 7.8], 0.92, 0x3b4046, true);
  }
  b.span(f, cx - 2.25, topY - 0.16, cz - 7.4, cx + 2.25, topY + 0.08, cz + 7.4, 0x3c4147, 'metal');
  for (const sx of [-2.18, 2.18]) {
    b.span(f, cx + sx - 0.05, topY + 0.08, cz - 7.4, cx + sx + 0.05, topY + 1.0, cz + 7.4, 0xd8a832, 'paint', false);
  }
}

/** Industrial pipeline depot with storage tanks, elevated pipe runs, valves and catwalks. */
function tilePipeline(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  b.span(f, cx - BLOCK, SW, cz - BLOCK, cx + BLOCK, SW + 0.06, cz + BLOCK, 0x8e897f, 'concrete', false);
  // two chunky cylindrical-ish industrial tanks
  for (const [tx, col] of [[-5.5, 0xd9d4c8], [0.5, 0xb8c2c8]]) {
    b.block(f, cx + tx, SW, cz - 4.5, 2.3, 2.2, 2.3, col, 'metal');
    b.box(f, cx + tx, SW + 4.55, cz - 4.5, 1.9, 0.22, 1.9, 0x5c6268, 'metal');
  }
  // crisscrossing iron, yellow gas & blue coolant pipelines
  for (const [zOff, rad, col, h] of [[-0.5, 0.48, 0x6c757d, 1.2], [2.4, 0.42, 0xd8a634, 2.5], [5.4, 0.52, 0x3b6e8c, 1.35]]) {
    pipe(b, f, [cx - 10.5, SW + h, cz + zOff], [cx + 10.5, SW + h, cz + zOff], rad, col, true);
    for (const pxS of [-7, 0, 7]) b.block(f, cx + pxS, SW, cz + zOff, 0.2, (h - rad) / 2, 0.2, 0x3a3d40, 'metal');
  }
  // overhead manifold crossover bridge
  b.span(f, cx - 2.2, SW + 3.4, cz - 4.5, cx + 2.2, SW + 3.65, cz + 8.5, 0x45494e, 'metal');
  b.hull(f, [[cx - 2.2, SW, cz + 8.5], [cx + 2.2, SW, cz + 8.5], [cx - 2.2, SW, cz + 11.2], [cx + 2.2, SW, cz + 11.2],
    [cx - 2.2, SW + 3.65, cz + 8.5], [cx + 2.2, SW + 3.65, cz + 8.5]], 0x62676e, 'metal');
  crates(b, f, rng, cx + 7.2, SW, cz - 6.5);
  crates(b, f, rng, cx - 7.5, SW, cz + 7.5);
  b.crate(f, cx - 6.5, SW, cz - 8.8, 0.45, 0.15, 0x9b764e);
}

/** Cozy corner neon Bar/Pub with backlit bottle racks, bar counter, stools and outdoor patio. */
function tileBar(b: Builder, f: Frame, _rng: Rng, cx: number, cz: number) {
  const m = f.sub(cx, SW, cz + 1.5, 0);
  const X = 8.2, Z = 6.5, H = 4.6, T = 0.25;
  b.span(m, -X, -0.05, -Z, X, 0.05, Z, 0x5c422c, 'wood');
  // front glazed facade with centered wide double entrance
  b.span(m, -X, 0, Z - T, X, H, Z, 0x4b3328, 'plaster'); // back wall
  for (const sx of [-1, 1]) b.span(m, sx * X - sx * T, 0, -Z, sx * X, H, Z, 0x4b3328, 'plaster');
  b.span(m, -X, 0, -Z, -2.1, H, -Z + T, 0x4b3328, 'plaster');
  b.span(m, 2.1, 0, -Z, X, H, -Z + T, 0x4b3328, 'plaster');
  b.span(m, -2.1, 3.1, -Z, 2.1, H, -Z + T, 0x4b3328, 'plaster');
  b.span(m, -X - 0.2, H, -Z - 0.3, X + 0.2, H + 0.35, Z + 0.2, 0x2f3236, 'metal');
  // glowing neon БАР sign & strip
  b.box(m, 0, H + 0.85, -Z - 0.05, 1.85, 0.55, 0.08, 0x231b26, 'metal', false);
  b.signDecal(m, 0, H + 0.85, -Z - 0.14, 3.4, 0.92, Math.PI, 0xff49b0, 'БАР');
  b.box(m, -5.2, 2.8, -Z - 0.04, 2.1, 0.07, 0.05, 0xffaa2b, 'glow', false);
  b.box(m, 5.2, 2.8, -Z - 0.04, 2.1, 0.07, 0.05, 0xff49b0, 'glow', false);
  // interior: mahogany counter, backlit bottle display shelf, barstools, booth seats
  b.span(m, -4.8, 0, 2.4, 4.8, 1.15, 3.3, 0x4f301e, 'wood');
  b.span(m, -5.0, 1.15, 2.3, 5.0, 1.25, 3.4, 0x875838, 'wood');
  for (let x = -3.6; x <= 3.6; x += 1.45) b.block(m, x, 0, 1.5, 0.26, 0.42, 0.26, 0x9b2a2a, 'paint');
  b.span(m, -4.2, 1.3, 5.85, 4.2, 3.5, 6.2, 0x3b2419, 'wood');
  for (let y = 1.6; y <= 3.0; y += 0.7) {
    b.box(m, 0, y + 0.2, 5.78, 3.8, 0.05, 0.05, 0xffc65c, 'glow', false);
    for (let x = -3.4; x <= 3.4; x += 0.65)
      b.box(m, x, y + 0.3, 5.95, 0.08, 0.22, 0.08, ((Math.round(x * 3) % 2) ? 0x45c46a : 0xd47d2a), 'glass', false);
  }
  // sidewalk patio tables out front
  for (const sx of [-5.2, 5.2]) {
    b.block(f, cx + sx, SW, cz - 7.8, 0.65, 0.38, 0.65, 0x6b472b, 'wood');
    b.box(f, cx + sx, SW + 2.35, cz - 7.8, 1.4, 0.08, 1.4, 0xb8362a, 'paint', false);
  }
}

/** 24/7 street mini-market with stocked grocery aisles, refrigerated coolers and checkout counter. */
function tileStore(b: Builder, f: Frame, _rng: Rng, cx: number, cz: number) {
  const m = f.sub(cx, SW, cz + 1.5, 0);
  const X = 8.4, Z = 6.6, H = 4.4, T = 0.25;
  b.span(m, -X, -0.05, -Z, X, 0.05, Z, 0xd8d4c8, 'paving');
  b.span(m, -X, 0, Z - T, X, H, Z, 0xeae5d8, 'plaster');
  for (const sx of [-1, 1]) b.span(m, sx * X - sx * T, 0, -Z, sx * X, H, Z, 0xeae5d8, 'plaster');
  b.span(m, -X, 0, -Z, -2.2, 1.0, -Z + T, 0xeae5d8, 'plaster');
  b.span(m, 2.2, 0, -Z, X, 1.0, -Z + T, 0xeae5d8, 'plaster');
  b.span(m, -X, 1.0, -Z + 0.06, -2.2, 3.0, -Z + 0.18, 0x98c4d8, 'window');
  b.span(m, 2.2, 1.0, -Z + 0.06, X, 3.0, -Z + 0.18, 0x98c4d8, 'window');
  b.span(m, -X, 3.0, -Z, X, H, -Z + T, 0xeae5d8, 'plaster');
  b.span(m, -X - 0.2, H, -Z - 0.3, X + 0.2, H + 0.32, Z + 0.2, 0x3b72a8, 'paint');
  b.box(m, 0, H + 0.72, -Z - 0.05, 2.3, 0.48, 0.08, 0x2f3236, 'metal', false);
  b.signDecal(m, 0, H + 0.72, -Z - 0.14, 4.3, 0.85, Math.PI, 0x3fd07f, 'МАГАЗИН 24');
  // shelving gondolas + colorful goods + glow beverage coolers + checkout desk
  for (const ax of [-3.6, 0.6]) {
    b.span(m, ax - 0.45, 0, -2.5, ax + 0.45, 2.1, 3.2, 0xd8d8dc, 'metal');
    for (let z = -2.0; z <= 2.6; z += 1.1) {
      b.box(m, ax, 1.65, z, 0.38, 0.25, 0.35, z < 0 ? 0xd9483b : 0x3ba45c, 'paint', false);
    }
  }
  b.span(m, -7.2, 0, 5.5, 7.2, 2.5, 6.2, 0xcbe8f4, 'glass');
  b.box(m, 0, 2.4, 5.45, 6.8, 0.08, 0.05, 0x9cf0ff, 'glow', false);
  b.span(m, 3.8, 0, -4.4, 7.2, 1.0, -3.5, 0x3a6e9c, 'metal');
  b.crate(f, cx - 6.5, SW, cz - 8.2, 0.45, 0.2, 0x9b764e);
}

/** Fenced streetball basketball court with hoops, white painted markings and bleachers. */
function tileCourt(b: Builder, f: Frame, _rng: Rng, cx: number, cz: number) {
  b.span(f, cx - BLOCK, 0, cz - BLOCK, cx + BLOCK, SW, cz + BLOCK, 0x5c6168, 'concrete');
  b.span(f, cx - 9.4, SW, cz - 10.2, cx + 9.4, SW + 0.04, cz + 10.2, 0xb85a3a, 'paint', false);
  b.span(f, cx - 2.6, SW + 0.01, cz - 10.2, cx + 2.6, SW + 0.045, cz - 5.2, 0x2f5484, 'paint', false);
  b.span(f, cx - 2.6, SW + 0.01, cz + 5.2, cx + 2.6, SW + 0.045, cz + 10.2, 0x2f5484, 'paint', false);
  b.box(f, cx, SW + 0.05, cz, 9.2, 0.008, 0.07, 0xf2f0e8, 'paint', false); // half-court line
  b.box(f, cx, SW + 0.05, cz, 1.6, 0.008, 1.6, 0xf2f0e8, 'paint', false);
  // perimeter fence with entrances
  for (const s of [-1, 1]) {
    b.span(f, cx + s * 9.8 - 0.06, SW, cz - 10.5, cx + s * 9.8 + 0.06, SW + 2.6, cz - 2.2, 0x363a40, 'metal');
    b.span(f, cx + s * 9.8 - 0.06, SW, cz + 2.2, cx + s * 9.8 + 0.06, SW + 2.6, cz + 10.5, 0x363a40, 'metal');
    b.span(f, cx - 9.8, SW, cz + s * 10.5 - 0.06, cx + 9.8, SW + 2.6, cz + s * 10.5 + 0.06, 0x363a40, 'metal');
  }
  // two basketball hoops
  for (const sz of [-1, 1]) {
    const pz = cz + sz * 9.6;
    b.block(f, cx, SW, pz, 0.14, 1.85, 0.14, 0x23262b, 'metal');
    b.span(f, cx - 0.9, SW + 2.9, pz - sz * 0.48, cx + 0.9, SW + 4.1, pz - sz * 0.38, 0xf4f2ec, 'paint');
    b.box(f, cx, SW + 3.15, pz - sz * 0.72, 0.28, 0.04, 0.28, 0xe85a20, 'paint', false);
  }
  // sideline bench
  b.span(f, cx - 11.1, SW, cz - 5.5, cx - 10.2, SW + 0.5, cz + 5.5, 0x9b6e42, 'wood');
}

// --- neutral face ------------------------------------------------------------------------------

/**
 * Market stall with its keeper; open towards the frame's +Z, back wall at local z = -1.35, 4.6 m wide.
 * Pushes the shop (team '' = neutral) to the map data.
 */
export function shopStall(b: Builder, st: Frame, R: number, color: number, team: string) {
  // Back wall + cornice + solid header board behind the sign
  b.block(st, 0, R, -1.35, 2.1, 1.8, 0.15, 0xe9e1cc, 'plaster');
  b.box(st, 0, R + 3.66, -1.35, 2.18, 0.06, 0.19, color, 'paint', false);
  b.block(st, 0, R + 3.72, -1.32, 1.48, 0.36, 0.08, 0x2f3236, 'metal', false);
  b.signDecal(st, 0, R + 4.08, -1.22, 2.8, 0.62, 0, color, 'МАГАЗИН');
  // Front awning posts + flush slanted striped awning (starts cleanly at the back wall front z = -1.20)
  for (const x of [-2.1, 2.1]) b.block(st, x, R, 1.6, 0.09, 1.42, 0.09, 0x3a3d40, 'metal');
  const aw = st.tilt(0, R + 3.06, 0.28, 0, 0.16);
  const stripes = 7;
  for (let i = 0; i < stripes; i++) {
    const x = -2.3 + (i + 0.5) * (4.6 / stripes);
    const c = i % 2 ? 0xf4efe4 : color;
    b.box(aw, x, 0, 0, 2.3 / stripes, 0.035, 1.48, c, 'paint', false);
    b.box(aw, x, -0.18, 1.46, 2.3 / stripes, 0.18, 0.02, c, 'paint', false);
  }
  b.block(st, 0, R, 0.95, 1.5, 0.5, 0.32, 0x5c5f63, 'metal');
  b.box(st, 0, R + 1.04, 0.95, 1.62, 0.05, 0.42, 0x2f3236, 'metal');
  b.prop(st, 'trophy', 1.15, R + 1.09, 0.95, 1.0);
  b.prop(st, 'block', -1.15, R + 1.09, 0.95, 0.5, 0.3);
  for (const x of [-1.05, 1.05]) {
    b.block(st, x, R, -0.88, 0.55, 0.225, 0.26, 0x3a3d40, 'metal', false);
    b.prop(st, 'weapon-rack', x, R + 0.45, -0.88, 2.0);
  }
  // the keeper stands on a low step behind the counter (the character is short, the counter is not)
  const step = 0.5;
  b.block(st, 0, R, -0.15, 0.7, step / 2, 0.4, 0x3a3d40, 'metal');
  b.data.bases.push({ team, up: st.up(), shop: st.raw(0, R + 1.4, 1.2),
    keeper: { pos: st.p(0, R + step + PLAYER_HEIGHT / 2, -0.15), quat: st.rot(0) } });
}

/** Market: a canopy over a neutral shop stall, crates, benches. The stall opens towards `yaw`. */
function tileMarket(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, yaw: number) {
  const m = f.sub(cx, 0, cz, yaw);
  for (const x of [-6, 6]) for (const z of [-5, 5]) b.block(m, x, SW, z, 0.15, 2.4, 0.15, 0x2f3236, 'metal');
  b.box(m, 0, SW + 4.95, 0, 6.6, 0.15, 5.6, 0xe6e2da, 'concrete', false);
  shopStall(b, m.sub(0, 0, -1.5), SW, NEUTRAL, '');
  const mSpots: [number, number][] = [[-8.2, -8], [-8.2, 0], [-8.2, 8], [8.2, -8], [8.2, 0], [8.2, 8]];
  for (let k = 0; k < 3; k++) {
    const [sx, sz] = mSpots.splice(rng.int(0, mSpots.length - 1), 1)[0];
    crates(b, m, rng, sx, SW, sz);
  }
  for (const x of [-4, 4]) bench(b, m, x, 8, Math.PI);
}

/** Full-tile Grand Museum with tall atrium, T-Rex dinosaur skeleton, Ancient King statue and display exhibits. */
function tileMuseum(b: Builder, f: Frame, _rng: Rng, cx: number, cz: number) {
  const m = f.sub(cx, SW, cz, 0);
  const X = 11.2, Z = 11.2, H = 8.4, T = 0.5;
  const STONE = 0xe8e2d2, TRIM = 0xc9beaa, DARK = 0x2f3236, GOLD = 0xd9a834, BONE = 0xf0ead6;
  // Travertine marble floor
  b.span(m, -X, -0.05, -Z, X, 0.08, Z, 0xd6cfc0, 'paving');
  // Enclosed side walls (±X) with solid corner piers, lower marble plinth, upper stone entablature & mullioned glass windows
  for (const sx of [-1, 1]) {
    const x0 = sx > 0 ? X - T : -X;
    const x1 = sx > 0 ? X : -X + T;
    b.span(m, x0, 0, -Z, x1, H, -5.8, STONE, 'stone');
    b.span(m, x0, 0, 5.8, x1, H, Z, STONE, 'stone');
    b.span(m, x0, 0, -5.8, x1, 2.2, 5.8, STONE, 'stone');
    b.span(m, x0, 6.0, -5.8, x1, H, 5.8, STONE, 'stone');
    // Structural pilasters dividing the tall window bays so walls always read solidly
    for (const pz of [-2.0, 2.0]) b.span(m, x0, 2.2, pz - 0.35, x1, 6.0, pz + 0.35, TRIM, 'stone');
    b.span(m, x0 + 0.12, 2.2, -5.8, x1 - 0.12, 6.0, -2.35, 0x9ab3b8, 'window');
    b.span(m, x0 + 0.12, 2.2, -1.65, x1 - 0.12, 6.0, 1.65, 0x9ab3b8, 'window');
    b.span(m, x0 + 0.12, 2.2, 2.35, x1 - 0.12, 6.0, 5.8, 0x9ab3b8, 'window');
  }
  // Two symmetric framed grand entrances: Front (-Z) and Rear (+Z)
  for (const sz of [-1, 1]) {
    const z0 = sz > 0 ? Z - T : -Z;
    const z1 = sz > 0 ? Z : -Z + T;
    b.span(m, -X, 0, z0, -2.4, H, z1, STONE, 'stone');
    b.span(m, 2.4, 0, z0, X, H, z1, STONE, 'stone');
    b.span(m, -2.4, 4.4, z0, 2.4, H, z1, STONE, 'stone');
    // Portal metal jambs + header frame + classical portico pillars & МУЗЕЙ sign
    b.box(m, -2.55, 2.2, sz * (Z + 0.04), 0.16, 2.2, 0.34, DARK, 'metal');
    b.box(m, 2.55, 2.2, sz * (Z + 0.04), 0.16, 2.2, 0.34, DARK, 'metal');
    b.box(m, 0, 4.52, sz * (Z + 0.04), 2.7, 0.16, 0.34, DARK, 'metal');
    for (const pxCol of [-8.8, -4.4, 4.4, 8.8]) b.block(m, pxCol, 0, sz * (Z + 0.55), 0.42, H / 2, 0.42, 0xf0ebe0, 'stone');
    b.box(m, 0, 6.1, sz * (Z + 0.12), 2.7, 0.62, 0.08, DARK, 'metal', false);
    b.signDecal(m, 0, 6.1, sz * (Z + 0.21), 5.1, 1.1, sz < 0 ? Math.PI : 0, GOLD, 'МУЗЕЙ');
  }
  // Roof slab with a real circular oculus hole (r = 4.2 m) straight above the central exhibits
  const R = 4.2, RX = X + 0.45, RZ = Z + 0.55;
  b.span(m, -RX, H, -RZ, RX, H + 0.45, -R, STONE, 'stone');
  b.span(m, -RX, H, R, RX, H + 0.45, RZ, STONE, 'stone');
  const STEPS = 16;
  const stepZ = (2 * R) / STEPS;
  for (let i = 0; i < STEPS; i++) {
    const za = -R + i * stepZ;
    const zb = za + stepZ;
    const zMid = (za + zb) * 0.5;
    const hx = Math.sqrt(Math.max(0.25, R * R - zMid * zMid));
    b.span(m, -RX, H, za, -hx, H + 0.45, zb, STONE, 'stone');
    b.span(m, hx, H, za, RX, H + 0.45, zb, STONE, 'stone');
  }
  // Decorative circular curb ring framing the open oculus
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const rb = m.sub(Math.cos(a) * R, H + 0.22, Math.sin(a) * R, -a);
    b.box(rb, 0, 0, 0, 0.28, 0.28, 0.72, TRIM, 'stone', false);
  }

  // --- Exhibit 1: Dinosaur Skeleton (west wing) ---
  const dx = -5.0, dz = 1.6;
  b.span(m, dx - 3.6, 0.08, dz - 5.2, dx + 3.2, 0.72, dz + 5.2, 0x8e897f, 'stone'); // plinth
  // legs + clawed feet
  for (const sx of [-1.0, 1.0]) {
    b.block(m, dx + sx, 0.72, dz, 0.28, 1.5, 0.32, BONE, 'stone');
    b.box(m, dx + sx, 0.82, dz - 0.45, 0.42, 0.1, 0.52, BONE, 'stone', false);
  }
  // pelvis & angled articulated spine + curved ribs
  b.box(m, dx, 3.6, dz + 0.2, 0.75, 0.45, 0.65, BONE, 'stone', false);
  for (let i = 0; i < 6; i++) {
    const zSeg = dz + 0.5 + i * 0.72;
    const ySeg = 3.55 - i * 0.26;
    b.box(m, dx, ySeg, zSeg, 0.22 - i * 0.025, 0.2, 0.32, BONE, 'stone', false); // tail
  }
  for (let i = 0; i < 5; i++) {
    const zSeg = dz - 0.4 - i * 0.62;
    const ySeg = 3.7 + i * 0.22;
    b.box(m, dx, ySeg, zSeg, 0.22, 0.22, 0.28, BONE, 'stone', false); // spine
    for (const sx of [-1, 1]) {
      b.box(m, dx + sx * 0.75, ySeg - 0.45, zSeg, 0.45, 0.09, 0.09, BONE, 'stone', false);
      b.box(m, dx + sx * 1.1, ySeg - 0.9, zSeg, 0.09, 0.45, 0.09, BONE, 'stone', false);
    }
  }
  // T-Rex skull + open jaw + fangs
  b.block(m, dx, 4.65, dz - 3.9, 0.62, 0.48, 1.05, BONE, 'stone');
  b.box(m, dx, 4.18, dz - 4.0, 0.46, 0.16, 0.92, BONE, 'stone', false);
  for (let z = -4.6; z <= -3.3; z += 0.4) b.box(m, dx, 4.5, dz + z, 0.35, 0.1, 0.08, 0xffffff, 'paint', false);

  // --- Exhibit 2: Ancient King Golden Statue (east wing) ---
  const kx = 5.0, kz = 1.6;
  b.span(m, kx - 2.6, 0.08, kz - 2.6, kx + 2.6, 0.95, kz + 2.6, 0x3b3d42, 'stone');
  b.span(m, kx - 1.9, 0.95, kz - 1.9, kx + 1.9, 1.75, kz + 1.9, 0xe8e2d2, 'stone');
  b.box(m, kx, 1.8, kz, 1.7, 0.08, 1.7, GOLD, 'glow', false);
  // armored legs, torso, royal crimson cape, golden bearded head & crown, scepter/sword
  for (const sx of [-0.45, 0.45]) b.block(m, kx + sx, 1.82, kz, 0.32, 0.95, 0.32, 0xb88b2e, 'metal');
  b.block(m, kx, 3.72, kz, 0.85, 0.95, 0.55, GOLD, 'metal');
  b.box(m, kx, 3.4, kz + 0.72, 1.05, 1.55, 0.16, 0x8f242c, 'paint', false); // royal cape
  b.block(m, kx, 5.65, kz, 0.48, 0.52, 0.48, GOLD, 'metal'); // head
  b.box(m, kx, 6.72, kz, 0.54, 0.25, 0.54, 0xffd23f, 'glow', false); // golden crown
  b.block(m, kx + 1.32, 2.2, kz - 0.55, 0.1, 2.5, 0.1, GOLD, 'metal'); // tall royal greatsword / staff
  b.box(m, kx + 1.32, 4.95, kz - 0.55, 0.52, 0.1, 0.12, GOLD, 'metal', false);

  // --- Glass display vitrines & wall art (flanking the central doorway corridor so both -Z and +Z entries have clear sightline) ---
  for (const [vx, vz, col] of [[-4.8, 6.6, GOLD], [4.8, 6.6, 0xffd23f], [-5.0, -5.8, 0x38d8f0], [5.0, -5.8, 0xff5a8a]]) {
    b.block(m, vx, 0.08, vz, 0.75, 0.55, 0.75, 0x3b3d42, 'stone');
    b.box(m, vx, 1.85, vz, 0.72, 0.65, 0.72, 0x98c4d8, 'window', true);
    b.box(m, vx, 1.65, vz, 0.26, 0.28, 0.26, col, 'glow', false);
  }
  for (const sx of [-4.5, 0, 4.5]) {
    b.box(m, sx, 3.6, Z - T - 0.08, 1.55, 1.05, 0.06, GOLD, 'metal', false);
    b.box(m, sx, 3.6, Z - T - 0.12, 1.35, 0.85, 0.04, sx === 0 ? 0x2b5f8a : sx < 0 ? 0xb44c34 : 0x458048, 'paint', false);
  }
}

/** Square in the middle of a neutral face: two crystal generators, the middle stays open. */
function tileSquare(b: Builder, f: Frame, cx: number, cz: number) {
  b.span(f, cx - 8, SW, cz - 8, cx + 8, SW + 0.03, cz + 8, 0xbdb39b, 'paving', false);
  for (const sx of [-1, 1]) {
    const x = cx + sx * 6, z = cz;
    b.block(f, x, SW, z, 1.4, 0.08, 1.4, 0xa89676, 'stone');
    b.data.crystalSpots.push({ pos: f.p(x, SW + 0.16, z), up: f.up() });
    b.hull(f, [[x, SW + 2.6, z], [x, SW + 0.9, z], [x + 0.45, SW + 1.6, z], [x - 0.45, SW + 1.6, z], [x, SW + 1.6, z + 0.45], [x, SW + 1.6, z - 0.45]], 0x8af5ff, 'glow', false);
  }
  for (const [x, z] of [[-8.8, -8.8], [8.8, -8.8], [-8.8, 8.8], [8.8, 8.8]]) b.tree(f, cx + x, SW, cz + z, 0.9, 'tree');
}

// --- team hall ---------------------------------------------------------------------------------

export const HALL_HALF = 12;
export const HALL_H = 9;

/**
 * The base hall: crystal in the middle, square global-grid doorways (`4.5 × 4.5 m` at `h.x ∈ [-4.5, 0]`, `±13.5 m`
 * portal plane so a single Wall or Door piece seals it flush), open-underside side ramps to the roof, and the shop
 * built cleanly underneath the west ramp.
 */
function genHall(b: Builder, f: Frame, team: TeamDef, cx: number, cz: number) {
  const h = f.sub(cx, 0, cz);
  const H = HALL_HALF, T = 0.4;
  const RT = SW + HALL_H; // roof top
  const PORTAL_Z = 13.5; // 3 × PIECE_CELL (4.5 m) global grid wall plane
  const DH = 4.5; // exact 1-piece height (PIECE_LEVEL = 4.5) above ground y = 0
  const WALL = 0xd4d1ca, GLASS = 0x51636e, DARK = 0x2f3236;

  // polished floor
  b.box(h, 0, SW + 0.02, 0, H - T, 0.02, H - T, 0x9a9b9c, 'concrete', false);
  // walls: k = 0 back (+z), 1 east (+x), 2 front (-z), 3 west; doorways sit in global grid lane h.x ∈ [-4.5, 0]
  for (let k = 0; k < 4; k++) {
    const w = h.sub(0, 0, 0, (k * Math.PI) / 2);
    const door = k % 2 === 0;
    const z = H - T / 2;
    // h.x ∈ [-4.5, 0] translates to w.x ∈ [-4.5, 0] on k = 0 (+z) and w.x ∈ [0, +4.5] on k = 2 (-z)
    const dx0 = k === 0 ? -4.5 : 0;
    const dx1 = k === 0 ? 0 : 4.5;
    const dMid = (dx0 + dx1) / 2;
    if (door) {
      b.span(w, -H, SW, H - T, dx0, RT, H, WALL, 'concrete');
      b.span(w, dx1, SW, H - T, H, RT, H, WALL, 'concrete');
      b.span(w, dx0, DH, H - T, dx1, RT, H, WALL, 'concrete');
      // Square 4.5 × 4.5 m global-grid portal vestibule protruding cleanly from z = H (12.0) to z = 13.5
      const jambW = 0.36;
      b.span(w, dx0 - jambW, 0, H, dx0, DH + 0.36, PORTAL_Z, DARK, 'metal');
      b.span(w, dx1, 0, H, dx1 + jambW, DH + 0.36, PORTAL_Z, DARK, 'metal');
      b.span(w, dx0 - jambW, DH, H, dx1 + jambW, DH + 0.36, PORTAL_Z, DARK, 'metal');
      // Glowing team strip frame strictly outside the clear 4.5 × 4.5 aperture
      b.box(w, dx0 - 0.18, DH * 0.5, PORTAL_Z + 0.03, 0.08, DH * 0.44, 0.03, team.color, 'glow', false);
      b.box(w, dx1 + 0.18, DH * 0.5, PORTAL_Z + 0.03, 0.08, DH * 0.44, 0.03, team.color, 'glow', false);
      b.box(w, dMid, DH + 0.18, PORTAL_Z + 0.03, 2.25, 0.07, 0.03, team.color, 'glow', false);
    } else b.block(w, 0, SW, z, H - T, HALL_H / 2, T / 2, WALL, 'concrete');

    // ribbon windows around the upper wall and solid wings
    for (const [y0, y1] of [[1.1, 3.0], [5.2, 7.6]]) for (const face of [H + 0.03, H - T - 0.03]) {
      const hy = (y1 - y0) / 2;
      if (door && y0 < DH) {
        if (dx0 + H > 1.8) b.box(w, (-H + dx0) / 2, SW + y0 + hy, face, (dx0 + H) / 2 - 0.55, hy, 0.02, GLASS, 'glass', false);
        if (H - dx1 > 1.8) b.box(w, (dx1 + H) / 2, SW + y0 + hy, face, (H - dx1) / 2 - 0.55, hy, 0.02, GLASS, 'glass', false);
      } else b.box(w, 0, SW + y0 + hy, face, H - 0.6, hy, 0.02, GLASS, 'glass', false);
    }
    b.box(w, 0, RT - 0.3, H + 0.05, k % 2 === 0 ? H + 0.08 : H + 0.02, 0.05, 0.03, team.color, 'glow', false);
  }

  // Open-underside sloped ramp decks along east (+x) & west (-x) walls, supported at the upper roof junction
  const RX0 = 8.5, RX1 = 11.5, RZ = 8;
  const slope = Math.atan2(HALL_H, 2 * RZ);
  const rampHalfLen = Math.hypot(RZ, HALL_H / 2);
  for (const s of [-1, 1]) {
    const lo = -s * RZ, hi = s * RZ;
    const midX = s * ((RX0 + RX1) / 2);
    const slabF = h.tilt(midX, SW + HALL_H / 2, 0, 0, -s * slope);
    b.box(slabF, 0, -0.225, 0, (RX1 - RX0) / 2, 0.225, rampHalfLen, 0xb8b3a8, 'concrete');
    // Structural steel post supporting the inner edge at the high end (leaving under-ramp space completely walkable)
    b.block(h, s * (RX0 + 0.14), SW, hi - s * 0.25, 0.14, (HALL_H - 0.45) / 2, 0.14, DARK, 'metal');
    const rail = h.tilt(s * RX0 - s * 0.05, SW + HALL_H / 2 + 0.85, 0, 0, -s * slope);
    b.box(rail, 0, 0, 0, 0.04, 0.04, rampHalfLen, DARK, 'metal', false);
    for (const t of [0, 0.35, 0.65, 1]) {
      const rz = lo + (hi - lo) * t;
      const ry = SW + HALL_H * t;
      b.block(h, s * RX0 - s * 0.05, ry, rz, 0.04, 0.425, 0.04, DARK, 'metal', false);
    }
    // Warm architectural strip lighting underneath the high ramp soffit
    b.box(h, midX, SW + HALL_H * 0.72, hi * 0.62, 0.2, 0.03, 2.2, 0xfff0cc, 'glow', false);
  }

  const HI = H - T;
  const roof = (x0: number, x1: number, z0: number, z1: number) =>
    b.box(h, (x0 + x1) / 2, RT - 0.2, (z0 + z1) / 2, (x1 - x0) / 2, 0.2, (z1 - z0) / 2, 0xbdb8ae, 'concrete');
  roof(-RX0, RX0, -HI, HI);
  roof(RX0, HI, -HI, 2); roof(RX0, HI, RZ, HI); roof(RX1, HI, 2, RZ);
  roof(-HI, -RX0, -2, HI); roof(-HI, -RX0, -HI, -RZ); roof(-HI, -RX1, -RZ, -2);
  for (const s of [-1, 1]) {
    // Open post-and-rail safety guardrails around each roof stairwell opening (open at z = s * RZ where the ramp arrives)
    const rx = s * (RX0 - 0.05);
    for (const z of [s * 2, s * 5]) b.block(h, rx, RT, z, 0.04, 0.445, 0.04, DARK, 'metal');
    for (const x of [s * ((RX0 + RX1) / 2), s * (RX1 + 0.05)]) b.block(h, x, RT, s * 2, 0.04, 0.445, 0.04, DARK, 'metal');
    for (const [y, hy] of [[0.44, 0.03], [0.85, 0.04]]) {
      b.box(h, rx, RT + y, s * 5, hy, hy, 3.0, DARK, 'metal');
      b.box(h, s * (RX0 + RX1) / 2, RT + y, s * 2, (RX1 - RX0) / 2 + 0.05, hy, hy, DARK, 'metal');
    }
  }
  for (const x of [-5, 0, 5]) b.box(h, x, RT - 0.45, 0, 0.25, 0.02, H - 3, 0xfff4dc, 'glow', false);
  for (let k = 0; k < 4; k++) {
    const w = h.sub(0, 0, 0, (k * Math.PI) / 2);
    const inset = k % 2 ? 0.3 : 0;
    const capInset = k % 2 ? 0.33 : -0.03;
    for (const s of [-1, 1]) {
      const c = s * (H - inset + 2.5) / 2, len = (H - inset - 2.5) / 2;
      b.block(w, c, RT, H - 0.15, len, 0.5, 0.15, WALL, 'concrete');
      const cc = s * (H - capInset + 2.5) / 2, clen = (H - capInset - 2.5) / 2;
      b.block(w, cc, RT + 1, H - 0.15, clen, 0.04, 0.18, team.color, 'paint', false);
    }
  }
  b.box(h, 0, SW + 6.0, -H - 0.05, 3.8, 0.58, 0.04, DARK, 'metal', false);
  b.box(h, 0, SW + 6.0, H + 0.05, 3.8, 0.58, 0.04, DARK, 'metal', false);
  b.signDecal(h, 0, SW + 6.0, -H - 0.11, 7, 1.1, Math.PI, team.color, team.name.toUpperCase());
  b.signDecal(h, 0, SW + 6.0, H + 0.11, 7, 1.1, 0, team.color, team.name.toUpperCase());

  // the crystal on its pedestal + fortification ring (pedestal stays strictly inside ±1.50 so fort blocks at ±2 never clip or Z-fight)
  b.box(h, 0, SW + 0.05, 0, 1.48, 0.05, 1.48, DARK, 'metal', false);
  b.box(h, 0, SW + 0.12, 0, 1.44, 0.02, 1.44, team.color, 'glow', false);
  b.block(h, 0, SW + 0.14, 0, 1.32, 0.25, 1.32, 0xd8d2c4, 'stone');
  b.block(h, 0, SW + 0.64, 0, 0.90, 0.18, 0.90, 0xe4dfd2, 'stone');
  const cy = SW + 2.8;
  const fort: StatueDef['fort'] = [];
  const layers: BlockMaterial[] = ['stone', 'metal'];
  layers.forEach((material, y) => {
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++)
      if (Math.abs(i) === 2 || Math.abs(j) === 2) fort.push({ pos: h.p(i, SW + 0.5 + y, j), material });
  });
  b.data.statues.push({ team: team.id, pos: h.p(0, cy + 2.5, 0), bed: h.p(0, cy, 0), up: f.up(), color: team.color, fort });

  // Interior structural columns framing the doorways and roof corner beacons
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = sx * 5.2, pz = sz * (H - T - 0.45);
    b.block(h, px, SW, pz, 0.36, 0.225, 0.36, 0xd8d2c4, 'stone');
    b.block(h, px, SW + 0.45, pz, 0.24, (HALL_H - 1.25) / 2, 0.24, DARK, 'metal');
    b.block(h, px, RT - 0.80, pz, 0.34, 0.20, 0.34, DARK, 'metal');
    b.box(h, px, SW + 4.325, pz, 0.26, 3.625, 0.06, team.color, 'glow', false);
    b.box(h, px, SW + 4.325, pz, 0.06, 3.625, 0.26, team.color, 'glow', false);
    // Roof corner architectural beacons tucked cleanly inside the parapet corners
    const rx = sx * (H - 0.72), rz = sz * (H - 0.72);
    b.block(h, rx, RT, rz, 0.36, 0.80, 0.36, DARK, 'metal', false);
    b.block(h, rx, RT + 1.60, rz, 0.26, 0.22, 0.26, team.color, 'glow', false);
    b.block(h, rx, RT + 2.04, rz, 0.38, 0.06, 0.38, DARK, 'metal', false);
  }

  // spawn in the back-right quarter, looking towards the front door
  const [spx, spz] = [5, 6];
  b.floorDecal(h, 'spawn', spx, SW, spz, 3.2, 3.2, 0, team.color);
  b.floorDecal(h, 'text', spx, SW, spz - 3.6, 4.2, 1.05, 0, team.color, team.name);
  b.data.spawns[team.id] = { pos: h.p(spx, SW + PLAYER_HEIGHT / 2 + 0.05, spz), quat: f.rot(0), yaw: 0 };

  // Shop neatly housed in the spacious open arcade underneath the west ramp (opening towards +X into the hall)
  shopStall(b, h.sub(-9.95, 0, -4.6, Math.PI / 2), SW, team.color, team.id);
  // Decorative rest/supply bench tucked under the opposite east ramp overhang
  bench(b, h, 9.9, 5.2, -Math.PI / 2);
}

/** Hall doors and the crystal stands, hall-local → face-local. */
export function hallNav(cx: number, cz: number) {
  const H = HALL_HALF;
  const dx = -2.25; // centre of the global-grid 4.5 × 4.5 m doorway aperture (h.x ∈ [-4.5, 0])
  return {
    hall: { c: [cx, cz] as [number, number], half: H },
    doors: [{ out: [cx + dx, cz - H - 3] as [number, number], in: [cx + dx, cz - H + 3] as [number, number] },
      { out: [cx + dx, cz + H + 3] as [number, number], in: [cx + dx, cz + H - 3] as [number, number] }],
    bedStands: [[cx, cz - 4], [cx + 4, cz]] as [number, number][],
    patrol: [[cx - 5, cz - 7], [cx + 5, cz - 7]] as [number, number][],
  };
}

/** Fill one tile of a face. */
export function fillTile(b: Builder, f: Frame, rng: Rng, t: Tile, cx: number, cz: number, team: TeamDef | null, maxH?: number) {
  switch (t.kind) {
    case 'tower': tileTower(b, f, rng, cx, cz, maxH); break;
    case 'office': tileOffice(b, f, rng, cx, cz, maxH); break;
    case 'houses': tileHouses(b, f, rng, cx, cz); break;
    case 'parking': tileParking(b, f, rng, cx, cz); break;
    case 'construction': tileConstruction(b, f, rng, cx, cz, maxH); break;
    case 'park': case 'pond': tilePark(b, f, rng, cx, cz, team?.id ?? '', t.kind); break;
    case 'greenpond': tileGreenPond(b, f, rng, cx, cz, team?.id ?? ''); break;
    case 'plaza': tilePlaza(b, f, rng, cx, cz, team?.id ?? ''); break;
    case 'abyss': tileAbyss(b, f, rng, cx, cz); break;
    case 'pipes': tilePipes(b, f, rng, cx, cz); break;
    case 'pipeline': tilePipeline(b, f, rng, cx, cz); break;
    case 'bar': tileBar(b, f, rng, cx, cz); break;
    case 'store': tileStore(b, f, rng, cx, cz); break;
    case 'court': tileCourt(b, f, rng, cx, cz); break;
    case 'museum': tileMuseum(b, f, rng, cx, cz); break;
    case 'market': tileMarket(b, f, rng, cx, cz, Math.atan2(-Math.sign(t.i), -Math.sign(t.j))); break;
    case 'square': tileSquare(b, f, cx, cz); break;
    case 'hall': genHall(b, f, team!, cx, cz); break;
  }
}

/** Parked cars and buses along a tile's side of a road (`open`: the face rim). */
export function parkCars(b: Builder, s: Frame, rng: Rng, H: number, open: boolean, avoid: (a: number) => boolean) {
  const lane = -4.9; // at the kerb of this tile's half of the 12 m road
  for (let a = -H + 9; a <= H - 9; a += rng.range(5.8, 9)) {
    if (!rng.chance(open ? 0.1 : 0.22) || avoid(a)) continue;
    if (!open && rng.chance(0.15) && a <= 0 && !avoid(a + 3.5) && !avoid(a + 8)) {
      bus(b, s, a + 3.5, lane + 0.3, Math.PI / 2 + (rng.chance(0.5) ? 0 : Math.PI), rng.pick(BUS_COLORS));
      a += 9.5;
    } else car(b, s, a, lane, Math.PI / 2 + (rng.chance(0.5) ? 0 : Math.PI), rng.pick(CAR_COLORS));
  }
}

export { STOREY };
