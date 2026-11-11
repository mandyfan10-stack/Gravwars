import { PLAYER_HEIGHT } from '../constants';
import { Rng } from '../math';
import type { TeamDef } from '../teams';
import type { BlockMaterial } from '../blocks';
import { building, house } from './buildings';
import { Builder, Frame, StatueDef } from './core';
import {
  BLOCK, bench, bus, BUS_COLORS, busStop, CAR_COLORS, car, cone, container, CONTAINER_COLORS, crates, FRAME_COLORS,
  GLASS_COLORS, pipe, ROOF_COLORS, STOREY, SW, WALL_COLORS,
} from './props';

/** Random city sections, plus the special tiles of team faces (hall) and neutral faces (square, market, museum). */
export type TileKind = 'tower' | 'office' | 'houses' | 'park' | 'pond' | 'parking' | 'construction' | 'plaza'
  | 'hall' | 'square' | 'market' | 'museum';
export interface Tile { i: number; j: number; kind: TileKind }

/** Pond of a tile, relative to the tile centre: centre offset and half size. Park: a small one; pond tile: big. */
export const PONDS: Partial<Record<TileKind, { dx: number; dz: number; hx: number; hz: number }>> = {
  park: { dx: 3, dz: 2, hx: 4.5, hz: 3.5 },
  pond: { dx: 0, dz: 1, hx: 8, hz: 6 },
};
export const pondRect = (kind: TileKind, cx: number, cz: number) => {
  const p = PONDS[kind]!;
  return { x0: cx + p.dx - p.hx, x1: cx + p.dx + p.hx, z0: cz + p.dz - p.hz, z1: cz + p.dz + p.hz };
};
/** Tiles whose block is not a paved sidewalk (their own ground). */
export const OWN_GROUND = new Set<TileKind>(['park', 'pond', 'parking']);

/** Neutral shops' colour. */
export const NEUTRAL = 0x4f7f9f;

const yawOf = (rng: Rng) => rng.int(0, 3) * (Math.PI / 2);

// --- random sections --------------------------------------------------------------------------

/** Skyscraper: 8–13 glazed storeys you can climb to the roof. */
function tileTower(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  building(b, f, rng, {
    cx, cz, w: 18, d: 18, floors: rng.int(8, 13), y0: SW, yaw: yawOf(rng), style: 'tower',
    frame: rng.pick([0x9aa3a8, 0xb8bcc2, 0x7d868c]), glass: rng.pick(GLASS_COLORS),
  });
  for (const s of [-1, 1]) b.tree(f, cx + s * 10.5, SW, cz - 10.5, rng.range(0.6, 0.8), 'bush');
}

/** Office block: 3–6 storeys, sometimes with a courtyard of crates behind it. */
function tileOffice(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  const wide = rng.chance(0.5);
  const yaw = rng.chance(0.5) ? 0 : Math.PI;
  building(b, f, rng, {
    cx, cz: wide ? cz : cz - 3, w: 18, d: wide ? 18 : 12, floors: rng.int(3, 6), y0: SW, yaw, style: 'office',
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
      // a yard: trees, a bench, crates by the fence
      b.block(f, cx + x, SW, cz + z, 5.5, 0.02, 5.5, 0x6f9a45, 'grass', false);
      b.tree(f, cx + x + rng.range(-2, 2), SW, cz + z + rng.range(-2, 2), rng.range(0.8, 1.2), 'tree');
      b.tree(f, cx + x + rng.range(-3, 3), SW, cz + z + rng.range(-3, 3), rng.range(0.5, 0.7), 'bush');
      bench(b, f, cx + x, cz + z + (z < 0 ? 4 : -4), z < 0 ? Math.PI : 0);
      if (rng.chance(0.6)) crates(b, f, rng, cx + x + rng.pick([-3.5, 3.5]), SW, cz + z);
    }
  }
}

/** Multi-storey car park: open decks, cars on every level, a ramp core up to the roof deck. */
function tileParking(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  b.block(f, cx, 0, cz, BLOCK, SW / 2, BLOCK, 0x6e6b66, 'asphalt');
  building(b, f, rng, {
    cx, cz, w: 18, d: 18, floors: rng.int(2, 4), y0: SW, yaw: yawOf(rng), style: 'garage', frame: 0xb4aea2, glass: 0,
  });
  for (let k = 0; k < 4; k++) cone(b, f, cx + rng.range(-10, 10), cz + rng.pick([-10.5, 10.5]), SW);
  // ticket booth
  b.block(f, cx - 10.5, SW, cz - 10.5, 0.9, 1.2, 0.9, 0xe0d6c0, 'plaster');
  b.block(f, cx - 10.5, SW + 2.4, cz - 10.5, 1.1, 0.08, 1.1, 0x3a3d40, 'metal', false);
}

