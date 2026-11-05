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
/** Portal opening. Local frame: +Y = up of the face it stands on, ±Z = the two sides. pos = opening center. */
export interface PortalDef { id: number; partner: number; pos: V3; quat: Q4; width: number; height: number; color: number }
/** Magic lift / geyser: ballistic launch onto `target`. */
export interface PadDef { pos: V3; up: V3; radius: number; target: V3; apex: number; kind: 'lift' | 'geyser' | 'descent'; team: string }
export interface SpawnDef { pos: V3; quat: Q4; yaw: number }
/** The team's "bed": a crystal on a pedestal. `bed` = crystal centre, `pos` = small floating marker above it. */
export interface StatueDef { team: string; pos: V3; bed: V3; up: V3; color: number; fort: { pos: V3; material: BlockMaterial }[] }
/** Base facilities on the skyscraper roof. */
/** keeper: shopkeeper behind the counter (capsule centre, body frame; faces the frame's +Z). */
export interface BaseDef { team: string; up: V3; shop: V3; keeper: { pos: V3; quat: Q4 } }
/** Crystal generator on a core face. */
export interface CrystalSpotDef { pos: V3; up: V3 }
export interface FaceDef { normal: V3; quat: Q4; team: string }
/** Park pond (fishing). pos = water surface centre; half = extents in the island frame. */
export interface PondDef { team: string; pos: V3; up: V3; quat: Q4; half: [number, number] }

/**
 * Bot navigation of a base island, island-local XZ (frame of the team's up, origin = island ground centre):
 * a road graph to the lift, plus roof landmarks.
 */
export interface IslandNav {
  nodes: XZ[];
  edges: [number, number][];
  /** Lift pad (street → roof) and the road node next to it. */
  lift: XZ;
  liftNode: number;
  roofHeight: number;
  roofMid: XZ;
  geyser: XZ;
  bedStands: XZ[];
  patrol: XZ[];
}
/** Middle island: walk from portal[0] to portal[1] to pass through the gate to the team's core face. */
export interface MidNav { portal: [XZ, XZ] }

export interface MapData {
  seed: number;
  boxes: BoxDef[];
  hulls: HullDef[];
  buildings: BuildingDef[];
  houses: HouseDef[];
  trees: TreeDef[];
  portals: PortalDef[];
  pads: PadDef[];
  spawns: Record<string, SpawnDef>;
  statues: StatueDef[];
  bases: BaseDef[];
  props: PropDef[];
  decals: DecalDef[];
  crystalSpots: CrystalSpotDef[];
  faces: FaceDef[];
  ponds: PondDef[];
  nav: Record<string, IslandNav>;
  mid: Record<string, MidNav>;
  coreHalf: number;
  islandDistance: number;
  midDistance: number;
  islandHalf: number;
  midHalf: number;
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
      seed, boxes: [], hulls: [], buildings: [], houses: [], trees: [], portals: [], pads: [], spawns: {},
      statues: [], bases: [], props: [], decals: [], crystalSpots: [], faces: [], ponds: [], nav: {}, mid: {},
      coreHalf: WORLD.coreHalf, islandDistance: WORLD.islandDistance, midDistance: WORLD.midDistance,
      islandHalf: WORLD.islandHalf, midHalf: WORLD.midHalf, killRadius: WORLD.killRadius,
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
/** City grid: tiles of TILE metres, each a BLOCK half-size block ringed by half a road. */
const TILE = 28;
const BLOCK = 10;
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
    let w = rng.range(4.5, 7.5);
    if (end - a - w < 3.5) w = end - a;
    const c = a + w / 2;
    const floors = rng.int(2, floorsMax);
    const h = floors * 3 + 0.4;
    const roofH = rng.range(2, 3.6);
    const dd = depth - rng.range(0, 1.2);
    const wall = rng.pick(WALL_COLORS);
    const roof = rng.pick(ROOF_COLORS);
    if (axis === 'x') b.house(f, c, SW, dc, w - 0.02, h, dd, roofH, wall, roof, 0);
    else b.house(f, dc, SW, c, w - 0.02, h, dd, roofH, wall, roof, Math.PI / 2);
    a += w;
  }
}

