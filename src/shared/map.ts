import { Matrix4, Quaternion, Vector3 } from 'three';
import { PLAYER_HEIGHT, WORLD } from './constants';
import { frameForUp, Rng } from './math';
import type { BlockMaterial } from './blocks';
import { TEAMS, TeamDef } from './teams';

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];
export type XZ = [number, number];
export type MatKind =
  | 'concrete' | 'asphalt' | 'paving' | 'grass' | 'water' | 'dirt' | 'rock' | 'metal'
  | 'car' | 'glass' | 'paint' | 'plaster' | 'stone' | 'test' | 'glow';

export interface BoxDef { pos: V3; quat: Q4; half: V3; color: number; mat: MatKind; collide: boolean; /** collider only (a model is drawn there) */ hidden?: boolean }
/** glTF props from public/models/arena (Kenney Mini Arena, CC0). */
export type PropModel = 'banner' | 'column' | 'weapon-rack' | 'trophy' | 'block';
/** pos = where the model's base stands; `team` recolours its team-coloured parts. */
export interface PropDef { model: PropModel; pos: V3; quat: Q4; scale: number; team?: number }
/** Painted plane (spawn circle, team name, shop sign). Local plane = XY facing +Z; `quat` orients it. */
export interface DecalDef { kind: 'spawn' | 'text'; pos: V3; quat: Q4; size: [number, number]; color: number; text?: string }
export interface HullDef { points: number[]; color: number; mat: MatKind; collide: boolean }
/** Tall building with a facade texture. style: glass skyscraper or concrete office block. */
export interface BuildingDef { pos: V3; quat: Q4; half: V3; color: number; style: 'tower' | 'office' }
/** Old-town house: walls + gabled tile roof (ridge along local X). pos = center of the footprint on the ground. */
export interface HouseDef { pos: V3; quat: Q4; size: V3; roofH: number; wall: number; roof: number }
export interface TreeDef { pos: V3; up: V3; scale: number; kind: 'tree' | 'bush' }
export interface SpawnDef { pos: V3; quat: Q4; yaw: number }
/** The team's "bed": a crystal on a pedestal. `bed` = crystal centre, `pos` = small floating marker above it. */
export interface StatueDef { team: string; pos: V3; bed: V3; up: V3; color: number; fort: { pos: V3; material: BlockMaterial }[] }
/**
 * A shop counter with its keeper: one in every base hall (team = owner) and neutral ones in the central city
 * (team = ''). keeper: capsule centre, body frame; faces the frame's +Z.
 */
export interface BaseDef { team: string; up: V3; shop: V3; keeper: { pos: V3; quat: Q4 } }
/** Crystal generator on the central square. */
export interface CrystalSpotDef { pos: V3; up: V3 }
/** Park pond (fishing). pos = water surface centre; half = extents in the island frame. team '' = central city. */
export interface PondDef { team: string; pos: V3; up: V3; quat: Q4; half: [number, number] }
/** A gravity plate (see gravity.ts): walk face centre, normal, in-plane axes and half extents, pull range. */
export interface PlateDef { center: V3; up: V3; u: V3; v: V3; hu: number; hv: number; minH: number; range: number }
/** An island: id = team id for bases, 'center' for the central city. origin = ground centre, quat = its frame. */
export interface IslandDef { id: string; team: string | null; origin: V3; up: V3; quat: Q4; half: number }

/**
 * Navigation of an island, island-local XZ (frame of its up, origin = ground centre): a road graph for NPCs, and
 * for bases the hall (doors, crystal stands) and the bridge stub on the plaza in front of it.
 */
export interface IslandNav {
  nodes: XZ[];
  edges: [number, number][];
  /** Busy spot NPCs keep away from (the stub plaza / the central square). */
  hub: XZ;
  /** Base only: walk from stub[0] to stub[1] = into the stub, which turns the gravity onto it. */
  stub?: [XZ, XZ];
  /** Base only: the hall (centre + half size) and its doors (point outside, point inside). */
  hall?: { c: XZ; half: number };
  doors?: { out: XZ; in: XZ }[];
  bedStands?: XZ[];
  patrol?: XZ[];
}
/**
 * The straight bridge line between a base and the centre, in the central city's frame (XZ of its top face): `hub`
 * near the middle of the city, `rim` at its edge, `base` just past the base's ground (walking there flips you onto
 * the base). Bases' stubs stand on these lines, so bridges built from either end meet.
 */
export interface LaneDef { hub: XZ; rim: XZ; base: XZ }

export interface MapData {
  seed: number;
  /** Teams that have a base island (a team with no players gets none). */
  teams: string[];
  boxes: BoxDef[];
  hulls: HullDef[];
  buildings: BuildingDef[];
  houses: HouseDef[];
  trees: TreeDef[];
  spawns: Record<string, SpawnDef>;
  statues: StatueDef[];
  bases: BaseDef[];
  props: PropDef[];
  decals: DecalDef[];
  crystalSpots: CrystalSpotDef[];
  ponds: PondDef[];
  islands: IslandDef[];
  plates: PlateDef[];
  nav: Record<string, IslandNav>;
  lanes: Record<string, LaneDef>;
  islandDistance: number;
  islandHalf: number;
  centerHalf: number;
  killRadius: number;
}

const _v = new Vector3();
const _q = new Quaternion();
const Y = new Vector3(0, 1, 0);

/** Local coordinate frame used to build pieces (island, face, car…) and emit world-space data. */
class Frame {
  readonly m = new Matrix4();
  constructor(readonly origin: Vector3, readonly q: Quaternion, readonly s = 1) {
    this.m.compose(origin, q, new Vector3(1, 1, 1));
  }
  p(x: number, y: number, z: number): V3 {
    return this.raw(x * this.s, y, z * this.s);
  }
  raw(x: number, y: number, z: number): V3 {
    _v.set(x, y, z).applyMatrix4(this.m);
    return [_v.x, _v.y, _v.z];
  }
  rot(yaw = 0): Q4 {
    const q = this.q.clone().multiply(_q.setFromAxisAngle(Y, yaw));
    return [q.x, q.y, q.z, q.w];
  }
  sub(x: number, y: number, z: number, yaw = 0): Frame {
    const o = new Vector3(...this.p(x, y, z));
    return new Frame(o, this.q.clone().multiply(new Quaternion().setFromAxisAngle(Y, yaw)));
  }
  /** Child frame rotated about its local X (tilted pieces: awnings, broken slabs). */
  tilt(x: number, y: number, z: number, yaw: number, pitch: number, roll = 0): Frame {
    const o = new Vector3(...this.p(x, y, z));
    const q = this.q.clone().multiply(new Quaternion().setFromAxisAngle(Y, yaw))
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch))
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll));
    return new Frame(o, q);
  }
  up(): V3 {
    _v.set(0, 1, 0).applyQuaternion(this.q);
    return [_v.x, _v.y, _v.z];
  }
}