/** Construction site: a bare concrete frame with scaffolding, a crane, containers, crates and pipes. */
function tileConstruction(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  b.block(f, cx, 0, cz, BLOCK - 0.5, SW / 2 + 0.01, BLOCK - 0.5, 0x8a7356, 'dirt');
  building(b, f, rng, {
    cx: cx + 3, cz: cz - 3, w: 12, d: 12, floors: rng.int(4, 7), y0: SW, yaw: 0, style: 'skeleton', frame: 0xb9b4a8, glass: 0,
  });
  // fence along the street sides with gaps
  for (const s of [-1, 1]) for (let a = -10; a <= 10; a += 4) if (Math.abs(a) > 2)
    b.block(f, cx + a, SW, cz + s * 11.6, 1.9, 1.1, 0.04, 0xd9b35a, 'paint');
  container(b, f, cx - 7, SW, cz + 5, rng.chance(0.5) ? 0 : Math.PI / 2, rng.pick(CONTAINER_COLORS));
  if (rng.chance(0.5)) container(b, f, cx - 7, SW + 2.6, cz + 5, 0, rng.pick(CONTAINER_COLORS));
  const px = cx + 4, pz = cz + 7;
  for (let k = 0; k < 3; k++) pipe(b, f, [px - 3, SW + 0.5 + (k === 2 ? 0.85 : 0), pz + (k - 1) - (k === 2 ? 1 : 0)],
    [px + 3, SW + 0.5 + (k === 2 ? 0.85 : 0), pz + (k - 1) - (k === 2 ? 1 : 0)], 0.48, 0x7d8a92);
  for (let k = 0; k < 3; k++) crates(b, f, rng, cx + rng.range(-9, -3), SW, cz + rng.range(-9, -3));
  for (let k = 0; k < 5; k++) cone(b, f, cx + rng.range(-10, 10), cz + rng.range(-10, 10), SW);
  // sand heap
  b.hull(f, [[cx - 9, SW, cz + 9], [cx - 5, SW, cz + 9], [cx - 9, SW, cz + 5.5], [cx - 5, SW, cz + 5.5], [cx - 7, SW + 1.6, cz + 7.2]], 0xc9a86a, 'dirt');
  // crane: mast + jib (no collision above head height)
  const mx = cx - 9.5, mz = cz - 9.5;
  b.block(f, mx, SW, mz, 0.6, 16, 0.6, 0xe0b020, 'metal');
  b.box(f, mx + 6, SW + 32.4, mz, 9, 0.4, 0.45, 0xe0b020, 'metal', false);
  b.box(f, mx - 4, SW + 31.6, mz, 1.4, 0.8, 0.8, 0x6a6d74, 'metal', false);
  b.box(f, mx + 11, SW + 26, mz, 0.02, 6, 0.02, 0x2a2d30, 'metal', false);
  b.block(f, mx + 11, SW + 19, mz, 0.8, 0.5, 0.8, 0x7a7f86, 'metal', false);
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
  for (let i = 0; i < (kind === 'park' ? 12 : 7); i++) {
    let x = cx + rng.range(-10.5, 10.5), z = cz + rng.range(-10.5, 10.5);
    if (x > P.x0 - 1.5 && x < P.x1 + 1.5 && z > P.z0 - 1.5 && z < P.z1 + 1.5) z = z > pz ? P.z1 + 2.2 : P.z0 - 2.2;
    if (Math.abs(z - (cz - 8.5)) < 1.6) z = cz - 6;
    b.tree(f, Math.max(cx - 10.5, Math.min(cx + 10.5, x)), SW, Math.max(cz - 10.5, Math.min(cz + 10.5, z)), rng.range(0.7, 1.4), rng.chance(0.55) ? 'tree' : 'bush');
  }
  if (kind === 'pond') {
    // a boat house with crates on the far side
    b.span(f, cx + 6, SW, cz + 9, cx + 11, SW + 2.6, cz + 11.5, 0x8a6240, 'wood');
    crates(b, f, rng, cx + 8.5, SW, cz + 7.5);
  }
}