// --- city tiles --------------------------------------------------------------------------------

type TileKind = 'base' | 'park' | 'houses' | 'office' | 'plaza' | 'parking' | 'construction' | 'playground' | 'gate' | 'landing';
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
function cityGround(b: Builder, f: Frame, rng: Rng, tiles: Tile[], team: TeamDef | null) {
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
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) lamp(b, f, cx + sx * (BLOCK - 0.5), cz + sz * (BLOCK - 0.5), Math.atan2(sx, sz));
      // benches, bins, hydrants, trees along the sidewalk (outside of building footprints: |a| > 8 or on the strip)
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as XZ[]) {
        const s = f.sub(cx + di * (BLOCK - 1), 0, cz + dj * (BLOCK - 1), Math.atan2(di, dj));
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
        } else car(b, s, a, lane, Math.PI / 2 + (rng.chance(0.5) ? 0 : Math.PI) + rng.range(-0.08, 0.08), rng.pick(CAR_COLORS));
      }
      if (open) for (let k = 0; k < 2; k++) if (rng.chance(0.5)) barrier(b, s, rng.range(-H + 3, H - 3), -1.2, rng.range(-0.2, 0.2));
    }
  }
}

function tileHouses(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  const tall = rng.chance(0.4) ? 5 : 4;
  houseRow(b, f, rng, 'x', cx - 8, cx + 8, cz + 1.8, cz + 8, tall);
  houseRow(b, f, rng, 'x', cx - 8, cx + 8, cz - 8, cz - 1.8, tall);
  for (let k = 0; k < 3; k++) b.tree(f, cx - 6 + k * 6 + rng.range(-1, 1), SW, cz + rng.range(-0.6, 0.6), rng.range(0.5, 0.75), 'bush');
}