class Builder {
  data: MapData;
  constructor(seed: number) {
    this.data = {
      seed, teams: [], boxes: [], hulls: [], buildings: [], houses: [], trees: [], spawns: {},
      statues: [], bases: [], props: [], decals: [], crystalSpots: [], ponds: [], islands: [], plates: [], nav: {}, lanes: {},
      islandDistance: WORLD.islandDistance, islandHalf: WORLD.islandHalf, centerHalf: WORLD.centerHalf, killRadius: WORLD.killRadius,
    };
  }
  box(f: Frame, x: number, y: number, z: number, hx: number, hy: number, hz: number,
    color: number, mat: MatKind, collide = true, yaw = 0) {
    this.data.boxes.push({ pos: f.p(x, y, z), quat: f.rot(yaw), half: [hx * f.s, hy, hz * f.s], color, mat, collide });
  }
  /** Box standing on local height y0. */
  block(f: Frame, x: number, y0: number, z: number, hx: number, hy: number, hz: number,
    color: number, mat: MatKind, collide = true, yaw = 0) {
    this.box(f, x, y0 + hy, z, hx, hy, hz, color, mat, collide, yaw);
  }
  hull(f: Frame, pts: number[][], color: number, mat: MatKind, collide = true) {
    const points: number[] = [];
    for (const p of pts) points.push(...f.p(p[0], p[1], p[2]));
    this.data.hulls.push({ points, color, mat, collide });
  }
  building(f: Frame, x: number, y0: number, z: number, hx: number, hy: number, hz: number, color: number,
    style: 'tower' | 'office', yaw = 0) {
    this.data.buildings.push({ pos: f.p(x, y0 + hy, z), quat: f.rot(yaw), half: [hx * f.s, hy, hz * f.s], color, style });
  }
  house(f: Frame, x: number, y0: number, z: number, w: number, h: number, d: number, roofH: number,
    wall: number, roof: number, yaw = 0) {
    this.data.houses.push({ pos: f.p(x, y0, z), quat: f.rot(yaw), size: [w * f.s, h, d * f.s], roofH, wall, roof });
  }
  /** Invisible collider (a prop model is drawn there). */
  solid(f: Frame, x: number, y0: number, z: number, hx: number, hy: number, hz: number, yaw = 0) {
    this.data.boxes.push({ pos: f.p(x, y0 + hy, z), quat: f.rot(yaw), half: [hx * f.s, hy, hz * f.s], color: 0, mat: 'paint', collide: true, hidden: true });
  }
  prop(f: Frame, model: PropModel, x: number, y0: number, z: number, scale: number, yaw = 0, team?: number) {
    this.data.props.push({ model, pos: f.p(x, y0, z), quat: f.rot(yaw), scale, team });
  }
  /** Decal lying on the floor of frame f; its text reads upright when looking along `yaw`'s forward. */
  floorDecal(f: Frame, kind: DecalDef['kind'], x: number, y0: number, z: number, w: number, h: number, yaw: number, color: number, text?: string) {
    const q = new Quaternion(...f.rot(yaw)).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2));
    this.data.decals.push({ kind, pos: f.p(x, y0 + 0.02, z), quat: [q.x, q.y, q.z, q.w], size: [w, h], color, text });
  }
  /** Upright decal (sign) facing the frame's local +Z after `yaw`. */
  signDecal(f: Frame, x: number, y: number, z: number, w: number, h: number, yaw: number, color: number, text: string) {
    this.data.decals.push({ kind: 'text', pos: f.p(x, y, z), quat: f.rot(yaw), size: [w, h], color, text });
  }
  tree(f: Frame, x: number, y0: number, z: number, scale: number, kind: 'tree' | 'bush') {
    this.data.trees.push({ pos: f.p(x, y0, z), up: f.up(), scale, kind });
  }
}

const SW = 0.15; // sidewalk height
/**
 * City grid: tiles of TILE metres, each a BLOCK half-size block ringed by half a road. Both are multiples of the
 * 4 m build cell and islands sit at multiples of it too, so buildings line up with the global build grid.
 */
const TILE = 32;
const BLOCK = 12;
/** Build cell (blocks.ts PIECE_CELL): footprints of houses and offices are whole cells. */
const CELL = 4;
const WALL_COLORS = [0xe8dcc0, 0xdcc9a0, 0xe3b48f, 0xc98f6e, 0x9fc4b8, 0x7fb0a8, 0xb9c98f, 0xe6d27a, 0xd99a8a, 0xcfd3cf, 0xa9c2d6];
const ROOF_COLORS = [0xc8643a, 0xb5532f, 0xd47a45, 0xa94a30, 0xc06a48, 0x9c5a3c];
const CAR_COLORS = [0xd9d9d9, 0x2a2a2e, 0xb3261e, 0x2b5cad, 0xe0b020, 0x3a7d44, 0x8a8f99, 0xf2f2f2];
const BUS_COLORS = [0xd8a531, 0x3a78b8, 0xc4442f, 0x3f8f5a];
const CONTAINER_COLORS = [0xb5482f, 0x2f6fa3, 0x3f7f4a, 0xc58b2a, 0x7a7f86];
const OFFICE_COLORS = [0xd8cdb6, 0xc9c0ad, 0xbfc6c4, 0xd2c2a4, 0xb8bcc2];

// --- props built from boxes / hulls ------------------------------------------------------------

function car(b: Builder, f: Frame, x: number, z: number, yaw: number, color: number) {
  const c = f.sub(x, 0.02, z, yaw);
  b.box(c, 0, 0.75, 0, 0.95, 0.42, 2.15, color, 'car');
  b.box(c, 0, 1.5, 0.15, 0.82, 0.33, 1.15, 0x2a3440, 'glass');
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    b.box(c, sx * 0.9, 0.33, sz * 1.35, 0.12, 0.33, 0.33, 0x18181a, 'metal', false);
  for (const sx of [-1, 1]) {
    b.box(c, sx * 0.6, 0.85, -2.16, 0.22, 0.07, 0.02, 0xfff2c8, 'paint', false);
    b.box(c, sx * 0.6, 0.85, 2.16, 0.22, 0.07, 0.02, 0xc81e1e, 'paint', false);
  }
}

function bus(b: Builder, f: Frame, x: number, z: number, yaw: number, color: number) {
  const c = f.sub(x, 0.02, z, yaw);
  b.box(c, 0, 1.75, 0, 1.25, 1.35, 5.8, color, 'car');
  b.box(c, 0, 0.42, 0, 1.2, 0.12, 5.7, 0x2a2a2e, 'metal', false); // skirt
  for (const s of [-1, 1]) b.box(c, s * 1.26, 2.15, 0.4, 0.02, 0.55, 4.9, 0x24303a, 'glass', false);
  b.box(c, 0, 2.05, -5.81, 1.1, 0.75, 0.02, 0x24303a, 'glass', false); // windscreen
  b.box(c, 0, 2.95, -5.82, 0.8, 0.14, 0.02, 0xffb43a, 'glow', false); // route sign
  b.box(c, 0, 3.15, 0, 1.15, 0.05, 5.6, 0xe9e5dc, 'paint', false); // roof
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    b.box(c, sx * 1.15, 0.45, sz * 3.9, 0.16, 0.45, 0.45, 0x18181a, 'metal', false);
}

function lamp(b: Builder, f: Frame, x: number, z: number, yaw: number) {
  const l = f.sub(x, SW, z, yaw);
  b.block(l, 0, 0, 0, 0.07, 2.5, 0.07, 0x2f3a33, 'metal');
  b.box(l, 0, 4.95, 0.6, 0.05, 0.05, 0.6, 0x2f3a33, 'metal', false);
  b.box(l, 0, 4.85, 1.15, 0.18, 0.08, 0.3, 0xfff1cf, 'paint', false);
}

function bench(b: Builder, f: Frame, x: number, z: number, yaw: number, y0 = SW) {
  const c = f.sub(x, y0, z, yaw);
  b.block(c, 0, 0.42, 0, 0.85, 0.04, 0.24, 0x8a5a36, 'paint');
  b.block(c, 0, 0.55, -0.24, 0.85, 0.2, 0.03, 0x8a5a36, 'paint', false);
  for (const s of [-1, 1]) b.block(c, s * 0.7, 0, 0, 0.04, 0.21, 0.22, 0x2a2d30, 'metal', false);
}

function bin(b: Builder, f: Frame, x: number, z: number) {
  b.block(f, x, SW, z, 0.28, 0.45, 0.28, 0x3c5a44, 'metal');
  b.block(f, x, SW + 0.9, z, 0.3, 0.03, 0.3, 0x2a2d30, 'metal', false);
}

function cone(b: Builder, f: Frame, x: number, z: number, y0 = 0) {
  b.hull(f, [[x - 0.2, y0, z - 0.2], [x + 0.2, y0, z - 0.2], [x - 0.2, y0, z + 0.2], [x + 0.2, y0, z + 0.2], [x, y0 + 0.7, z]], 0xff7a1a, 'paint', false);
}