/** Fountain square with trees, benches and a kiosk. */
function tilePlaza(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  const ring: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * 3.6, SW, cz + Math.sin(a) * 3.6], [cx + Math.cos(a) * 3.6, SW + 0.55, cz + Math.sin(a) * 3.6]);
  }
  b.hull(f, ring, 0xd8cfbb, 'stone');
  const water: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    water.push([cx + Math.cos(a) * 3.2, SW + 0.5, cz + Math.sin(a) * 3.2], [cx + Math.cos(a) * 3.2, SW + 0.58, cz + Math.sin(a) * 3.2]);
  }
  b.hull(f, water, 0x3fb6c4, 'water', false);
  b.block(f, cx, SW + 0.5, cz, 0.4, 1.1, 0.4, 0xd8cfbb, 'stone');
  b.block(f, cx, SW + 2.7, cz, 0.9, 0.12, 0.9, 0xd8cfbb, 'stone', false);
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
  if (rng.chance(0.6)) busStop(b, f, cx + rng.pick([-4, 4]), cz - BLOCK + 1.2, 0);
}

// --- neutral face ------------------------------------------------------------------------------

/**
 * Market stall with its keeper; open towards the frame's +Z, back wall at local z = -1.35, 4.6 m wide.
 * Pushes the shop (team '' = neutral) to the map data.
 */
export function shopStall(b: Builder, st: Frame, R: number, color: number, team: string) {
  b.block(st, 0, R, -1.35, 2.1, 1.6, 0.15, 0xe9e1cc, 'plaster');
  b.box(st, 0, R + 3.25, -1.35, 2.15, 0.08, 0.2, color, 'paint', false);
  for (const x of [-2.1, 2.1]) b.block(st, x, R, 1.6, 0.09, 1.42, 0.09, 0x3a3d40, 'metal');
  const aw = st.tilt(0, R + 3.1, 0.15, 0, 0.17);
  const stripes = 7;
  for (let i = 0; i < stripes; i++) {
    const x = -2.3 + (i + 0.5) * (4.6 / stripes);
    const c = i % 2 ? 0xf4efe4 : color;
    b.box(aw, x, 0, 0, 2.3 / stripes, 0.035, 1.75, c, 'paint', false);
    b.box(aw, x, -0.18, 1.74, 2.3 / stripes, 0.18, 0.02, c, 'paint', false);
  }
  b.block(st, 0, R, 0.95, 1.5, 0.5, 0.32, 0x5c5f63, 'metal');
  b.box(st, 0, R + 1.04, 0.95, 1.62, 0.05, 0.42, 0x2f3236, 'metal');
  b.prop(st, 'trophy', 1.15, R + 1.09, 0.95, 1.3);
  b.prop(st, 'block', -1.15, R + 1.09, 0.95, 0.7, 0.3);
  for (const x of [-1, 1]) b.prop(st, 'weapon-rack', x, R, -0.85, 2.2);
  b.signDecal(st, 0, R + 3.72, -1.18, 2.8, 0.62, 0, color, 'МАГАЗИН');
  b.block(st, 0, R + 3.3, -1.32, 1.5, 0.12, 0.1, 0x2f3236, 'metal', false);
  // the keeper stands on a low step behind the counter (the character is short, the counter is not)
  const step = 0.5;
  b.block(st, 0, R, -0.2, 0.7, step / 2, 0.45, 0x3a3d40, 'metal');
  b.data.bases.push({ team, up: st.up(), shop: st.raw(0, R + 1.4, 1.2),
    keeper: { pos: st.p(0, R + step + PLAYER_HEIGHT / 2, -0.2), quat: st.rot(0) } });
}

/** Market: a canopy over a neutral shop stall, crates, benches. The stall opens towards `yaw`. */
function tileMarket(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, yaw: number) {
  const m = f.sub(cx, 0, cz, yaw);
  for (const x of [-6, 6]) for (const z of [-5, 5]) b.block(m, x, SW, z, 0.15, 2.4, 0.15, 0x2f3236, 'metal');
  b.box(m, 0, SW + 4.95, 0, 6.6, 0.15, 5.6, 0xe6e2da, 'concrete', false);
  shopStall(b, m.sub(0, 0, -1.5), SW, NEUTRAL, '');
  for (let k = 0; k < 3; k++) crates(b, m, rng, rng.pick([-9, 9]), SW, rng.pick([-8, -4, 4, 8]));
  for (const x of [-4, 4]) bench(b, m, x, 8, Math.PI);
}