function tileOffice(b: Builder, f: Frame, rng: Rng, cx: number, cz: number) {
  const hx = rng.range(5.5, 7.5), hz = rng.range(5.5, 7.5);
  const h = rng.range(14, 30);
  const style = rng.chance(0.4) ? 'tower' : 'office';
  b.building(f, cx, SW, cz, hx, h, hz, rng.pick(OFFICE_COLORS), style);
  b.block(f, cx + rng.range(-2, 2), SW + 2 * h, cz + rng.range(-2, 2), 1.4, 0.7, 1.1, 0x9a9da2, 'metal');
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
  b.block(f, cx, SW + 0.56, cz, 2.6, 0.005, 2.6, 0x3fb6c4, 'water', false);
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
  for (let k = 0; k < 3; k++) container(b, f, cx + rng.range(-5, 5), SW, cz + rng.range(-5, 5), rng.chance(0.5) ? 0 : Math.PI / 2, rng.pick(CONTAINER_COLORS));
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
function tilePark(b: Builder, f: Frame, rng: Rng, cx: number, cz: number, team: TeamDef) {
  const px = cx + POND.dx, pz = cz + POND.dz, phx = POND.hx, phz = POND.hz;
  // grass around a sunken pond (4 slabs leave a hole), pond bottom + water surface
  b.block(f, cx, 0, cz - (BLOCK + pz - phz) / 2 + (pz - cz) / 2 - 0, BLOCK, SW / 2, (BLOCK + (pz - cz) - phz) / 2, 0x6f9a45, 'grass');
  b.block(f, cx, 0, (pz + phz + cz + BLOCK) / 2, BLOCK, SW / 2, (cz + BLOCK - (pz + phz)) / 2, 0x6f9a45, 'grass');
  b.block(f, (cx - BLOCK + px - phx) / 2, 0, pz, (px - phx - (cx - BLOCK)) / 2, SW / 2, phz, 0x6f9a45, 'grass');
  b.block(f, (px + phx + cx + BLOCK) / 2, 0, pz, (cx + BLOCK - (px + phx)) / 2, SW / 2, phz, 0x6f9a45, 'grass');
  b.block(f, px, -0.9, pz, phx, 0.05, phz, 0x5a4a38, 'dirt');
  b.block(f, px, -0.25, pz, phx, 0.005, phz, 0x3f9fb0, 'water', false);
  for (const s of [-1, 1]) {
    b.block(f, px, -0.85, pz + s * (phz - 0.15), phx, 0.5, 0.15, 0xb8ae98, 'stone');
    b.block(f, px + s * (phx - 0.15), -0.85, pz, 0.15, 0.5, phz, 0xb8ae98, 'stone');
  }
  b.data.ponds.push({ team: team.id, pos: f.p(px, -0.25, pz), up: f.up(), quat: f.rot(0), half: [phx, phz] });
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
export const PLAYGROUND: XZ = [17, -12];
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

// --- base island -------------------------------------------------------------------------------

const BASE_TILE: XZ = [2, 1];
const BASE_C: XZ = [BASE_TILE[0] * TILE, BASE_TILE[1] * TILE];
const TOWER_HW = 10;
const TOWER_H = 50;
/** Lift pad on the road west of the tower. */
const LIFT: XZ = [BASE_C[0] - TILE / 2 - 2.5, BASE_C[1]];

function genBaseIsland(b: Builder, team: TeamDef, rng: Rng, playground: boolean) {
  const D = WORLD.islandDistance;
  const down = new Vector3(...team.down);
  const up = down.clone().negate();
  const f = new Frame(down.clone().multiplyScalar(D), frameForUp(up));

  // which tiles exist: the inner 3×3, the base and the middles of the edges always; the rest is torn away at random
  const forced = new Set([key(...BASE_TILE), key(2, 0), key(-2, 0), key(0, 2), key(0, -2)]);
  const tiles: Tile[] = [];
  const pool: TileKind[] = ['houses', 'houses', 'houses', 'office', 'office', 'plaza', 'parking', 'construction'];
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const inner = Math.abs(i) < 2 && Math.abs(j) < 2;
    const corner = Math.abs(i) === 2 && Math.abs(j) === 2;
    if (!inner && !forced.has(key(i, j)) && !rng.chance(corner ? 0.3 : 0.62)) continue;
    let kind: TileKind = rng.pick(pool);
    if (i === BASE_TILE[0] && j === BASE_TILE[1]) kind = 'base';
    else if (i === -1 && j === -1) kind = 'park';
    else if (playground && i === 0 && j === -1) kind = 'playground';
    else if (forced.has(key(i, j))) kind = rng.pick(['plaza', 'parking']); // drop zones from the core land in the open
    else if (i === 1 && j === 1) kind = 'plaza'; // in front of the base
    tiles.push({ i, j, kind });
  }
  const has = cityGround(b, f, rng, tiles, team);
  streets(b, f, rng, tiles, has, (x, z) => Math.abs(x - LIFT[0]) < 6 && Math.abs(z - LIFT[1]) < 9);
  for (const t of tiles) {
    const cx = t.i * TILE, cz = t.j * TILE;
    if (t.kind === 'houses') tileHouses(b, f, rng, cx, cz);
    else if (t.kind === 'office') tileOffice(b, f, rng, cx, cz);
    else if (t.kind === 'plaza') tilePlaza(b, f, rng, cx, cz);
    else if (t.kind === 'parking') tileParking(b, f, rng, cx, cz);
    else if (t.kind === 'construction') tileConstruction(b, f, rng, cx, cz);
    else if (t.kind === 'park') tilePark(b, f, rng, cx, cz, team);
    else if (t.kind === 'playground') tilePlayground(b, f, rng);
    else if (t.kind === 'base') genBase(b, f, team);
  }

  // road graph for bots: corners of present tiles, edges along borders shared by two present tiles
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
    // shared border: from one corner to the other
    const bx = t.i * TILE + di * H, bz = t.j * TILE + dj * H;
    const ax = dj, az = di; // along the border
    edges.push([node(bx - ax * H, bz - az * H), node(bx + ax * H, bz + az * H)]);
  }
  // the lift sits on the road between the base tile and its western neighbour: split that border
  const lb = node(BASE_C[0] - H, BASE_C[1] - H), lt = node(BASE_C[0] - H, BASE_C[1] + H);
  const liftNode = node(BASE_C[0] - H, BASE_C[1]);
  const e = edges.findIndex(([a, c]) => (a === lb && c === lt) || (a === lt && c === lb));
  if (e >= 0) edges.splice(e, 1, [lb, liftNode], [liftNode, lt]);
  const R = SW + TOWER_H;
  const g = TOWER_HW - 2.2;
  b.data.nav[team.id] = {
    nodes, edges, lift: LIFT, liftNode, roofHeight: R,
    roofMid: [BASE_C[0] + 3.5, BASE_C[1]], geyser: [BASE_C[0] + g, BASE_C[1] + g],
    bedStands: [[BASE_C[0] - 1, BASE_C[1] + 0.6], [BASE_C[0] + 2.6, BASE_C[1] + 4]],
    patrol: [[BASE_C[0] - 3.5, BASE_C[1] - 0.5], [BASE_C[0] + 3, BASE_C[1] - 0.5]],
  };
}