/** Concrete jersey barrier, 2 m long along local X after yaw. */
function barrier(b: Builder, f: Frame, x: number, z: number, yaw: number, y0 = 0) {
  const c = f.sub(x, y0, z, yaw);
  const pts: number[][] = [];
  for (const sx of [-1, 1]) pts.push([sx, 0, -0.32], [sx, 0, 0.32], [sx, 0.25, -0.3], [sx, 0.25, 0.3], [sx, 0.85, -0.12], [sx, 0.85, 0.12]);
  b.hull(c, pts, 0xc9c4b8, 'concrete');
}

/** Octagonal pipe from a to b (local points), radius r. */
function pipe(b: Builder, f: Frame, a: V3, c: V3, r: number, color = 0x8a8f96, collide = true) {
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
function container(b: Builder, f: Frame, x: number, y0: number, z: number, yaw: number, color: number) {
  const c = f.sub(x, y0, z, yaw);
  b.block(c, 0, 0, 0, 1.22, 1.3, 3.05, color, 'paint');
  for (let k = -2; k <= 2; k++) for (const s of [-1, 1]) b.block(c, s * 1.24, 0.05, k * 1.2, 0.02, 1.2, 0.08, color, 'paint', false);
  b.block(c, 0, 0.05, 3.06, 1.1, 1.2, 0.02, 0x3a3d40, 'metal', false);
}

function busStop(b: Builder, f: Frame, x: number, z: number, yaw: number) {
  const c = f.sub(x, SW, z, yaw);
  for (const s of [-1, 1]) b.block(c, s * 1.6, 0, -0.5, 0.05, 1.25, 0.05, 0x2a2d30, 'metal');
  b.block(c, 0, 2.5, -0.1, 1.8, 0.06, 0.75, 0x2a2d30, 'metal', false);
  b.block(c, 0, 0.3, -0.65, 1.55, 1.1, 0.02, 0xa9c4cc, 'glass', false);
  bench(b, c, 0, -0.25, 0, 0);
  b.block(c, 1.95, 0, 0.3, 0.04, 1.5, 0.04, 0x2a2d30, 'metal', false);
  b.box(c, 1.95, 3.2, 0.3, 0.22, 0.22, 0.03, 0x2b8a4a, 'paint', false);
}

function hydrant(b: Builder, f: Frame, x: number, z: number) {
  b.block(f, x, SW, z, 0.14, 0.38, 0.14, 0xc8352a, 'paint');
}

function rockChunk(cx: number, top: number, cz: number, r: number, depth: number, rng: Rng): number[][] {
  const pts: number[][] = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    pts.push([cx + Math.cos(a) * r, top, cz + Math.sin(a) * r]);
    pts.push([cx + Math.cos(a) * r * 0.5, top - depth * 0.55, cz + Math.sin(a) * r * 0.5]);
  }
  pts.push([cx + rng.range(-0.5, 0.5), top - depth, cz + rng.range(-0.5, 0.5)]);
  return pts;
}

/**
 * Row of attached old-town houses filling [a0,a1] along the row axis, depth [d0,d1].
 * axis 'x': houses follow X, ridge along X. axis 'z': follow Z.
 */
function houseRow(b: Builder, f: Frame, rng: Rng, axis: 'x' | 'z', a0: number, a1: number, d0: number, d1: number, floorsMax = 4) {
  const depth = d1 - d0;
  const dc = (d0 + d1) / 2;
  let a = Math.min(a0, a1);
  const end = Math.max(a0, a1);
  while (end - a > 3.5) {
    let w = rng.chance(0.5) ? CELL : 2 * CELL; // whole build cells
    if (end - a - w < CELL - 0.5) w = end - a;
    const c = a + w / 2;
    const floors = rng.int(2, floorsMax);
    const h = floors * 3 + 0.4;
    const roofH = rng.range(2, 3.6);
    const dd = depth;
    const wall = rng.pick(WALL_COLORS);
    const roof = rng.pick(ROOF_COLORS);
    if (axis === 'x') b.house(f, c, SW, dc, w - 0.02, h, dd, roofH, wall, roof, 0);
    else b.house(f, dc, SW, c, w - 0.02, h, dd, roofH, wall, roof, Math.PI / 2);
    a += w;
  }
}

// --- city tiles --------------------------------------------------------------------------------

type TileKind = 'park' | 'houses' | 'office' | 'plaza' | 'parking' | 'construction' | 'playground'
  | 'launch' | 'hall' | 'boulevard' | 'square' | 'museum' | 'market';
interface Tile { i: number; j: number; kind: TileKind }

/** Pond of a park tile, relative to the tile centre: centre offset and half size. */
const POND = { dx: 1.5, dz: 1, hx: 5.5, hz: 4 };
const pondRect = (cx: number, cz: number) => ({ x0: cx + POND.dx - POND.hx, x1: cx + POND.dx + POND.hx, z0: cz + POND.dz - POND.hz, z1: cz + POND.dz + POND.hz });

/** Square tile-sized box (centre cx/cz, half H), optionally with a rectangular hole: four boxes around it. */
function slab(b: Builder, f: Frame, cx: number, y: number, cz: number, H: number, hy: number,
  hole: { x0: number; x1: number; z0: number; z1: number } | null, color: number, mat: MatKind, collide: boolean) {
  if (!hole) { b.box(f, cx, y, cz, H, hy, H, color, mat, collide); return; }
  const piece = (x0: number, x1: number, z0: number, z1: number) => {
    if (x1 - x0 > 1e-3 && z1 - z0 > 1e-3) b.box(f, (x0 + x1) / 2, y, (z0 + z1) / 2, (x1 - x0) / 2, hy, (z1 - z0) / 2, color, mat, collide);
  };
  piece(cx - H, hole.x0, cz - H, cz + H);
  piece(hole.x1, cx + H, cz - H, cz + H);
  piece(hole.x0, hole.x1, cz - H, hole.z0);
  piece(hole.x0, hole.x1, hole.z1, cz + H);
}
const key = (i: number, j: number) => `${i},${j}`;

/**
 * A torn-out chunk of city: present tiles on a grid, their ground slabs, roads with markings, kerbs, broken edges
 * and the rock mass underneath. Returns the set of present tiles.
 */