/** Museum: two glazed storeys with exhibits, a roof terrace, a sculpture in the forecourt. */
function tileMuseum(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  building(b, f, rng, {
    cx, cz: cz + 1.5, w: 18, d: 18, floors: 2, y0: SW, yaw: 0, style: 'museum', frame: 0xe8e4dc, glass: 0x9ab3b8,
  });
  b.signDecal(f, cx, SW + 7.2, cz + 1.5 - 9.15, 5, 1.1, Math.PI, 0x2a2d30, 'МУЗЕЙ');
  const sx = cx - 7, sz = cz - 10;
  b.block(f, sx, SW, sz, 1.2, 0.3, 1.2, 0x9a958c, 'stone');
  b.block(f, sx, SW + 0.6, sz, 0.4, 1.2, 0.4, 0x6a5040, 'metal');
  b.block(f, sx + 0.4, SW + 3, sz, 0.8, 0.3, 0.3, 0x6a5040, 'metal');
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
  for (const [x, z] of [[-10, -10], [10, -10], [-10, 10], [10, 10]]) b.tree(f, cx + x, SW, cz + z, 0.9, 'tree');
}

// --- team hall ---------------------------------------------------------------------------------

export const HALL_HALF = 12;
export const HALL_H = 9;

/** The base hall: crystal in the middle, spawn, shop, two street doors (±z) and two ramps up to the roof. */
function genHall(b: Builder, f: Frame, team: TeamDef, cx: number, cz: number) {
  const h = f.sub(cx, 0, cz);
  const H = HALL_HALF, T = 0.4;
  const RT = SW + HALL_H; // roof top
  const DOOR = 2, DH = 3.2;
  const WALL = 0xd4d1ca, GLASS = 0x51636e, DARK = 0x2f3236;

  // polished floor
  b.box(h, 0, SW + 0.02, 0, H - T, 0.02, H - T, 0x9a9b9c, 'concrete', false);
  // walls: k = 0 back (+z), 1 east (+x), 2 front (-z), 3 west; doors in the back and front walls
  for (let k = 0; k < 4; k++) {
    const w = h.sub(0, 0, 0, (k * Math.PI) / 2);
    const door = k % 2 === 0;
    const z = H - T / 2;
    if (door) {
      for (const s of [-1, 1]) b.block(w, s * (H + DOOR) / 2, SW, z, (H - DOOR) / 2, HALL_H / 2, T / 2, WALL, 'concrete');
      b.block(w, 0, SW + DH, z, DOOR, (HALL_H - DH) / 2, T / 2, WALL, 'concrete');
      for (const s of [-1, 1]) {
        b.block(w, s * (DOOR + 0.06), SW, z, 0.06, DH / 2 + 0.06, T / 2 + 0.04, DARK, 'metal', false);
        // Sculpted portal buttresses flanking the entrance with vertical team-colored energy strips
        b.block(w, s * (DOOR + 0.55), SW, H + 0.22, 0.28, (DH + 0.8) / 2, 0.22, DARK, 'metal', false);
        b.box(w, s * (DOOR + 0.55), SW + (DH + 0.4) / 2, H + 0.46, 0.08, (DH - 0.2) / 2, 0.03, team.color, 'glow', false);
      }
      b.block(w, 0, SW + DH, z, DOOR + 0.12, 0.06, T / 2 + 0.04, DARK, 'metal', false);
      b.block(w, 0, SW + DH + 0.28, H + 0.28, DOOR + 0.9, 0.16, 0.28, DARK, 'metal', false);
      b.box(w, 0, SW + DH + 0.35, H + 0.58, DOOR + 0.8, 0.06, 0.03, team.color, 'glow', false);
    } else b.block(w, 0, SW, z, H, HALL_H / 2, T / 2, WALL, 'concrete');
    // two ribbon windows on both faces (around the door opening)
    for (const [y0, y1] of [[1.1, 3.0], [4.7, 7.6]]) for (const face of [H + 0.03, H - T - 0.03]) {
      const hy = (y1 - y0) / 2;
      if (door && y0 < DH) for (const s of [-1, 1]) b.box(w, s * (H + DOOR + 1) / 2, SW + y0 + hy, face, (H - DOOR - 1) / 2 - 0.6, hy, 0.02, GLASS, 'glass', false);
      else b.box(w, 0, SW + y0 + hy, face, H - 0.6, hy, 0.02, GLASS, 'glass', false);
    }
    b.box(w, 0, RT - 0.3, H + 0.05, H + 0.05, 0.05, 0.03, team.color, 'glow', false);
  }
  // ramps (solid wedges) along the east and west walls, each into an opening in the roof
  const RX0 = 8.5, RX1 = 11.5, RZ = 8;
  for (const s of [-1, 1]) {
    const lo = -s * RZ, hi = s * RZ;
    const xa = s * RX0, xb = s * RX1;
    b.hull(h, [[xa, SW, lo], [xb, SW, lo], [xa, SW, hi], [xb, SW, hi], [xa, RT, hi], [xb, RT, hi]], 0xb8b3a8, 'concrete');
    b.box(h, xa - s * 0.05, SW + HALL_H / 2 + 0.5, 0, 0.04, 0.04, RZ, DARK, 'metal', false);
  }
  const roof = (x0: number, x1: number, z0: number, z1: number) =>
    b.box(h, (x0 + x1) / 2, RT - 0.2, (z0 + z1) / 2, (x1 - x0) / 2, 0.2, (z1 - z0) / 2, 0xbdb8ae, 'concrete');
  roof(-RX0, RX0, -H, H);
  roof(RX0, H, -H, 2); roof(RX0, H, RZ, H); roof(RX1, H, 2, RZ);
  roof(-H, -RX0, -2, H); roof(-H, -RX0, -H, -RZ); roof(-H, -RX1, -RZ, -2);
  for (const s of [-1, 1]) {
    b.block(h, s * (RX0 - 0.05), RT, s * 5, 0.05, 0.5, 3, DARK, 'metal');
    b.block(h, s * (RX0 + RX1) / 2, RT, s * 2, 1.5, 0.5, 0.05, DARK, 'metal');
  }
  for (const x of [-5, 0, 5]) b.box(h, x, RT - 0.45, 0, 0.25, 0.02, H - 3, 0xfff4dc, 'glow', false);
  for (let k = 0; k < 4; k++) {
    const w = h.sub(0, 0, 0, (k * Math.PI) / 2);
    for (const s of [-1, 1]) {
      const c = s * (H + 2.5) / 2, len = (H - 2.5) / 2;
      b.block(w, c, RT, H - 0.15, len, 0.5, 0.15, WALL, 'concrete');
      b.block(w, c, RT + 1, H - 0.15, len + 0.02, 0.04, 0.18, team.color, 'paint', false);
    }
  }
  b.box(h, 0, SW + 4.05, -H - 0.05, 3.8, 0.58, 0.04, DARK, 'metal', false);
  b.box(h, 0, SW + 4.05, H + 0.05, 3.8, 0.58, 0.04, DARK, 'metal', false);
  b.signDecal(h, 0, SW + 4.05, -H - 0.11, 7, 1.1, Math.PI, team.color, team.name.toUpperCase());
  b.signDecal(h, 0, SW + 4.05, H + 0.11, 7, 1.1, 0, team.color, team.name.toUpperCase());

  // the crystal on its pedestal + fortification ring
  b.box(h, 0, SW + 0.05, 0, 2.2, 0.05, 2.2, DARK, 'metal', false);
  b.box(h, 0, SW + 0.11, 0, 1.85, 0.02, 1.85, team.color, 'glow', false);
  b.block(h, 0, SW, 0, 1.5, 0.6, 1.5, 0xd8d2c4, 'stone');
  b.block(h, 0, SW + 1.2, 0, 1.0, 0.4, 1.0, 0xe4dfd2, 'stone');
  const cy = SW + 4;
  const fort: StatueDef['fort'] = [];
  const layers: BlockMaterial[] = ['stone', 'stone', 'metal'];
  layers.forEach((material, y) => {
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++)
      if (Math.abs(i) === 2 || Math.abs(j) === 2) fort.push({ pos: h.p(i, SW + 0.5 + y, j), material });
  });
  b.data.statues.push({ team: team.id, pos: h.p(0, cy + 2.5, 0), bed: h.p(0, cy, 0), up: f.up(), color: team.color, fort });

  // Interior energy pylons and roof corner beacons (replacing old team flags)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = sx * 4.2, pz = sz * (-H + T + 1.1);
    b.block(h, px, SW, pz, 0.32, 1.8, 0.32, DARK, 'metal', false);
    b.block(h, px, SW, pz, 0.44, 0.22, 0.44, 0xd8d2c4, 'stone', false);
    b.box(h, px, SW + 2.1, pz, 0.22, 1.35, 0.22, team.color, 'glow', false);
    b.block(h, px, SW + 3.5, pz, 0.38, 0.14, 0.38, DARK, 'metal', false);
    // Roof corner architectural beacons
    const rx = sx * (H - 0.9), rz = sz * (H - 0.9);
    b.block(h, rx, RT, rz, 0.36, 0.85, 0.36, DARK, 'metal', false);
    b.box(h, rx, RT + 1.85, rz, 0.24, 0.22, 0.24, team.color, 'glow', false);
  }

  // spawn in the back-right quarter, looking towards the front door
  const [spx, spz] = [5, 6];
  b.floorDecal(h, 'spawn', spx, SW, spz, 3.2, 3.2, 0, team.color);
  b.floorDecal(h, 'text', spx, SW, spz - 3.6, 4.2, 1.05, 0, team.color, team.name);
  b.data.spawns[team.id] = { pos: h.p(spx, SW + PLAYER_HEIGHT / 2 + 0.05, spz), quat: f.rot(0), yaw: 0 };

  // shop against the back wall, west of the door, open towards the crystal
  shopStall(b, h.sub(-6, 0, H - T - 1.5, Math.PI), SW, team.color, team.id);
}

