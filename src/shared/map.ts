import { Matrix4, Quaternion, Vector3 } from 'three';
import { PLAYER_HEIGHT, WORLD } from './constants';
import { frameForUp, Rng } from './math';
import { TEAMS, TeamDef, teamByDown } from './teams';

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];
export type MatKind =
  | 'concrete' | 'asphalt' | 'paving' | 'grass' | 'water' | 'dirt' | 'rock' | 'metal'
  | 'car' | 'glass' | 'paint' | 'plaster' | 'stone' | 'test' | 'glow';

export interface BoxDef { pos: V3; quat: Q4; half: V3; color: number; mat: MatKind; collide: boolean }
export interface HullDef { points: number[]; color: number; mat: MatKind; collide: boolean }
/** Tall building with a facade texture. style: glass skyscraper or concrete office block. */
export interface BuildingDef { pos: V3; quat: Q4; half: V3; color: number; style: 'tower' | 'office' }
/** Old-town house: walls + gabled tile roof (ridge along local X). pos = center of the footprint on the ground. */
export interface HouseDef { pos: V3; quat: Q4; size: V3; roofH: number; wall: number; roof: number }
export interface TreeDef { pos: V3; up: V3; scale: number; kind: 'tree' | 'bush' }
/** Portal opening. Local frame: +Y = up of the face it stands on, ±Z = the two sides. pos = opening center. */
export interface PortalDef { id: number; partner: number; pos: V3; quat: Q4; width: number; height: number; color: number }
/** Magic lift / geyser: ballistic launch onto `target` (until building exists). */
export interface PadDef { pos: V3; up: V3; radius: number; target: V3; apex: number; kind: 'lift' | 'geyser' }
export interface SpawnDef { pos: V3; quat: Q4; yaw: number }
export interface StatueDef { team: string; pos: V3; up: V3; color: number }
export interface FaceDef { normal: V3; quat: Q4; team: string }

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
  faces: FaceDef[];
  coreHalf: number;
  killRadius: number;
}

const _v = new Vector3();
const _q = new Quaternion();
const Y = new Vector3(0, 1, 0);

/** Local coordinate frame used to build pieces (island, face, car…) and emit world-space data. */
class Frame {
  readonly m = new Matrix4();
  constructor(readonly origin: Vector3, readonly q: Quaternion) {
    this.m.compose(origin, q, new Vector3(1, 1, 1));
  }
  p(x: number, y: number, z: number): V3 {
    _v.set(x, y, z).applyMatrix4(this.m);
    return [_v.x, _v.y, _v.z];
  }
  rot(yaw = 0): Q4 {
    const q = this.q.clone().multiply(_q.setFromAxisAngle(Y, yaw));
    return [q.x, q.y, q.z, q.w];
  }
  sub(x: number, y: number, z: number, yaw = 0): Frame {
    const o = new Vector3(x, y, z).applyMatrix4(this.m);
    return new Frame(o, this.q.clone().multiply(new Quaternion().setFromAxisAngle(Y, yaw)));
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
      statues: [], faces: [], coreHalf: WORLD.coreHalf, killRadius: WORLD.killRadius,
    };
  }
  box(f: Frame, x: number, y: number, z: number, hx: number, hy: number, hz: number,
    color: number, mat: MatKind, collide = true, yaw = 0) {
    this.data.boxes.push({ pos: f.p(x, y, z), quat: f.rot(yaw), half: [hx, hy, hz], color, mat, collide });
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
    style: 'tower' | 'office') {
    this.data.buildings.push({ pos: f.p(x, y0 + hy, z), quat: f.rot(0), half: [hx, hy, hz], color, style });
  }
  house(f: Frame, x: number, y0: number, z: number, w: number, h: number, d: number, roofH: number,
    wall: number, roof: number, yaw = 0) {
    this.data.houses.push({ pos: f.p(x, y0, z), quat: f.rot(yaw), size: [w, h, d], roofH, wall, roof });
  }
  tree(f: Frame, x: number, y0: number, z: number, scale: number, kind: 'tree' | 'bush') {
    this.data.trees.push({ pos: f.p(x, y0, z), up: f.up(), scale, kind });
  }
}