/** Team skyscraper: spawn, shop with its keeper, crystal on the roof; lift up from the street, descent pad back down. */
function genBase(b: Builder, f: Frame, team: TeamDef) {
  const [cx, cz] = BASE_C;
  const hw = TOWER_HW;
  const height = TOWER_H;
  const R = SW + height;
  b.building(f, cx, SW, cz, hw, height / 2, hw, 0xc4ccd0, 'tower');
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    b.block(f, cx + sx * (hw + 0.05), SW, cz + sz * (hw + 0.05), 0.16, height / 2 + 0.6, 0.16, team.color, 'glow', false);
  // entrance canopy facing the lift
  b.block(f, cx - hw - 1.2, SW + 3.6, cz, 1.2, 0.12, 3, team.color, 'paint', false);
  // roof: parapet with gaps in the middle of each side, team-coloured coping
  const edge = hw - 0.15;
  for (const s of [-1, 1]) for (const half of [-1, 1]) {
    const c = half * (hw / 2 + 1.25);
    const len = hw / 2 - 1.25;
    b.block(f, cx + c, R, cz + s * edge, len, 0.35, 0.15, 0xb7b3a8, 'plaster');
    b.block(f, cx + s * edge, R, cz + c, 0.15, 0.35, len, 0xb7b3a8, 'plaster');
    b.block(f, cx + c, R + 0.7, cz + s * edge, len + 0.02, 0.05, 0.18, team.color, 'paint', false);
    b.block(f, cx + s * edge, R + 0.7, cz + c, 0.18, 0.05, len + 0.02, team.color, 'paint', false);
  }
  // long team cloths down every facade
  for (const side of [0, 1, 2, 3]) {
    const fc = f.sub(cx, 0, cz, (side * Math.PI) / 2);
    for (const t of [-4.2, 4.2]) {
      b.box(fc, t, R - 10, hw + 0.08, 1.1, 10, 0.04, team.color, 'paint', false);
      b.box(fc, t, R - 10, hw + 0.1, 0.25, 10, 0.04, 0xf4efe4, 'paint', false);
    }
  }
  const r = f.sub(cx, 0, cz);
  // the crystal on its pedestal + fortification ring
  const sx = -1;
  const sz = 4;
  b.block(r, sx, R, sz, 1.5, 0.6, 1.5, 0xd8d2c4, 'stone');
  b.block(r, sx, R + 1.2, sz, 1.0, 0.4, 1.0, 0xe4dfd2, 'stone');
  const cy = R + 4;
  const fort: StatueDef['fort'] = [];
  const layers: BlockMaterial[] = ['stone', 'stone', 'metal'];
  layers.forEach((material, y) => {
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++)
      if (Math.abs(i) === 2 || Math.abs(j) === 2) fort.push({ pos: r.p(sx + i, R + 0.5 + y, sz + j), material });
  });
  b.data.statues.push({ team: team.id, pos: r.p(sx, cy + 3.6, sz), bed: r.p(sx, cy, sz), up: f.up(), color: team.color, fort });
  // columns in two corners (the geyser and descent corners stay free), team banners along the parapet
  for (const [x, z] of [[-8.9, 8.9], [8.9, -8.9]]) {
    b.prop(r, 'column', x, R, z, 2.3);
    b.solid(r, x, R, z, 0.6, 1.15, 0.6);
  }
  for (let side = 0; side < 4; side++) {
    const e = r.sub(0, 0, 0, (side * Math.PI) / 2);
    for (const t of [-5.6, 5.6]) b.prop(e, 'banner', t, R, 9.45, 2.6, Math.PI, team.color);
  }
  const spawnYaw = Math.atan2(-(sx + 2.5), -(sz + 2.5));
  b.floorDecal(r, 'spawn', -2.5, R, -2.5, 3.2, 3.2, spawnYaw, team.color);
  b.floorDecal(r, 'text', -2.5 - Math.sin(spawnYaw) * 3.6, R, -2.5 - Math.cos(spawnYaw) * 3.6, 4.2, 1.05, spawnYaw, team.color, team.name);

  // shop: a market stall against the west parapet, open towards the roof centre (stall local +Z)
  const st = r.sub(-7.2, 0, 1.5, Math.PI / 2);
  b.block(st, 0, R, -1.35, 2.1, 1.6, 0.15, 0xe9e1cc, 'plaster');
  b.box(st, 0, R + 3.25, -1.35, 2.15, 0.08, 0.2, team.color, 'paint', false);
  for (const x of [-2.1, 2.1]) b.block(st, x, R, 1.6, 0.09, 1.42, 0.09, 0x6b4630, 'paint');
  const aw = st.tilt(0, R + 3.1, 0.15, 0, 0.17);
  const stripes = 7;
  for (let i = 0; i < stripes; i++) {
    const x = -2.3 + (i + 0.5) * (4.6 / stripes);
    const c = i % 2 ? 0xf4efe4 : team.color;
    b.box(aw, x, 0, 0, 2.3 / stripes, 0.035, 1.75, c, 'paint', false);
    b.box(aw, x, -0.18, 1.74, 2.3 / stripes, 0.18, 0.02, c, 'paint', false);
  }
  b.block(st, 0, R, 0.95, 1.5, 0.5, 0.32, 0x9a6a45, 'paint');
  b.box(st, 0, R + 1.04, 0.95, 1.62, 0.05, 0.42, 0x6b4630, 'paint');
  b.prop(st, 'trophy', 1.15, R + 1.09, 0.95, 1.3);
  b.prop(st, 'block', -1.15, R + 1.09, 0.95, 0.7, 0.3);
  for (const x of [-1, 1]) b.prop(st, 'weapon-rack', x, R, -0.85, 2.2);
  b.prop(st, 'banner', 2.75, R, 0.9, 2.6, 0, team.color);
  b.signDecal(st, 0, R + 3.72, -1.18, 2.8, 0.62, 0, team.color, 'МАГАЗИН');
  b.block(st, 0, R + 3.3, -1.32, 1.5, 0.12, 0.1, 0x6b4630, 'paint', false);
  // the keeper stands on a low step behind the counter (the character is short, the counter is not)
  const step = 0.5;
  b.block(st, 0, R, -0.2, 0.7, step / 2, 0.45, 0x5a3c2a, 'paint');
  b.data.bases.push({ team: team.id, up: f.up(), shop: st.raw(0, R + 1.4, 1.2),
    keeper: { pos: st.p(0, R + step + PLAYER_HEIGHT / 2, -0.2), quat: st.rot(0) } });
  b.block(r, 1, R, -6.2, 1.4, 0.5, 0.8, 0xa3a6aa, 'metal');
  b.block(r, 5.8, R, 0.5, 0.8, 0.5, 1.4, 0xa3a6aa, 'metal');

  // lift: street → roof
  const lift = f.sub(LIFT[0], 0, LIFT[1]);
  b.block(lift, 0, 0, 0, 1.3, 0.04, 1.3, 0x4ad8ff, 'glow', false);
  b.data.pads.push({ kind: 'lift', team: team.id, pos: lift.p(0, 0.08, 0), up: f.up(), radius: 1.3, target: r.p(-3, R + PLAYER_HEIGHT / 2 + 0.05, 0), apex: 14 });
  // descent: roof corner → street next to the lift
  const dsc = r.sub(-(hw - 2.2), 0, -(hw - 2.2));
  b.block(dsc, 0, R, 0, 1.3, 0.04, 1.3, 0x4ad8ff, 'glow', false);
  b.data.pads.push({ kind: 'descent', team: team.id, pos: dsc.p(0, R + 0.08, 0), up: f.up(), radius: 1.3,
    target: f.p(LIFT[0] - 1, PLAYER_HEIGHT / 2 + 0.05, LIFT[1] - 9), apex: 4 });
  // geyser: roof corner → middle island landing plaza
  const g = hw - 2.2;
  b.block(r, g, R, g, 1.3, 0.04, 1.3, 0xb05cff, 'glow', false);
  const mf = new Frame(new Vector3(...team.down).multiplyScalar(WORLD.midDistance), f.q.clone());
  b.data.pads.push({ kind: 'geyser', team: team.id, pos: r.p(g, R + 0.08, g), up: f.up(), radius: 1.3,
    target: mf.p(MID_LANDING[0], PLAYER_HEIGHT / 2 + 0.05 + SW, MID_LANDING[1]), apex: 16 });

  b.data.spawns[team.id] = { pos: r.p(-2.5, R + PLAYER_HEIGHT / 2 + 0.05, -2.5), quat: f.rot(0), yaw: spawnYaw };
}