/** Hall doors and the crystal stands, hall-local → face-local. */
export function hallNav(cx: number, cz: number) {
  const H = HALL_HALF;
  return {
    hall: { c: [cx, cz] as [number, number], half: H },
    doors: [{ out: [cx, cz - H - 3] as [number, number], in: [cx, cz - H + 3] as [number, number] },
      { out: [cx, cz + H + 3] as [number, number], in: [cx, cz + H - 3] as [number, number] }],
    bedStands: [[cx, cz - 4], [cx + 4, cz]] as [number, number][],
    patrol: [[cx - 5, cz - 7], [cx + 5, cz - 7]] as [number, number][],
  };
}

/** Fill one tile of a face. */
export function fillTile(b: Builder, f: Frame, rng: Rng, t: Tile, cx: number, cz: number, team: TeamDef | null) {
  switch (t.kind) {
    case 'tower': tileTower(b, f, rng, cx, cz); break;
    case 'office': tileOffice(b, f, rng, cx, cz); break;
    case 'houses': tileHouses(b, f, rng, cx, cz); break;
    case 'parking': tileParking(b, f, rng, cx, cz); break;
    case 'construction': tileConstruction(b, f, rng, cx, cz); break;
    case 'park': case 'pond': tilePark(b, f, rng, cx, cz, team?.id ?? '', t.kind); break;
    case 'plaza': tilePlaza(b, f, rng, cx, cz); break;
    case 'museum': tileMuseum(b, f, rng, cx, cz); break;
    case 'market': tileMarket(b, f, rng, cx, cz, Math.atan2(-Math.sign(t.i), -Math.sign(t.j))); break;
    case 'square': tileSquare(b, f, cx, cz); break;
    case 'hall': genHall(b, f, team!, cx, cz); break;
  }
}

/** Parked cars and buses along a tile's side of a road (`open`: the face rim). */
export function parkCars(b: Builder, s: Frame, rng: Rng, H: number, open: boolean, avoid: (a: number) => boolean) {
  const lane = -4.9; // at the kerb of this tile's half of the 12 m road
  for (let a = -H + 6; a < H - 6; a += rng.range(5.5, 9)) {
    if (!rng.chance(open ? 0.1 : 0.22) || avoid(a)) continue;
    if (!open && rng.chance(0.15) && a < H - 14) {
      bus(b, s, a + 5, lane + 0.3, Math.PI / 2 + (rng.chance(0.5) ? 0 : Math.PI), rng.pick(BUS_COLORS));
      a += 10;
    } else car(b, s, a, lane, Math.PI / 2 + (rng.chance(0.5) ? 0 : Math.PI), rng.pick(CAR_COLORS));
  }
}

export { STOREY };