const SW = 0.15; // sidewalk height
const WALL_COLORS = [0xe8dcc0, 0xdcc9a0, 0xe3b48f, 0xc98f6e, 0x9fc4b8, 0x7fb0a8, 0xb9c98f, 0xe6d27a, 0xd99a8a, 0xcfd3cf, 0xa9c2d6];
const ROOF_COLORS = [0xc8643a, 0xb5532f, 0xd47a45, 0xa94a30, 0xc06a48, 0x9c5a3c];
const CAR_COLORS = [0xd9d9d9, 0x2a2a2e, 0xb3261e, 0x2b5cad, 0xe0b020, 0x3a7d44, 0x8a8f99, 0xf2f2f2];

function car(b: Builder, f: Frame, x: number, y0: number, z: number, yaw: number, color: number) {
  const c = f.sub(x, y0, z, yaw);
  b.box(c, 0, 0.75, 0, 0.95, 0.42, 2.15, color, 'car');
  b.box(c, 0, 1.5, 0.15, 0.82, 0.33, 1.15, 0x2a3440, 'glass');
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    b.box(c, sx * 0.9, 0.33, sz * 1.35, 0.12, 0.33, 0.33, 0x18181a, 'metal', false);
  for (const sx of [-1, 1]) {
    b.box(c, sx * 0.6, 0.85, -2.16, 0.22, 0.07, 0.02, 0xfff2c8, 'paint', false);
    b.box(c, sx * 0.6, 0.85, 2.16, 0.22, 0.07, 0.02, 0xc81e1e, 'paint', false);
  }
}

function lamp(b: Builder, f: Frame, x: number, z: number, ax: number, az: number) {
  b.block(f, x, SW, z, 0.07, 2.5, 0.07, 0x2f3a33, 'metal');
  const alongX = ax !== 0;
  b.box(f, x + ax * 0.6, SW + 4.95, z + az * 0.6, alongX ? 0.6 : 0.05, 0.05, alongX ? 0.05 : 0.6, 0x2f3a33, 'metal', false);
  b.box(f, x + ax * 1.15, SW + 4.85, z + az * 1.15, alongX ? 0.3 : 0.18, 0.08, alongX ? 0.18 : 0.3, 0xfff1cf, 'paint', false);
}