// --- middle islands ----------------------------------------------------------------------------

const MID_LANDING: XZ = [26, 6];

/** Stepping stone between a base and the core: a smaller torn chunk with a gate to the team's core face. */
function genMidIsland(b: Builder, team: TeamDef, rng: Rng, faceFrame: Frame, addPortalPair: (a: Frame, bF: Frame, colorA: number, colorB: number) => void) {
  const up = new Vector3(...team.down).negate();
  const f = new Frame(new Vector3(...team.down).multiplyScalar(WORLD.midDistance), frameForUp(up));
  const tiles: Tile[] = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const corner = i !== 0 && j !== 0;
    if (corner && !rng.chance(0.55)) continue;
    let kind: TileKind = rng.pick(['construction', 'parking', 'houses']);
    if (i === 0 && j === 0) kind = 'gate';
    else if (i === 1 && j === 0) kind = 'landing';
    tiles.push({ i, j, kind });
  }
  const has = cityGround(b, f, rng, tiles, null);
  streets(b, f, rng, tiles, has, (x, z) => Math.abs(x) < 16 && Math.abs(z) < 16);
  for (const t of tiles) {
    const cx = t.i * TILE, cz = t.j * TILE;
    if (t.kind === 'construction') tileConstruction(b, f, rng, cx, cz);
    else if (t.kind === 'parking') tileParking(b, f, rng, cx, cz);
    else if (t.kind === 'houses') tileHouses(b, f, rng, cx, cz);
    else if (t.kind === 'landing') {
      b.floorDecal(f, 'spawn', MID_LANDING[0], SW, MID_LANDING[1], 3.2, 3.2, -Math.PI / 2, team.color);
      for (const s of [-1, 1]) barrier(b, f, cx + s * 6, cz - 7, 0, SW);
      bench(b, f, cx - 6, cz + 8, Math.PI);
    } else if (t.kind === 'gate') {
      // gate square: a portal to this team's face of the core
      for (const s of [-1, 1]) for (const k of [-1, 1]) barrier(b, f, s * 4.5, k * 10, 0, SW); // frame the gate, keep the lane free
      b.floorDecal(f, 'text', 0, SW, 5.5, 5, 1.1, 0, team.color, 'К ЦЕНТРУ');
    }
  }
  addPortalPair(f.sub(0, SW + 2, 0), faceFrame.sub(0, 2, 36), 0xf4efe4, team.color);
  b.data.mid[team.id] = { portal: [[0, 6], [0, -6]] };
}