function cityGround(b: Builder, f: Frame, rng: Rng, tiles: Tile[], team: TeamDef | null, seam: (i: number, j: number, di: number, dj: number) => boolean = () => false) {
  const has = new Set(tiles.map((t) => key(t.i, t.j)));
  const H = TILE / 2;
  for (const t of tiles) {
    const cx = t.i * TILE, cz = t.j * TILE;
    // slab + asphalt; the block (sidewalk) is raised. A park leaves a hole for its sunken pond.
    const hole = t.kind === 'park' ? pondRect(cx, cz) : null;
    slab(b, f, cx, -0.75, cz, H, 0.75, hole, 0x9a948a, 'concrete', true);
    b.box(f, cx, -2.1, cz, H - 0.5, 0.6, H - 0.5, 0x7a5a3e, 'dirt');
    slab(b, f, cx, 0.012, cz, H, 0.012, hole, 0x77736d, 'asphalt', false);
    if (t.kind !== 'park' && t.kind !== 'parking' && t.kind !== 'playground') b.block(f, cx, 0, cz, BLOCK, SW / 2, BLOCK, 0xcfc4ac, 'paving');
    // rock underneath: a fat inverted pyramid per tile + a few hanging chunks
    const depth = rng.range(16, 30);
    const pts: number[][] = [];
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      pts.push([cx + sx * (H - 0.6), -2.6, cz + sz * (H - 0.6)]);
      pts.push([cx + sx * rng.range(5, 9), -depth * 0.6, cz + sz * rng.range(5, 9)]);
    }
    pts.push([cx + rng.range(-3, 3), -depth, cz + rng.range(-3, 3)]);
    b.hull(f, pts, 0x6a5848, 'rock');
    if (rng.chance(0.6)) b.hull(f, rockChunk(cx + rng.range(-8, 8), -2.7, cz + rng.range(-8, 8), rng.range(2, 5), rng.range(6, 14), rng), 0x7a6553, 'rock');

    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as XZ[]) {
      const open = !has.has(key(t.i + di, t.j + dj));
      // side frame: local +z points out of the tile through this side, x runs along it
      const yaw = Math.atan2(di, dj);
      const s = f.sub(cx + di * H, 0, cz + dj * H, yaw);
      if (!open) {
        // shared road: dashed centre line (drawn once, from the tile with the smaller index)
        if (di + dj > 0) for (let a = -H + 6; a <= H - 6; a += 3.2) b.box(s, a, 0.027, 0, 0.8, 0.004, 0.07, 0xece6d6, 'paint', false);
        continue;
      }
      if (seam(t.i, t.j, di, dj)) continue; // where a bridge lane leaves the island the edge stays clean
      // torn edge: a kerb glow in the team colour, broken slab pieces sticking out, pipes and rebar
      if (team) b.box(s, 0, 0.12, -0.15, H, 0.12, 0.15, team.color, 'glow', false);
      else b.box(s, 0, 0.1, -0.15, H, 0.1, 0.15, 0xb0a99a, 'concrete', false);
      for (let k = 0, n = rng.int(2, 4); k < n; k++) {
        const a = rng.range(-H + 2, H - 2);
        const len = rng.range(2, 4.5);
        const w = rng.range(1.5, 3.5);
        const piece = s.tilt(a, -0.3, len / 2 - 0.6, rng.range(-0.5, 0.5), rng.range(0.08, 0.35), rng.range(-0.15, 0.15));
        b.box(piece, 0, -0.35, 0, w / 2, 0.35, len / 2, 0x938d82, 'concrete');
      }
      for (let k = 0, n = rng.int(1, 3); k < n; k++) {
        const a = rng.range(-H + 1, H - 1);
        const y = rng.range(-1.6, -0.6);
        const out = rng.range(0.8, 3);
        pipe(b, s, [a, y, -0.5], [a + rng.range(-0.6, 0.6), y + rng.range(-0.4, 0.2), out], rng.range(0.12, 0.35), 0x8a8f96, false);
      }
      for (let k = 0; k < 4; k++) {
        const a = rng.range(-H + 1, H - 1);
        b.box(s.tilt(a, -0.4, 0.4, 0, rng.range(-0.5, 0.3)), 0, 0, 0.5, 0.03, 0.03, 0.6, 0x5a4a3c, 'metal', false);
      }
    }
  }
  return has;
}

/** Street furniture around a block and parked vehicles in the road bands. */
function streets(b: Builder, f: Frame, rng: Rng, tiles: Tile[], has: Set<string>, avoid: (x: number, z: number) => boolean) {
  const H = TILE / 2;
  for (const t of tiles) {
    const cx = t.i * TILE, cz = t.j * TILE;
    const kerb = t.kind !== 'park' && t.kind !== 'parking' && t.kind !== 'playground';
    if (kerb) {
      const furniture = t.kind !== 'launch' && t.kind !== 'hall' && t.kind !== 'boulevard' && t.kind !== 'square';
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) lamp(b, f, cx + sx * (BLOCK - 0.5), cz + sz * (BLOCK - 0.5), Math.atan2(sx, sz));
      // benches, bins, hydrants, trees along the sidewalk (outside of building footprints: |a| > 8 or on the strip)
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as XZ[]) {
        const s = f.sub(cx + di * (BLOCK - 1), 0, cz + dj * (BLOCK - 1), Math.atan2(di, dj));
        if (!furniture) continue;
        if (rng.chance(0.55)) bench(b, s, rng.range(-5, 5), 0.2, Math.PI);
        if (rng.chance(0.5)) bin(b, s, rng.pick([-6.5, 6.5]), 0.4);
        if (rng.chance(0.3)) hydrant(b, s, rng.range(-7, 7), 0.6);
      }
    }
    // vehicles parked in the lanes (centre line stays clear for walking)
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as XZ[]) {
      const open = !has.has(key(t.i + di, t.j + dj));
      const s = f.sub(cx + di * H, 0, cz + dj * H, Math.atan2(di, dj));
      const lane = open ? -1.9 : -2.6; // inside this tile's half of the road
      for (let a = -H + 5.5; a < H - 5.5; a += rng.range(5, 9)) {
        if (!rng.chance(0.38)) continue;
        const p = new Vector3(...s.p(a, 0, lane));
        const loc = new Vector3(...p).applyMatrix4(f.m.clone().invert());
        if (avoid(loc.x, loc.z)) continue;
        if (rng.chance(0.18) && a < H - 12 && !open) {
          bus(b, s, a + 4, lane - 0.2, Math.PI / 2 + (rng.chance(0.5) ? 0 : Math.PI), rng.pick(BUS_COLORS));
          a += 9;
        } else car(b, s, a, lane, Math.PI / 2 + (rng.chance(0.5) ? 0 : Math.PI), rng.pick(CAR_COLORS));
      }
      if (open) for (let k = 0; k < 2; k++) {
        if (!rng.chance(0.5)) continue;
        const a = rng.range(-H + 3, H - 3);
        const loc = new Vector3(...s.p(a, 0, -1.2)).applyMatrix4(f.m.clone().invert());
        if (!avoid(loc.x, loc.z)) barrier(b, s, a, -1.2, 0);
      }
    }
  }
}

function tileHouses(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  const tall = rng.chance(0.4) ? 5 : 4;
  houseRow(b, f, rng, 'x', cx - 8, cx + 8, cz + 2, cz + 10, tall);
  houseRow(b, f, rng, 'x', cx - 8, cx + 8, cz - 10, cz - 2, tall);
  for (let k = 0; k < 3; k++) b.tree(f, cx - 6 + k * 6 + rng.range(-1, 1), SW, cz + rng.range(-0.6, 0.6), rng.range(0.5, 0.75), 'bush');
}

function tileOffice(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  const hx = rng.pick([CELL, 2 * CELL]), hz = rng.pick([CELL, 2 * CELL]);
  const h = rng.range(14, 30);
  const style = rng.chance(0.4) ? 'tower' : 'office';
  b.building(f, cx, SW, cz, hx, h, hz, rng.pick(OFFICE_COLORS), style);
  b.block(f, cx, SW + 2 * h, cz, 1.4, 0.7, 1.1, 0x9a9da2, 'metal');
  if (rng.chance(0.5)) pipe(b, f, [cx - hx + 1, SW + 2 * h, cz - hz + 1], [cx - hx + 1, SW + 2 * h + 3, cz - hz + 1], 0.3, 0x8a8f96);
  // entrance canopy
  b.box(f, cx, SW + 3.2, cz - hz - 0.9, 2.5, 0.1, 0.9, 0x3a3d40, 'metal', false);
}

function tilePlaza(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  // fountain: octagonal stone basin with water and a centre column
  const ring: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * 3.2, SW, cz + Math.sin(a) * 3.2], [cx + Math.cos(a) * 3.2, SW + 0.55, cz + Math.sin(a) * 3.2]);
  }
  b.hull(f, ring, 0xd8cfbb, 'stone');
  // water: an octagon inside the rim (a square sheet poked out of the basin at its corners)
  const water: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    water.push([cx + Math.cos(a) * 2.8, SW + 0.5, cz + Math.sin(a) * 2.8], [cx + Math.cos(a) * 2.8, SW + 0.565, cz + Math.sin(a) * 2.8]);
  }
  b.hull(f, water, 0x3fb6c4, 'water', false);
  b.block(f, cx, SW + 0.5, cz, 0.4, 1.1, 0.4, 0xd8cfbb, 'stone');
  b.block(f, cx, SW + 2.7, cz, 0.9, 0.12, 0.9, 0xd8cfbb, 'stone', false);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    bench(b, f, cx + Math.cos(a) * 6, cz + Math.sin(a) * 6, -a - Math.PI / 2);
    b.tree(f, cx + Math.cos(a) * 8.2, SW, cz + Math.sin(a) * 8.2, rng.range(0.8, 1.1), 'tree');
  }
  if (rng.chance(0.6)) busStop(b, f, cx + rng.pick([-4, 4]), cz - BLOCK + 1.2, 0);
}