function trafficLight(b: Builder, f: Frame, x: number, z: number) {
  b.block(f, x, SW, z, 0.08, 1.8, 0.08, 0x2c2f35, 'metal');
  b.box(f, x, SW + 3.9, z, 0.2, 0.55, 0.2, 0x1d1f24, 'metal', false);
  const lights = [0xff3030, 0x5a4a20, 0x1f5a2a];
  lights.forEach((c, i) => {
    const y = SW + 4.25 - i * 0.35;
    b.box(f, x - Math.sign(x) * 0.21, y, z, 0.01, 0.12, 0.12, c, i === 0 ? 'glow' : 'paint', false);
    b.box(f, x, y, z - Math.sign(z) * 0.21, 0.12, 0.12, 0.01, c, i === 0 ? 'glow' : 'paint', false);
  });
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
function houseRow(b: Builder, f: Frame, rng: Rng, axis: 'x' | 'z', a0: number, a1: number, d0: number, d1: number) {
  const depth = d1 - d0;
  const dc = (d0 + d1) / 2;
  let a = Math.min(a0, a1);
  const end = Math.max(a0, a1);
  while (end - a > 3.5) {
    let w = rng.range(4.5, 7.5);
    if (end - a - w < 3.5) w = end - a;
    const c = a + w / 2;
    const floors = rng.int(2, 4);
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

function genIsland(b: Builder, team: TeamDef, rng: Rng, playground: boolean) {
  const H = WORLD.islandHalf;
  const D = WORLD.islandDistance;
  const down = new Vector3(...team.down);
  const up = down.clone().negate();
  const f = new Frame(down.clone().multiplyScalar(D), frameForUp(up));

  // --- ground: a city block cut out of the world
  b.box(f, 0, -2, 0, H, 2, H, 0x9a948a, 'concrete');
  b.box(f, 0, -4.7, 0, H - 0.6, 0.7, H - 0.6, 0x7a5a3e, 'dirt');
  const chunk: number[][] = [];
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    chunk.push([sx * (H - 1.2), -5.3, sz * (H - 1.2)]);
    chunk.push([sx * rng.range(12, 17), -17 + rng.range(-2, 2), sz * rng.range(12, 17)]);
  }
  chunk.push([rng.range(-3, 3), -24, rng.range(-3, 3)]);
  b.hull(f, chunk, 0x6a5848, 'rock');
  for (let i = 0; i < 6; i++) {
    b.hull(f, rockChunk(rng.range(-20, 20), -5.5, rng.range(-20, 20), rng.range(2, 5), rng.range(5, 13), rng),
      0x7a6553, 'rock');
  }
  for (let i = 0; i < 5; i++) {
    const side = rng.int(0, 3);
    const t = rng.range(-24, 24);
    const len = rng.range(0.8, 2.4);
    const y = rng.range(-3.6, -1.2);
    const out = H + len / 2 - 0.3;
    if (side < 2) b.box(f, side === 0 ? out : -out, y, t, len / 2, 0.2, 0.2, 0x8a8f96, 'metal');
    else b.box(f, t, y, side === 2 ? out : -out, 0.2, 0.2, len / 2, 0x8a8f96, 'metal');
  }
  // team-colored curb around the island = readable from afar
  for (const s of [-1, 1]) {
    b.box(f, 0, 0.2, s * (H - 0.15), H, 0.2, 0.15, team.color, 'glow', false);
    b.box(f, s * (H - 0.15), 0.2, 0, 0.15, 0.2, H, team.color, 'glow', false);
  }

  // --- roads
  b.box(f, 0, 0.012, 0, 4, 0.012, H, 0x77736d, 'asphalt', false);
  b.box(f, 0, 0.013, 0, H, 0.012, 4, 0x77736d, 'asphalt', false);
  for (let t = -28; t <= 28; t += 4) {
    if (Math.abs(t) < 6) continue;
    b.box(f, 0, 0.027, t, 0.08, 0.004, 0.9, 0xece6d6, 'paint', false);
    b.box(f, t, 0.027, 0, 0.9, 0.004, 0.08, 0xece6d6, 'paint', false);
  }
  for (const s of [-1, 1]) for (let k = -3; k <= 3; k++) {
    b.box(f, k * 1.1, 0.028, s * 5.2, 0.35, 0.004, 0.9, 0xf0ece2, 'paint', false);
    b.box(f, s * 5.2, 0.028, k * 1.1, 0.9, 0.004, 0.35, 0xf0ece2, 'paint', false);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    b.block(f, sx * 17, 0, sz * 17, 13, SW / 2, 13, 0xcfc4ac, 'paving');

  for (const t of [-24, -12, 12, 24]) {
    lamp(b, f, 4.6, t, -1, 0);
    lamp(b, f, -4.6, t - 6 * Math.sign(t), 1, 0);
    lamp(b, f, t, 4.6, 0, -1);
    lamp(b, f, t - 6 * Math.sign(t), -4.6, 0, 1);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) trafficLight(b, f, sx * 4.9, sz * 4.9);

  const nCars = rng.int(4, 7);
  for (let i = 0; i < nCars; i++) {
    const t = rng.pick([-1, 1]) * rng.range(8, 22);
    const lane = rng.pick([-1, 1]) * 2;
    const col = rng.pick(CAR_COLORS);
    if (rng.chance(0.5)) car(b, f, lane, 0.02, t, lane > 0 ? 0 : Math.PI, col);
    else car(b, f, t, 0.02, lane, lane > 0 ? Math.PI / 2 : -Math.PI / 2, col);
  }

  // --- quadrants
  genBase(b, f, team); // (+,+): team skyscraper
  // (+,-): office tower + skybridge + houses
  b.building(f, 19, SW, -17, 5, 18, 5, rng.pick([0xd8cdb6, 0xc9c0ad, 0xbfc6c4]), 'office');
  b.block(f, 19, SW + 36, -17, 1.2, 0.6, 1.2, 0x9a9da2, 'metal');
  b.building(f, 19, SW + 28, -0.25, 2.5, 2, 11.75, 0xa9b8bf, 'tower');
  houseRow(b, f, rng, 'z', -5.5, -28.5, 5.5, 12.5);
  houseRow(b, f, rng, 'x', 13, 28.5, -28.5, -23);
  // (-,+): two rows of houses with a green courtyard
  houseRow(b, f, rng, 'x', -5.5, -28.5, 5.5, 13);
  houseRow(b, f, rng, 'x', -5.5, -28.5, 20.5, 28.5);
  b.block(f, -17, SW, 16.75, 11.5, 0.03, 3.2, 0x6f9a45, 'grass');
  for (let i = 0; i < 7; i++) b.tree(f, -27 + i * 3.6 + rng.range(-0.6, 0.6), SW + 0.06, 16.75 + rng.range(-1.6, 1.6),
    rng.range(0.7, 1.3), rng.chance(0.4) ? 'tree' : 'bush');
  // (-,-): playground (spawn team) or park with a canal
  if (playground) genPlayground(b, f, rng);
  else genPark(b, f, rng);
}

function genBase(b: Builder, f: Frame, team: TeamDef) {
  const cx = 19;
  const cz = 19;
  const hw = 7.5;
  const height = 46;
  const R = SW + height;
  b.building(f, cx, SW, cz, hw, height / 2, hw, 0xc4ccd0, 'tower');
  // team stripes on the corners — the base is recognisable from any island
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    b.block(f, cx + sx * (hw + 0.05), SW, cz + sz * (hw + 0.05), 0.16, height / 2 + 0.6, 0.16, team.color, 'glow', false);
  // entrance canopy
  b.block(f, cx - hw - 1.2, SW + 3.6, cz, 1.2, 0.12, 3, team.color, 'paint', false);
  // roof: parapet with gaps in the middle of each side
  const edge = hw - 0.15;
  for (const s of [-1, 1]) for (const half of [-1, 1]) {
    const c = half * (hw / 2 + 1.25);
    const len = hw / 2 - 1.25;
    b.block(f, cx + c, R, cz + s * edge, len, 0.35, 0.15, 0xb7b3a8, 'plaster');
    b.block(f, cx + s * edge, R, cz + c, 0.15, 0.35, len, 0xb7b3a8, 'plaster');
  }
  b.block(f, cx, R, cz, 3, 0.01, 3, team.color, 'paint', false);
  // statue (the "bed")
  const sx = cx - 1;
  const sz = cz + 4;
  b.block(f, sx, R, sz, 1.5, 0.6, 1.5, 0xd8d2c4, 'stone');
  b.block(f, sx, R + 1.2, sz, 1.0, 0.4, 1.0, 0xe4dfd2, 'stone');
  const cy = R + 4;
  b.hull(f, [[sx, cy + 2.2, sz], [sx, cy - 2.2, sz], [sx + 0.9, cy, sz], [sx - 0.9, cy, sz], [sx, cy, sz + 0.9], [sx, cy, sz - 0.9]],
    team.color, 'glow');
  b.data.statues.push({ team: team.id, pos: f.p(sx, cy + 3.6, sz), up: f.up(), color: team.color });
  // shop kiosk
  b.block(f, cx - 4, R, cz + 4.5, 2.2, 1.4, 1.6, 0xf1ead8, 'plaster');
  b.box(f, cx - 4, R + 2.95, cz + 2.6, 2.5, 0.08, 0.7, team.color, 'paint', false);
  b.box(f, cx - 4, R + 3.2, cz + 4.5, 1.7, 0.3, 0.06, team.color, 'glow', false);
  // resource generator
  b.block(f, cx + 4.5, R, cz - 4.5, 1.4, 0.05, 1.4, 0xffc94a, 'glow', false);
  for (const gx of [-1, 1]) for (const gz of [-1, 1])
    b.block(f, cx + 4.5 + gx * 1.5, R, cz - 4.5 + gz * 1.5, 0.12, 0.6, 0.12, 0x6a6d74, 'metal');
  // water tower + AC units
  for (const gx of [-1, 1]) for (const gz of [-1, 1])
    b.block(f, cx - 5.5 + gx * 0.9, R, cz - 0.5 + gz * 0.9, 0.08, 1, 0.08, 0x5a4a3a, 'metal');
  b.block(f, cx - 5.5, R + 2, cz - 0.5, 1.2, 1.1, 1.2, 0x8a6a4a, 'plaster');
  b.block(f, cx + 1, R, cz - 6, 1.4, 0.5, 0.8, 0xa3a6aa, 'metal');
  b.block(f, cx + 5.8, R, cz + 0.5, 0.8, 0.5, 1.4, 0xa3a6aa, 'metal');

  // magic lift: street → roof
  b.block(f, 6, SW, cz, 1.3, 0.04, 1.3, 0x4ad8ff, 'glow', false);
  b.data.pads.push({
    kind: 'lift', pos: f.p(6, SW + 0.08, cz), up: f.up(), radius: 1.3,
    target: f.p(cx - 3, R + PLAYER_HEIGHT / 2 + 0.05, cz), apex: 12,
  });
  // geyser: roof → central island (passes the core's corner, where there are no portals)
  const g = cx + hw - 2.2;
  b.block(f, g, R, g, 1.3, 0.04, 1.3, 0xb05cff, 'glow', false);
  b.data.pads.push({
    kind: 'geyser', pos: f.p(g, R + 0.08, g), up: f.up(), radius: 1.3,
    target: f.p(17, WORLD.islandDistance + WORLD.coreHalf + PLAYER_HEIGHT / 2 + 0.05, 17), apex: 16,
  });

  b.data.spawns[team.id] = { pos: f.p(cx - 2.5, R + PLAYER_HEIGHT / 2 + 0.05, cz - 2.5), quat: f.rot(0), yaw: Math.PI / 4 };
}

function genPark(b: Builder, f: Frame, rng: Rng) {
  b.block(f, -17, SW, -17, 12.5, 0.03, 12.5, 0x6f9a45, 'grass');
  // canal with stone embankments
  b.block(f, -17, SW + 0.031, -16.5, 12.5, 0.01, 1.6, 0x3fb6c4, 'water', false);
  for (const s of [-1, 1]) b.block(f, -17, SW, -16.5 + s * 1.75, 12.5, 0.18, 0.15, 0xd8cfbb, 'stone');
  // little bridge
  b.block(f, -12, SW + 0.33, -16.5, 1.4, 0.12, 2.1, 0xb59a7a, 'stone');
  // paths
  b.block(f, -17, SW + 0.032, -9, 12.5, 0.005, 0.9, 0xd9ccaf, 'paving', false);
  b.block(f, -12, SW + 0.032, -23, 0.9, 0.005, 6, 0xd9ccaf, 'paving', false);
  for (let i = 0; i < 16; i++) {
    let x = rng.range(-28, -6);
    let z = rng.range(-28, -6);
    if (Math.abs(z + 16.5) < 2.6) z += 4;
    if (Math.abs(z + 9) < 1.2) x = -6.5;
    b.tree(f, x, SW + 0.06, z, rng.range(0.7, 1.4), rng.chance(0.45) ? 'tree' : 'bush');
  }
}

function genPlayground(b: Builder, f: Frame, rng: Rng) {
  const T = 0x6c7cff;
  b.block(f, -17, SW, -17, 12.5, 0.002, 12.5, 0xb9ae96, 'paving', false);
  for (let i = 0; i < 8; i++) b.block(f, -7.3 - i * 0.6, SW, -9.5, 0.3, (i + 1) * 0.15, 1.5, i % 2 ? T : 0x8a96ff, 'test');
  b.block(f, -13.8, SW, -9.5, 2, 1.2, 1.5, T, 'test');
  [0.5, 1, 1.5, 2, 2.5].forEach((h, i) => b.block(f, -7.5 - i * 2.6, SW, -15, 0.9, h / 2, 0.9, 0xff9a3b, 'test'));
  const sy = SW + 4.8;
  b.hull(f, [[-27.5, SW, -28], [-19.5, SW, -28], [-23.5, sy, -28], [-27.5, SW, -6], [-19.5, SW, -6], [-23.5, sy, -6]], 0x3bd1ff, 'test');
  b.hull(f, [[-6, SW, -28], [-6, SW, -22], [-16, SW, -28], [-16, SW, -22], [-16, SW + 3, -28], [-16, SW + 3, -22]], 0x9aff6b, 'test');
  // shooting targets wall
  b.block(f, -9, SW, -19.5, 3, 1.5, 0.2, 0xe8e2d0, 'plaster');
  for (let i = 0; i < 3; i++) b.tree(f, -28 + i * 1.5, SW, -4.9 - rng.range(0, 0.3), 0.8, 'bush');
}

const CORE_NORMALS: V3[] = [[0, 1, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0], [-1, 0, 0], [0, 0, -1]];

function genCore(b: Builder, rng: Rng) {
  const h = WORLD.coreHalf;
  const faces = CORE_NORMALS.map((n) => {
    const nv = new Vector3(...n);
    const f = new Frame(nv.clone().multiplyScalar(h), frameForUp(nv));
    const team = teamByDown(nv.clone().negate());
    b.data.faces.push({ normal: n, quat: f.rot(0), team: team.id });
    return { n, f, team };
  });

  const coverSpots: [number, number][] = [[-15, -15], [15, -15], [-15, 15], [15, 15], [0, 15], [-16, -3], [16, -3]];
  for (const { f } of faces) {
    for (const [x, z] of coverSpots) {
      if (!rng.chance(0.6)) continue;
      if (rng.chance(0.5)) {
        const yaw = rng.chance(0.5) ? 0 : Math.PI / 2;
        b.block(f, x, 0, z, 2.2, 0.6, 0.4, 0xcdbb98, 'stone', true, yaw);
        b.box(f, x, 1.22, z, 2.2, 0.02, 0.4, 0xffc65a, 'glow', false, yaw);
      } else {
        b.block(f, x, 0, z, 0.9, 2.2, 0.9, 0xcdbb98, 'stone');
        b.box(f, x, 4.42, z, 0.9, 0.02, 0.9, 0xffc65a, 'glow', false);
      }
    }
    // upgrade-crystal spawn spot
    b.block(f, 0, 0, 2, 1.4, 0.08, 1.4, 0xa89676, 'stone');
    b.hull(f, [[0, 2.6, 2], [0, 0.9, 2], [0.45, 1.6, 2], [-0.45, 1.6, 2], [0, 1.6, 2.45], [0, 1.6, 1.55]], 0x8af5ff, 'glow', false);
  }

  let id = 0;
  const addPortal = (fi: number, x: number, z: number, partnerFi: number): number => {
    const { f } = faces[fi];
    const pf = f.sub(x, 2, z);
    const color = TEAMS.find((t) => t.id === faces[partnerFi].team.id)!.color;
    b.box(pf, -1.8, 0.3, 0, 0.3, 2.3, 0.35, 0x8c7a62, 'stone');
    b.box(pf, 1.8, 0.3, 0, 0.3, 2.3, 0.35, 0x8c7a62, 'stone');
    b.box(pf, 0, 2.3, 0, 2.1, 0.3, 0.35, 0x8c7a62, 'stone');
    for (const sz of [-1, 1]) {
      b.box(pf, -1.54, 0, sz * 0.36, 0.05, 2, 0.02, color, 'glow', false);
      b.box(pf, 1.54, 0, sz * 0.36, 0.05, 2, 0.02, color, 'glow', false);
      b.box(pf, 0, 2.04, sz * 0.36, 1.59, 0.05, 0.02, color, 'glow', false);
    }
    b.data.portals.push({ id, partner: -1, pos: f.p(x, 2, z), quat: pf.rot(0), width: 3, height: 4, color });
    return id++;
  };
  const link = (fa: number, xa: number, za: number, fb: number, xb: number, zb: number) => {
    const a = addPortal(fa, xa, za, fb);
    const c = addPortal(fb, xb, zb, fa);
    b.data.portals[a].partner = c;
    b.data.portals[c].partner = a;
  };
  // opposite faces
  link(0, 0, -8, 3, 0, -8);
  link(1, 0, -8, 4, 0, -8);
  link(2, 0, -8, 5, 0, -8);
  // ring of neighbouring faces
  for (let i = 0; i < 6; i++) link(i, 10, 7, (i + 1) % 6, -10, 7);
}

export function generateMap(seed = 1337, spawnTeam = 'red'): MapData {
  const b = new Builder(seed);
  const rng = new Rng(seed);
  for (const team of TEAMS) genIsland(b, team, rng, team.id === spawnTeam);
  genCore(b, rng);
  return b.data;
}