// --- core --------------------------------------------------------------------------------------

const CORE_NORMALS: V3[] = [[0, 1, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0], [-1, 0, 0], [0, 0, -1]];

function faceTeam(n: V3): TeamDef | undefined {
  return TEAMS.find((t) => t.down[0] === -n[0] && t.down[1] === -n[1] && t.down[2] === -n[2]);
}

function genCore(b: Builder, rng: Rng) {
  const h = WORLD.coreHalf;
  const faces = CORE_NORMALS.map((n) => {
    const nv = new Vector3(...n);
    const f = new Frame(nv.clone().multiplyScalar(h), frameForUp(nv));
    const team = faceTeam(n);
    b.data.faces.push({ normal: n, quat: f.rot(0), team: team?.id ?? '' });
    return { n, f, team };
  });

  let id = 0;
  const gate = (pf: Frame, color: number) => {
    b.box(pf, -1.8, 0.3, 0, 0.3, 2.3, 0.35, 0x8c7a62, 'stone');
    b.box(pf, 1.8, 0.3, 0, 0.3, 2.3, 0.35, 0x8c7a62, 'stone');
    b.box(pf, 0, 2.3, 0, 2.1, 0.3, 0.35, 0x8c7a62, 'stone');
    for (const sz of [-1, 1]) {
      b.box(pf, -1.54, 0, sz * 0.36, 0.05, 2, 0.02, color, 'glow', false);
      b.box(pf, 1.54, 0, sz * 0.36, 0.05, 2, 0.02, color, 'glow', false);
      b.box(pf, 0, 2.04, sz * 0.36, 1.59, 0.05, 0.02, color, 'glow', false);
    }
  };
  /** Portal pair between two gate frames (frame origin = opening centre). colorA is shown at A (= where B leads). */
  const pair = (A: Frame, B: Frame, colorA: number, colorB: number) => {
    gate(A, colorA);
    gate(B, colorB);
    const a = id++, c = id++;
    b.data.portals.push({ id: a, partner: c, pos: A.p(0, 0, 0), quat: A.rot(0), width: 3, height: 4, color: colorA });
    b.data.portals.push({ id: c, partner: a, pos: B.p(0, 0, 0), quat: B.rot(0), width: 3, height: 4, color: colorB });
  };
  const link = (fa: number, xa: number, za: number, fb: number, xb: number, zb: number) =>
    pair(faces[fa].f.sub(xa, 2, za), faces[fb].f.sub(xb, 2, zb), faces[fb].team!.color, faces[fa].team!.color);

  const teamFace = (t: TeamDef) => faces.findIndex((x) => x.team === t);
  const [red, blue, green, yellow] = ['red', 'blue', 'green', 'yellow'].map((idn) => teamFace(TEAMS.find((t) => t.id === idn)!));
  // opposite faces + a ring through the four team faces
  link(red, 0, -24, blue, 0, -24);
  link(green, 0, -24, yellow, 0, -24);
  const ring = [red, yellow, blue, green];
  for (let i = 0; i < 4; i++) link(ring[i], 30, 21, ring[(i + 1) % 4], -30, 21);

  // cover: walls, pillars, crates and ruins on a jittered grid; the axes stay clear (drop runs + portal lanes)
  const keepOut: XZ[] = [[0, -24], [30, 21], [-30, 21], [0, 36], [0, 6]];
  for (const { f, team } of faces) {
    if (!team) continue;
    for (let gx = -48; gx <= 48; gx += 12) for (let gz = -48; gz <= 48; gz += 12) {
      const x = gx + rng.range(-3, 3), z = gz + rng.range(-3, 3);
      if (Math.abs(x) < 7 || Math.abs(z) < 7) continue;
      if (keepOut.some(([kx, kz]) => Math.hypot(x - kx, z - kz) < 8)) continue;
      if (!rng.chance(0.7)) continue;
      const r = rng.next();
      const yaw = rng.chance(0.5) ? 0 : Math.PI / 2;
      if (r < 0.35) {
        b.block(f, x, 0, z, 2.4, 0.6, 0.4, 0xcdbb98, 'stone', true, yaw);
        b.box(f, x, 1.22, z, 2.4, 0.02, 0.4, 0xffc65a, 'glow', false, yaw);
      } else if (r < 0.55) {
        b.block(f, x, 0, z, 0.9, 2.4, 0.9, 0xcdbb98, 'stone');
        b.box(f, x, 4.82, z, 0.9, 0.02, 0.9, 0xffc65a, 'glow', false);
      } else if (r < 0.75) {
        // ruined wall: L-shape with a broken top
        const w = f.sub(x, 0, z, yaw);
        b.block(w, 0, 0, 0, 3, rng.range(1.2, 2.2), 0.35, 0xbfae8c, 'stone');
        b.block(w, 2.7, 0, 1.5, 0.35, rng.range(0.8, 1.8), 1.5, 0xbfae8c, 'stone');
        b.hull(w, [[-3, 2, -0.35], [-1, 2, -0.35], [-3, 3.4, -0.35], [-3, 2, 0.35], [-1, 2, 0.35], [-3, 3.4, 0.35]], 0xbfae8c, 'stone');
      } else {
        const c = f.sub(x, 0, z, rng.range(0, Math.PI));
        b.block(c, 0, 0, 0, 0.75, 0.75, 0.75, 0x9a7a52, 'paint');
        if (rng.chance(0.5)) b.block(c, 1.3, 0, 0.3, 0.6, 0.6, 0.6, 0x8a6a46, 'paint');
        if (rng.chance(0.4)) b.block(c, 0.1, 1.5, 0.1, 0.55, 0.55, 0.55, 0x9a7a52, 'paint');
      }
    }
    // upgrade-crystal spawn spot
    b.block(f, 0, 0, 6, 1.4, 0.08, 1.4, 0xa89676, 'stone');
    b.data.crystalSpots.push({ pos: f.p(0, 0.16, 6), up: f.up() });
    b.hull(f, [[0, 2.6, 6], [0, 0.9, 6], [0.45, 1.6, 6], [-0.45, 1.6, 6], [0, 1.6, 6.45], [0, 1.6, 5.55]], 0x8af5ff, 'glow', false);
  }
  return { faces, pair };
}

export function generateMap(seed = 1337, spawnTeam = 'red'): MapData {
  const b = new Builder(seed);
  const rng = new Rng(seed);
  const { faces, pair } = genCore(b, rng);
  for (const team of TEAMS) {
    genBaseIsland(b, team, rng, team.id === spawnTeam);
    const face = faces.find((x) => x.team === team)!;
    genMidIsland(b, team, rng, face.f, pair);
  }
  return b.data;
}