function tileParking(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  b.block(f, cx, 0, cz, BLOCK, 0.03, BLOCK, 0x6e6b66, 'asphalt', false);
  for (let k = -3; k <= 3; k++) {
    b.box(f, cx + k * 2.6, 0.075, cz - 5, 0.05, 0.004, 2.4, 0xece6d6, 'paint', false);
    b.box(f, cx + k * 2.6, 0.075, cz + 5, 0.05, 0.004, 2.4, 0xece6d6, 'paint', false);
  }
  for (let k = -3; k < 3; k++) for (const s of [-1, 1])
    if (rng.chance(0.55)) car(b, f, cx + k * 2.6 + 1.3, cz + s * 5, rng.chance(0.5) ? 0 : Math.PI, rng.pick(CAR_COLORS));
  if (rng.chance(0.5)) bus(b, f, cx, cz, Math.PI / 2, rng.pick(BUS_COLORS));
  for (let k = 0; k < 4; k++) cone(b, f, cx + rng.range(-8, 8), cz + rng.range(-1.5, 1.5), 0.03);
  // ticket booth
  b.block(f, cx - 8.6, 0.03, cz - 8.6, 0.9, 1.2, 0.9, 0xe0d6c0, 'plaster');
  b.block(f, cx - 8.6, 2.43, cz - 8.6, 1.1, 0.08, 1.1, 0x3a3d40, 'metal', false);
}

function tileConstruction(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  // fence on two sides with gaps, containers, pipe stacks, a crane
  for (const s of [-1, 1]) for (let a = -8; a <= 8; a += 4) if (Math.abs(a) > 1) b.block(f, cx + a, SW, cz + s * 9, 1.9, 1.1, 0.04, 0xd9b35a, 'paint');
  for (let k = 0; k < 3; k++) container(b, f, cx + rng.int(-1, 1) * CELL, SW, cz + rng.int(-1, 1) * CELL, rng.chance(0.5) ? 0 : Math.PI / 2, rng.pick(CONTAINER_COLORS));
  const px = cx + rng.range(-4, 4), pz = cz + rng.range(-6, 6);
  for (let k = 0; k < 3; k++) pipe(b, f, [px - 3, SW + 0.5 + (k === 2 ? 0.85 : 0), pz + (k - 1) * 1.0 - (k === 2 ? 1 : 0)],
    [px + 3, SW + 0.5 + (k === 2 ? 0.85 : 0), pz + (k - 1) * 1.0 - (k === 2 ? 1 : 0)], 0.48, 0x7d8a92);
  for (let k = 0; k < 5; k++) cone(b, f, cx + rng.range(-8, 8), cz + rng.range(-8, 8), SW);
  // crane: mast + jib (no collision above head height)
  const mx = cx + 7, mz = cz - 7;
  b.block(f, mx, SW, mz, 0.6, 14, 0.6, 0xe0b020, 'metal');
  b.box(f, mx - 6, SW + 28.4, mz, 9, 0.4, 0.45, 0xe0b020, 'metal', false);
  b.box(f, mx + 4, SW + 27.6, mz, 1.4, 0.8, 0.8, 0x6a6d74, 'metal', false);
  b.box(f, mx - 11, SW + 22, mz, 0.02, 6, 0.02, 0x2a2d30, 'metal', false);
  b.block(f, mx - 11, SW + 15, mz, 0.8, 0.5, 0.8, 0x7a7f86, 'metal', false);
}

/** Park with a pond (fishing) — the only water on the island. */
function tilePark(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, team: string) {
  const px = cx + POND.dx, pz = cz + POND.dz, phx = POND.hx, phz = POND.hz;
  // grass around a sunken pond (4 slabs leave a hole), pond bottom + water surface
  b.block(f, cx, 0, (cz - BLOCK + pz - phz) / 2, BLOCK, SW / 2, (BLOCK + (pz - cz) - phz) / 2, 0x6f9a45, 'grass');
  b.block(f, cx, 0, (pz + phz + cz + BLOCK) / 2, BLOCK, SW / 2, (cz + BLOCK - (pz + phz)) / 2, 0x6f9a45, 'grass');
  b.block(f, (cx - BLOCK + px - phx) / 2, 0, pz, (px - phx - (cx - BLOCK)) / 2, SW / 2, phz, 0x6f9a45, 'grass');
  b.block(f, (px + phx + cx + BLOCK) / 2, 0, pz, (cx + BLOCK - (px + phx)) / 2, SW / 2, phz, 0x6f9a45, 'grass');
  b.block(f, px, -0.9, pz, phx, 0.05, phz, 0x5a4a38, 'dirt');
  b.block(f, px, -0.25, pz, phx, 0.005, phz, 0x3f9fb0, 'water', false);
  for (const s of [-1, 1]) {
    b.block(f, px, -0.85, pz + s * (phz - 0.15), phx, 0.5, 0.15, 0xb8ae98, 'stone');
    b.block(f, px + s * (phx - 0.15), -0.85, pz, 0.15, 0.5, phz, 0xb8ae98, 'stone');
  }
  b.data.ponds.push({ team, pos: f.p(px, -0.25, pz), up: f.up(), quat: f.rot(0), half: [phx, phz] });
  // wooden jetty for fishing
  b.block(f, px - phx - 0.2, -0.05, pz, 1.6, 0.1, 0.8, 0x8a6240, 'paint');
  // path, benches, trees and bushes
  b.block(f, cx, SW, cz - 7.5, BLOCK, 0.005, 0.9, 0xd9ccaf, 'paving', false);
  for (const x of [-5, 0, 5]) bench(b, f, cx + x, cz - 8.8, 0);
  for (let i = 0; i < 14; i++) {
    let x = cx + rng.range(-9, 9), z = cz + rng.range(-9, 9);
    if (Math.abs(x - px) < phx + 1.5 && Math.abs(z - pz) < phz + 1.5) z = pz + (z > pz ? 1 : -1) * (phz + 2.2);
    if (Math.abs(z - (cz - 7.5)) < 1.6) z = cz - 5.4;
    b.tree(f, Math.max(cx - 9, Math.min(cx + 9, x)), SW, Math.max(cz - 9, Math.min(cz + 9, z)), rng.range(0.7, 1.4), rng.chance(0.55) ? 'tree' : 'bush');
  }
}

/** Movement test area (only on the player's island): stairs, steps, surf ramps, a target wall. Origin = PLAYGROUND. */
export const PLAYGROUND: XZ = [17, -16];
function tilePlayground(b: Builder, island: Frame, rng: Rng) {
  const T = 0x6c7cff;
  const f = island.sub(PLAYGROUND[0], 0, PLAYGROUND[1]);
  b.block(island, 0, 0, -TILE, BLOCK + 1, SW / 2, BLOCK + 1, 0xb9ae96, 'paving');
  for (let i = 0; i < 8; i++) b.block(f, -7.3 - i * 0.6, SW, -9.5, 0.3, (i + 1) * 0.15, 1.5, i % 2 ? T : 0x8a96ff, 'test');
  b.block(f, -13.8, SW, -9.5, 2, 1.2, 1.5, T, 'test');
  [0.5, 1, 1.5, 2, 2.5].forEach((h, i) => b.block(f, -7.5 - i * 2.6, SW, -15, 0.9, h / 2, 0.9, 0xff9a3b, 'test'));
  const sy = SW + 4.8;
  b.hull(f, [[-27.5, SW, -26], [-19.5, SW, -26], [-23.5, sy, -26], [-27.5, SW, -6], [-19.5, SW, -6], [-23.5, sy, -6]], 0x3bd1ff, 'test');
  b.hull(f, [[-6, SW, -26], [-6, SW, -22], [-16, SW, -26], [-16, SW, -22], [-16, SW + 3, -26], [-16, SW + 3, -22]], 0x9aff6b, 'test');
  b.block(f, -9, SW, -19.5, 3, 1.5, 0.2, 0xe8e2d0, 'plaster');
  for (let i = 0; i < 3; i++) b.tree(f, -27 + i * 1.5, SW, -4.9 - rng.range(0, 0.3), 0.8, 'bush');
}

// --- shared pieces ---------------------------------------------------------------------------

/** Neutral shops' colour (central city). */
const NEUTRAL = 0x4f7f9f;

/**
 * Market stall with its keeper; open towards the frame's +Z, back wall at local z = -1.35, 4.6 m wide.
 * Pushes the shop (team '' = neutral) to the map data.
 */
function shopStall(b: Builder, st: Frame, R: number, color: number, team: string) {
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

/** Road graph for NPCs: corners of present tiles, edges along borders shared by two present tiles. */
function roadGraph(tiles: Tile[], has: Set<string>) {
  const nodes: XZ[] = [];
  const index = new Map<string, number>();
  const node = (x: number, z: number) => {
    const k = key(x, z);
    if (!index.has(k)) { index.set(k, nodes.length); nodes.push([x, z]); }
    return index.get(k)!;
  };
  const edges: [number, number][] = [];
  const H = TILE / 2;
  for (const t of tiles) for (const [di, dj] of [[1, 0], [0, 1]] as XZ[]) {
    if (!has.has(key(t.i + di, t.j + dj))) continue;
    const bx = t.i * TILE + di * H, bz = t.j * TILE + dj * H;
    const ax = dj, az = di; // along the border
    edges.push([node(bx - ax * H, bz - az * H), node(bx + ax * H, bz + az * H)]);
  }
  return { nodes, edges };
}

function plate(f: Frame, x: number, y: number, z: number, up: V3, u: V3, v: V3, hu: number, hv: number, minH: number, range: number): PlateDef {
  const dir = (d: V3): V3 => {
    _v.set(...d).applyQuaternion(f.q);
    return [_v.x, _v.y, _v.z];
  };
  return { center: f.p(x, y, z), up: dir(up), u: dir(u), v: dir(v), hu, hv, minH, range };
}

/** Big pull range of island tops: only "holds" the current gravity, a switch needs the plate to be close (gravity.ts). */
const TOP_RANGE = 80;

// --- base island -------------------------------------------------------------------------------
//
// A 5×5 chunk of city. In the middle the launch plaza with the bridge stub: a 4 m wide concrete strip standing up
// from the ground towards the centre; walking into its face turns your gravity onto it (it is level with the
// central city), and its far end is where the bridge starts. Right behind it the base hall: crystal, spawn, shop;
// two street doors and two ramps up to the roof.

const HALL_TILE: XZ = [0, 1];
const HALL_C: XZ = [HALL_TILE[0] * TILE, HALL_TILE[1] * TILE];
const HALL_HALF = 12;
const HALL_H = 8;
/** Bridge stub: island-local x in [STUB_X, STUB_X + 4] (a build cell, on the lane), up to STUB_H, walk face z = 0. */
const STUB_X = 0;
const STUB_W = 4;
const STUB_H = 20;
const STUB_T = 0.25;

function genBaseIsland(b: Builder, team: TeamDef, rng: Rng, playground: boolean) {
  const D = WORLD.islandDistance;
  const down = new Vector3(...team.down);
  const up = down.clone().negate();
  const f = new Frame(down.clone().multiplyScalar(D), frameForUp(up));

  // the inner 3×3, the hall, the two parks and the playground always; the rest is torn away at random
  const parks = [key(-2, -2), key(2, 2)];
  const forced = new Set([key(...HALL_TILE), ...parks, key(0, -2), key(0, 2)]);
  const tiles: Tile[] = [];
  const pool: TileKind[] = ['houses', 'houses', 'houses', 'office', 'office', 'plaza', 'parking', 'construction'];
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const inner = Math.abs(i) < 2 && Math.abs(j) < 2;
    const corner = Math.abs(i) === 2 && Math.abs(j) === 2;
    if (!inner && !forced.has(key(i, j)) && !rng.chance(corner ? 0.35 : 0.65)) continue;
    let kind: TileKind = rng.pick(pool);
    if (i === 0 && j === 0) kind = 'launch';
    else if (i === HALL_TILE[0] && j === HALL_TILE[1]) kind = 'hall';
    else if (parks.includes(key(i, j))) kind = 'park';
    else if (playground && i === 0 && j === -1) kind = 'playground';
    tiles.push({ i, j, kind });
  }
  const has = cityGround(b, f, rng, tiles, team);
  // no parked cars between the hall doors and the stub, behind the back door, nor at the playground stairs
  streets(b, f, rng, tiles, has, (x, z) => Math.abs(x - 2) < 8 && z > -8 && z < HALL_C[1]
    || Math.abs(x) < 6 && z > HALL_C[1]
    || playground && Math.abs(x - (PLAYGROUND[0] - 5)) < 5 && Math.abs(z - (PLAYGROUND[1] - 9.5)) < 6);
  for (const t of tiles) {
    const cx = t.i * TILE, cz = t.j * TILE;
    if (t.kind === 'houses') tileHouses(b, f, rng, cx, cz);
    else if (t.kind === 'office') tileOffice(b, f, rng, cx, cz);
    else if (t.kind === 'plaza') tilePlaza(b, f, rng, cx, cz);
    else if (t.kind === 'parking') tileParking(b, f, rng, cx, cz);
    else if (t.kind === 'construction') tileConstruction(b, f, rng, cx, cz);
    else if (t.kind === 'park') tilePark(b, f, rng, cx, cz, team.id);
    else if (t.kind === 'playground') tilePlayground(b, f, rng);
    else if (t.kind === 'launch') tileLaunch(b, f, team);
    else if (t.kind === 'hall') genHall(b, f, team);
  }

  b.data.islands.push({ id: team.id, team: team.id, origin: f.p(0, 0, 0), up: f.up(), quat: f.rot(0), half: WORLD.islandHalf });
  b.data.plates.push(plate(f, 0, 0, 0, [0, 1, 0], [1, 0, 0], [0, 0, 1], WORLD.islandHalf, WORLD.islandHalf, -2, TOP_RANGE));
  b.data.plates.push(plate(f, STUB_X + STUB_W / 2, STUB_H / 2, 0, [0, 0, 1], [1, 0, 0], [0, 1, 0], STUB_W / 2, STUB_H / 2, -0.3, TOP_RANGE));

  const [hx, hz] = HALL_C;
  const H = HALL_HALF;
  b.data.nav[team.id] = {
    ...roadGraph(tiles, has),
    hub: [STUB_X + STUB_W / 2, 4],
    stub: [[STUB_X + STUB_W / 2, 3.5], [STUB_X + STUB_W / 2, -1]],
    hall: { c: HALL_C, half: H },
    doors: [{ out: [hx, hz - H - 3], in: [hx, hz - H + 3] }, { out: [hx, hz + H + 3], in: [hx, hz + H - 3] }],
    bedStands: [[hx, hz - 4], [hx + 4, hz]],
    patrol: [[hx - 5, hz - 7], [hx + 5, hz - 7]],
  };

  // the lane, in the central city's frame: x and z of its top face are world x and -y
  const toC = (v: V3): XZ => [v[0], -v[1]];
  const lx = STUB_X + STUB_W / 2;
  b.data.lanes[team.id] = {
    hub: toC(f.p(lx, D - 6, 0)),
    rim: toC(f.p(lx, D - WORLD.centerHalf, 0)),
    base: toC(f.p(lx, -1, 0)),
  };
}

/** The launch plaza: the bridge stub with a buttress behind it, markings in front. */
function tileLaunch(b: Builder, f: Frame, team: TeamDef) {
  const x0 = STUB_X, w = STUB_W, x1 = x0 + w, xm = x0 + w / 2;
  b.block(f, xm, 0, -STUB_T / 2, w / 2, STUB_H / 2, STUB_T / 2, 0xbdb6a8, 'concrete');
  // buttress: a wedge behind the strip, so it reads as a structure and not a sheet
  b.hull(f, [[x0 + 0.5, SW, -STUB_T], [x1 - 0.5, SW, -STUB_T], [x0 + 0.5, SW, -7], [x1 - 0.5, SW, -7],
    [x0 + 0.5, STUB_H - 2, -STUB_T], [x1 - 0.5, STUB_H - 2, -STUB_T]], 0xa49d91, 'concrete');
  // team-coloured light strips along the edges of the walk face, an end cap at the top
  for (const x of [x0 + 0.08, x1 - 0.08]) b.box(f, x, STUB_H / 2, 0.02, 0.08, STUB_H / 2, 0.02, team.color, 'glow', false);
  b.box(f, xm, STUB_H - 0.08, 0.02, w / 2, 0.08, 0.02, team.color, 'glow', false);
  b.signDecal(f, xm, 2.6, 0.03, 3.4, 0.8, 0, team.color, 'К ЦЕНТРУ');
  // approach strip on the plaza
  b.floorDecal(f, 'spawn', xm, SW, 2.2, 2.6, 2.6, 0, team.color);
  for (const s of [-1, 1]) {
    bench(b, f, xm + s * 7, -6, s > 0 ? -Math.PI / 2 : Math.PI / 2);
    b.tree(f, xm + s * 9, SW, 6, 0.9, 'tree');
  }
}

/** The base hall: crystal in the middle, spawn, shop, two street doors (±z) and two ramps up to the roof. */
function genHall(b: Builder, f: Frame, team: TeamDef) {
  const h = f.sub(HALL_C[0], 0, HALL_C[1]);
  const H = HALL_HALF, T = 0.4;
  const RT = SW + HALL_H; // roof top
  const DOOR = 2, DOOR_H = 3.2;
  const WALL = 0xd4d1ca, GLASS = 0x51636e, DARK = 0x2f3236;

  // polished floor
  b.box(h, 0, SW + 0.006, 0, H - T, 0.004, H - T, 0x9a9b9c, 'concrete', false);
  // walls: k = 0 back (+z), 1 east (+x), 2 front (-z), 3 west; doors in the back and front walls
  for (let k = 0; k < 4; k++) {
    const w = h.sub(0, 0, 0, (k * Math.PI) / 2);
    const door = k % 2 === 0;
    const z = H - T / 2;
    if (door) {
      for (const s of [-1, 1]) b.block(w, s * (H + DOOR) / 2, SW, z, (H - DOOR) / 2, HALL_H / 2, T / 2, WALL, 'concrete');
      b.block(w, 0, SW + DOOR_H, z, DOOR, (HALL_H - DOOR_H) / 2, T / 2, WALL, 'concrete');
      // door frame + team strip over it
      for (const s of [-1, 1]) b.block(w, s * (DOOR + 0.06), SW, z, 0.06, DOOR_H / 2 + 0.06, T / 2 + 0.04, DARK, 'metal', false);
      b.block(w, 0, SW + DOOR_H, z, DOOR + 0.12, 0.06, T / 2 + 0.04, DARK, 'metal', false);
      b.box(w, 0, SW + DOOR_H + 0.35, H + 0.03, DOOR + 1, 0.06, 0.02, team.color, 'glow', false);
    } else b.block(w, 0, SW, z, H, HALL_H / 2, T / 2, WALL, 'concrete');
    // two ribbon windows on both faces (around the door opening)
    for (const [y0, y1] of [[1.1, 3.0], [4.5, 6.6]]) for (const face of [H + 0.012, H - T - 0.012]) {
      const hy = (y1 - y0) / 2;
      if (door && y0 < DOOR_H) for (const s of [-1, 1]) b.box(w, s * (H + DOOR + 1) / 2, SW + y0 + hy, face, (H - DOOR - 1) / 2 - 0.6, hy, 0.01, GLASS, 'glass', false);
      else b.box(w, 0, SW + y0 + hy, face, H - 0.6, hy, 0.01, GLASS, 'glass', false);
    }
    // cornice in the team colour
    b.box(w, 0, RT - 0.3, H + 0.03, H + 0.03, 0.05, 0.02, team.color, 'glow', false);
  }
  // ramps (solid wedges) along the east and west walls, each into an opening in the roof
  const RX0 = 8.5, RX1 = 11.5, RZ = 8;
  for (const s of [-1, 1]) {
    // east (s = 1) rises towards +z, west (s = -1) towards -z
    const lo = -s * RZ, hi = s * RZ;
    const xa = s * RX0, xb = s * RX1;
    b.hull(h, [[xa, SW, lo], [xb, SW, lo], [xa, SW, hi], [xb, SW, hi], [xa, RT, hi], [xb, RT, hi]], 0xb8b3a8, 'concrete');
    // rail on the open side, a light strip along the slope
    b.box(h, xa - s * 0.05, SW + HALL_H / 2 + 0.5, 0, 0.04, 0.04, RZ, DARK, 'metal', false);
  }
  // roof slab (0.4 thick) around the two openings: east x∈[8.5,11.5] z∈[2,8], west mirrored
  const roof = (x0: number, x1: number, z0: number, z1: number) =>
    b.box(h, (x0 + x1) / 2, RT - 0.2, (z0 + z1) / 2, (x1 - x0) / 2, 0.2, (z1 - z0) / 2, 0xbdb8ae, 'concrete');
  roof(-RX0, RX0, -H, H);
  roof(RX0, H, -H, 2); roof(RX0, H, RZ, H); roof(RX1, H, 2, RZ);
  roof(-H, -RX0, -2, H); roof(-H, -RX0, -H, -RZ); roof(-H, -RX1, -RZ, -2);
  // guard rails around the openings (open only where the ramp arrives)
  for (const s of [-1, 1]) {
    b.block(h, s * (RX0 - 0.05), RT, s * 5, 0.05, 0.5, 3, DARK, 'metal');
    b.block(h, s * (RX0 + RX1) / 2, RT, s * 2, 1.5, 0.5, 0.05, DARK, 'metal');
  }
  // ceiling lights
  for (const x of [-5, 0, 5]) b.box(h, x, RT - 0.43, 0, 0.25, 0.02, H - 3, 0xfff4dc, 'glow', false);
  // parapet with a gap in the middle of every side, team coping
  for (let k = 0; k < 4; k++) {
    const w = h.sub(0, 0, 0, (k * Math.PI) / 2);
    for (const s of [-1, 1]) {
      const c = s * (H + 2.5) / 2, len = (H - 2.5) / 2;
      b.block(w, c, RT, H - 0.15, len, 0.5, 0.15, WALL, 'concrete');
      b.block(w, c, RT + 1, H - 0.15, len + 0.02, 0.04, 0.18, team.color, 'paint', false);
    }
  }
  b.signDecal(h, 0, SW + 5.6, -H - 0.03, 7, 1.2, Math.PI, team.color, team.name.toUpperCase());
  b.signDecal(h, 0, SW + 5.6, H + 0.03, 7, 1.2, 0, team.color, team.name.toUpperCase());

  // the crystal on its pedestal + fortification ring
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

  // spawn in the back-right quarter, looking towards the front door
  const [spx, spz] = [5, 6];
  b.floorDecal(h, 'spawn', spx, SW, spz, 3.2, 3.2, 0, team.color);
  b.floorDecal(h, 'text', spx, SW, spz - 3.6, 4.2, 1.05, 0, team.color, team.name);
  b.data.spawns[team.id] = { pos: h.p(spx, SW + PLAYER_HEIGHT / 2 + 0.05, spz), quat: f.rot(0), yaw: 0 };

  // shop against the back wall, west of the door, open towards the crystal
  shopStall(b, h.sub(-6, 0, H - T - 1.5, Math.PI), SW, team.color, team.id);
  for (const s of [-1, 1]) b.prop(h, 'banner', s * 3.4, SW, -H + T + 0.4, 2.6, 0, team.color);
}

// --- central city ------------------------------------------------------------------------------
//
// A big flat neutral island in the middle, level for gravity -Z (its top face looks at +Z). Four bridge lanes run
// along world x = ±2 / y = ±2 from the bases to the central square: the middle column and row of tiles are
// boulevards kept clear, and the rim has no debris where they leave it. Around: museums, markets with neutral
// shopkeepers, parks with ponds, houses, offices; bandits and bums (npcs.ts) live here.

const CENTER_N = 3; // tiles -3..3

function genCenter(b: Builder, rng: Rng) {
  const f = new Frame(new Vector3(), frameForUp(new Vector3(0, 0, 1)));
  const special = new Map<string, TileKind>([
    [key(1, 1), 'market'], [key(-1, 1), 'market'], [key(1, -1), 'market'], [key(-1, -1), 'market'],
    [key(2, -2), 'museum'], [key(-2, 2), 'museum'], [key(-3, -1), 'museum'],
    [key(2, 2), 'park'], [key(-2, -2), 'park'], [key(3, -3), 'park'], [key(-1, 3), 'park'],
    [key(1, 3), 'plaza'], [key(-3, 1), 'plaza'], [key(3, 1), 'plaza'], [key(-1, -3), 'plaza'],
  ]);
  const pool: TileKind[] = ['houses', 'houses', 'office', 'office', 'parking', 'construction'];
  const tiles: Tile[] = [];
  for (let i = -CENTER_N; i <= CENTER_N; i++) for (let j = -CENTER_N; j <= CENTER_N; j++) {
    let kind: TileKind;
    if (i === 0 && j === 0) kind = 'square';
    else if (i === 0 || j === 0) kind = 'boulevard';
    else kind = special.get(key(i, j)) ?? rng.pick(pool);
    tiles.push({ i, j, kind });
  }
  const has = cityGround(b, f, rng, tiles, null, (i, j, di, dj) => (i === 0 && dj !== 0) || (j === 0 && di !== 0));
  streets(b, f, rng, tiles, has, (x, z) => Math.abs(x) < 7 || Math.abs(z) < 7);
  for (const t of tiles) {
    const cx = t.i * TILE, cz = t.j * TILE;
    if (t.kind === 'houses') tileHouses(b, f, rng, cx, cz);
    else if (t.kind === 'office') tileOffice(b, f, rng, cx, cz);
    else if (t.kind === 'plaza') tilePlaza(b, f, rng, cx, cz);
    else if (t.kind === 'parking') tileParking(b, f, rng, cx, cz);
    else if (t.kind === 'construction') tileConstruction(b, f, rng, cx, cz);
    else if (t.kind === 'park') tilePark(b, f, rng, cx, cz, '');
    else if (t.kind === 'boulevard') tileBoulevard(b, f, rng, cx, cz, t.i === 0);
    else if (t.kind === 'museum') tileMuseum(b, f, rng, cx, cz);
    else if (t.kind === 'market') tileMarket(b, f, rng, cx, cz, Math.atan2(-Math.sign(t.i), 0));
    else if (t.kind === 'square') tileSquare(b, f);
  }
  const half = WORLD.centerHalf;
  b.data.islands.push({ id: 'center', team: null, origin: [0, 0, 0], up: f.up(), quat: f.rot(0), half });
  b.data.plates.push(plate(f, 0, 0, 0, [0, 1, 0], [1, 0, 0], [0, 0, 1], half, half, -2, TOP_RANGE));
  b.data.nav.center = { ...roadGraph(tiles, has), hub: [0, 0] };
}

/** Promenade along a bridge lane: trees and benches at the sides, the middle (|x| < 6) stays clear. */
function tileBoulevard(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, alongZ: boolean) {
  const s = f.sub(cx, 0, cz, alongZ ? 0 : Math.PI / 2);
  b.box(s, 0, SW + 0.005, 0, 4, 0.004, BLOCK, 0xbdb39b, 'paving', false);
  for (const sx of [-1, 1]) {
    for (const a of [-8, 0, 8]) b.tree(s, sx * 9, SW, a, rng.range(0.8, 1.1), 'tree');
    for (const a of [-4, 4]) bench(b, s, sx * 7.4, a, sx > 0 ? -Math.PI / 2 : Math.PI / 2);
  }
}

/** The central square: four crystal generators, the middle stays open (bots cross it between the lanes). */
function tileSquare(b: Builder, f: Frame) {
  b.box(f, 0, SW + 0.005, 0, 7, 0.004, 7, 0xbdb39b, 'paving', false);
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const x = sx * 9, z = sz * 9;
    b.block(f, x, SW, z, 1.4, 0.08, 1.4, 0xa89676, 'stone');
    b.data.crystalSpots.push({ pos: f.p(x, SW + 0.16, z), up: f.up() });
    b.hull(f, [[x, SW + 2.6, z], [x, SW + 0.9, z], [x + 0.45, SW + 1.6, z], [x - 0.45, SW + 1.6, z], [x, SW + 1.6, z + 0.45], [x, SW + 1.6, z - 0.45]], 0x8af5ff, 'glow', false);
  }
}

/** Modern museum: a long low volume under a thin overhanging roof slab, a glass entrance and a sculpture. */
function tileMuseum(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  const hy = 5;
  b.building(f, cx, SW, cz + 2, 10, hy, 8, rng.pick([0xd6d2c8, 0xc9c5bb, 0xbfc3c4]), 'office');
  b.box(f, cx, SW + 2 * hy + 0.25, cz, 11, 0.25, 10.5, 0xe8e4dc, 'concrete');
  for (const x of [-9, 9]) b.block(f, cx + x, SW, cz - 9.2, 0.25, hy, 0.25, 0xe8e4dc, 'concrete');
  b.block(f, cx, SW, cz - 6.2, 3, 1.8, 0.1, 0x3d4d58, 'glass', false);
  b.signDecal(f, cx, SW + 7.2, cz - 6.04, 5, 1.1, Math.PI, 0x2a2d30, 'МУЗЕЙ');
  // sculpture: offset steel blocks on a plinth
  const sx = cx - 6, sz = cz - 9;
  b.block(f, sx, SW, sz, 1.2, 0.3, 1.2, 0x9a958c, 'stone');
  b.block(f, sx, SW + 0.6, sz, 0.4, 1.2, 0.4, 0x6a5040, 'metal');
  b.block(f, sx + 0.4, SW + 3, sz, 0.8, 0.3, 0.3, 0x6a5040, 'metal');
  for (const x of [2, 5]) bench(b, f, cx + x, cz - 10, 0);
}

/** Market: a canopy over a neutral shop stall, crates, benches. The stall opens towards `yaw`. */
function tileMarket(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, yaw: number) {
  const m = f.sub(cx, 0, cz, yaw);
  for (const x of [-6, 6]) for (const z of [-5, 5]) b.block(m, x, SW, z, 0.15, 2.4, 0.15, 0x2f3236, 'metal');
  b.box(m, 0, SW + 4.95, 0, 6.6, 0.15, 5.6, 0xe6e2da, 'concrete', false);
  shopStall(b, m.sub(0, 0, -1.5), SW, NEUTRAL, '');
  for (let k = 0; k < 3; k++) {
    const c = m.sub(rng.pick([-9, 9]), SW, rng.pick([-8, -4, 4, 8]));
    b.block(c, 0, 0, 0, 0.6, 0.6, 0.6, 0x8a6a46, 'paint');
  }
  for (const x of [-4, 4]) bench(b, m, x, 8, Math.PI);
}

// --- map ----------------------------------------------------------------------------------------

/**
 * The whole map. `teams` = teams that play (a team with nobody in it gets no island); `spawnTeam` gets the
 * movement playground on its island.
 */
export function generateMap(seed = 1337, spawnTeam = 'red', teams: readonly string[] = TEAMS.map((t) => t.id)): MapData {
  const b = new Builder(seed);
  const rng = new Rng(seed);
  genCenter(b, rng);
  for (const team of TEAMS) {
    if (!teams.includes(team.id)) continue;
    b.data.teams.push(team.id);
    genBaseIsland(b, team, rng, team.id === spawnTeam);
  }
  return b.data;
}
