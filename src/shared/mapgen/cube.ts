import { Quaternion, Vector3 } from 'three';
import { piecePlan, PIECE_CELL, PIECE_LEVEL, PieceKind } from '../blocks';
import { WORLD } from '../constants';
import { frameForUp, Rng } from '../math';
import { TEAMS, TeamDef } from '../teams';
import { Builder, FaceDef, FaceId, FaceNav, Frame, key, LaneDef, LanePiece, MapData, plate, V3, XZ } from './core';
import { barrier, bench, bin, BLOCK, hydrant, lamp, SW, TILE } from './props';
import { fillTile, hallNav, OWN_GROUND, parkCars, pondRect, PONDS, Tile, TileKind } from './tiles';

const S = WORLD.cubeHalf;
const FH = WORLD.faceHalf;
/** Tiles per face side (5 × 36 m = 180 m = 2 × faceHalf). */
const N = 2;

/** The six faces and their inward normals. */
export const FACE_UP: Record<FaceId, V3> = {
  ny: [0, 1, 0], py: [0, -1, 0], nx: [1, 0, 0], px: [-1, 0, 0], nz: [0, 0, 1], pz: [0, 0, -1],
};
export const FACE_IDS = Object.keys(FACE_UP) as FaceId[];

export function faceFrame(id: FaceId): Frame {
  const up = new Vector3(...FACE_UP[id]);
  return new Frame(up.clone().multiplyScalar(-S), frameForUp(up));
}

/** Bridge geometry over a cube edge (all distances from the face centre, m): see LaneDef. */
export const LANE = {
  /** Side coordinate (along the edge) of the floors on face a / of the landing on face b (cell centres). */
  floorS: -51,
  landS: 51,
  /** Out coordinate of the ramp column (the cell next to the corner). */
  rampO: S - PIECE_CELL / 2,
  floors: (S - FH) / PIECE_CELL,
  ramps: (S - FH) / PIECE_LEVEL,
};

/** Road graph: corners of the tiles, edges along the roads between two tiles. */
function roadGraph(tiles: Tile[]) {
  const has = new Set(tiles.map((t) => key(t.i, t.j)));
  const nodes: XZ[] = [];
  const index = new Map<string, number>();
  // a road meets the rim at the kerb: its node sits in the middle of the last half road instead
  const R = N * TILE + TILE / 2 - 3;
  const node = (x0: number, z0: number) => {
    const x = Math.max(-R, Math.min(R, x0)), z = Math.max(-R, Math.min(R, z0));
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

/** Shortest road path between two nodes (node indices, both ends included). */
export function navPath(nav: FaceNav, from: number, to: number): number[] {
  const n = nav.nodes.length;
  const d = (a: number, b: number) => Math.hypot(nav.nodes[a][0] - nav.nodes[b][0], nav.nodes[a][1] - nav.nodes[b][1]);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of nav.edges) { adj[a].push(b); adj[b].push(a); }
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === to) break;
    done[u] = true;
    for (const v of adj[u]) if (dist[u] + d(u, v) < dist[v]) { dist[v] = dist[u] + d(u, v); prev[v] = u; }
  }
  if (dist[to] === Infinity) return [to];
  const path: number[] = [];
  for (let u = to; u >= 0; u = prev[u]) path.unshift(u);
  return path;
}

export function nearestNode(nav: FaceNav, p: XZ): number {
  let best = 0, bd = Infinity;
  nav.nodes.forEach((q, i) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

// --- one face ----------------------------------------------------------------------------------

interface FacePlan { id: FaceId; team: TeamDef | null; f: Frame; tiles: Tile[]; seams: XZ[] }

const POOL: TileKind[] = [
  'tower', 'tower', 'tower', 'office', 'office', 'office', 'houses', 'houses', 'houses', 'houses',
  'park', 'park', 'pond', 'parking', 'parking', 'construction', 'construction', 'plaza',
];

function planTiles(rng: Rng, team: TeamDef | null): Tile[] {
  const special = new Map<string, TileKind>();
  const free = () => {
    for (;;) {
      const i = rng.int(-N, N), j = rng.int(-N, N);
      if (!special.has(key(i, j)) && Math.max(Math.abs(i), Math.abs(j)) > 0) return key(i, j);
    }
  };
  if (team) {
    special.set(key(0, 0), 'hall');
    special.set(free(), 'pond');
    special.set(free(), 'park');
  } else {
    special.set(key(0, 0), 'square');
    const alongX = rng.chance(0.5);
    special.set(alongX ? key(1, 0) : key(0, 1), 'market');
    special.set(alongX ? key(-1, 0) : key(0, -1), 'market');
    special.set(free(), 'museum');
    special.set(free(), rng.pick(['park', 'pond'] as TileKind[]));
  }
  const tiles: Tile[] = [];
  for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) tiles.push({ i, j, kind: special.get(key(i, j)) ?? rng.pick(POOL) });
  return tiles;
}

/** Ground slabs, sidewalks, road markings, the kerb along the rim (open where a bridge lane leaves). */
function faceGround(b: Builder, p: FacePlan) {
  const { f, tiles, seams } = p;
  const H = TILE / 2;
  const nearSeam = (x: number, z: number, r: number) => seams.some((s) => Math.hypot(s[0] - x, s[1] - z) < r);
  for (const t of tiles) {
    const cx = t.i * TILE, cz = t.j * TILE;
    const hole = PONDS[t.kind] ? pondRect(t.kind, cx, cz) : null;
    // asphalt slab (the road surface is its top) with a hole for a sunken pond, a concrete layer under it
    if (!hole) b.span(f, cx - H, -1.5, cz - H, cx + H, 0, cz + H, 0x77736d, 'asphalt');
    else {
      b.span(f, cx - H, -1.5, cz - H, hole.x0, 0, cz + H, 0x77736d, 'asphalt');
      b.span(f, hole.x1, -1.5, cz - H, cx + H, 0, cz + H, 0x77736d, 'asphalt');
      b.span(f, hole.x0, -1.5, cz - H, hole.x1, 0, hole.z0, 0x77736d, 'asphalt');
      b.span(f, hole.x0, -1.5, hole.z1, hole.x1, 0, cz + H, 0x77736d, 'asphalt');
    }
    b.span(f, cx - H + 0.3, -3.2, cz - H + 0.3, cx + H - 0.3, -1.5, cz + H - 0.3, 0x8f8a80, 'concrete');
    if (!OWN_GROUND.has(t.kind)) b.block(f, cx, 0, cz, BLOCK, SW / 2, BLOCK, 0xcfc4ac, 'paving');

    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as XZ[]) {
      const rim = Math.abs(t.i + di) > N || Math.abs(t.j + dj) > N;
      // side frame: local +z points out of the tile through this side, x runs along it
      const s = f.sub(cx + di * H, 0, cz + dj * H, Math.atan2(di, dj));
      if (!rim) {
        // shared road: dashed centre line (drawn once, from the tile with the smaller index)
        if (di + dj > 0) for (let a = -H + 7; a <= H - 7; a += 3.6) b.box(s, a, 0.015, 0, 0.9, 0.012, 0.08, 0xece6d6, 'paint', false);
        continue;
      }
      // the rim: a low kerb (step over it, or build from it), team-coloured light on top; open at bridge lanes
      for (let a = -H; a < H; a += PIECE_CELL) {
        const m = a + PIECE_CELL / 2;
        const w = new Vector3(...s.p(m, 0, -0.3));
        const l = f.local(w);
        if (nearSeam(l.x, l.z, 4)) {
          // bridge start: chevrons on the road
          for (let k = 0; k < 3; k++) b.box(s, m, 0.015, -1.2 - k * 1.4, 1.6, 0.012, 0.25, p.team ? p.team.color : 0xe8e2d0, 'paint', false);
          continue;
        }
        b.box(s, m, 0.15, -0.25, PIECE_CELL / 2, 0.15, 0.25, 0xb0a99a, 'concrete');
        b.box(s, m, 0.33, -0.25, PIECE_CELL / 2 - 0.05, 0.03, 0.05, p.team ? p.team.color : 0xe8e2d0, 'glow', false);
      }
    }
  }
}

/** Street lamps, benches, bins, parked cars, barriers. */
function faceStreets(b: Builder, p: FacePlan, rng: Rng) {
  const { f, tiles, seams } = p;
  const H = TILE / 2;
  const furnished = new Set<TileKind>(['tower', 'office', 'parking', 'museum', 'market', 'plaza', 'square']);
  const clear = (x: number, z: number) =>
    seams.some((s) => Math.hypot(s[0] - x, s[1] - z) < 12) // bridge starts
    || (Math.abs(x) < 24 && Math.abs(z) < 24); // around the hall / the square
  for (const t of tiles) {
    const cx = t.i * TILE, cz = t.j * TILE;
    if (t.kind !== 'hall') for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) lamp(b, f, cx + sx * (BLOCK - 0.5), cz + sz * (BLOCK - 0.5), Math.atan2(sx, sz));
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as XZ[]) {
      const rim = Math.abs(t.i + di) > N || Math.abs(t.j + dj) > N;
      if (furnished.has(t.kind)) {
        const s = f.sub(cx + di * (BLOCK - 1), 0, cz + dj * (BLOCK - 1), Math.atan2(di, dj));
        if (rng.chance(0.5)) bench(b, s, rng.range(-5, 5), 0.2, Math.PI);
        if (rng.chance(0.5)) bin(b, s, rng.pick([-7, 7]), 0.4);
        if (rng.chance(0.3)) hydrant(b, s, rng.range(-8, 8), 0.6);
      }
      const s = f.sub(cx + di * H, 0, cz + dj * H, Math.atan2(di, dj));
      const toFace = (a: number, z: number) => f.local(new Vector3(...s.p(a, 0, z)));
      parkCars(b, s, rng, H, rim, (a) => { const l = toFace(a, -4.9); return clear(l.x, l.z); });
      if (rim && rng.chance(0.4)) {
        const a = rng.range(-H + 4, H - 4);
        const l = toFace(a, -2);
        if (!clear(l.x, l.z)) barrier(b, s, a, -2.2, 0);
      }
    }
  }
}

// --- lanes -------------------------------------------------------------------------------------

const axisName = (v: Vector3): 'x' | 'z' => (Math.abs(v.x) > 0.5 ? 'x' : 'z');
const toV3 = (v: Vector3): V3 => [v.x, v.y, v.z];

/** The lane over the edge between faces a and b, in a's gravity (see LaneDef). */
function genLane(a: FacePlan, b: FacePlan): Omit<LaneDef, 'nodeA' | 'nodeB'> {
  const upA = new Vector3(...FACE_UP[a.id]), upB = new Vector3(...FACE_UP[b.id]);
  const out = upB.clone().negate(); // from a's centre towards b
  const e = new Vector3().crossVectors(upA, upB); // along the edge
  const qi = frameForUp(upA).invert();
  const outL = out.clone().applyQuaternion(qi), eL = e.clone().applyQuaternion(qi);
  const pieces: LanePiece[] = [];
  const push = (kind: PieceKind, along: 'x' | 'z', sg: number, bnd: number, side: number, level: number) => {
    const p = piecePlan(kind, upA, along, sg, bnd, side, level);
    pieces.push({ kind, center: toV3(p.center), half: toV3(p.half), quat: [p.quat.x, p.quat.y, p.quat.z, p.quat.w], key: p.key, level: p.level });
  };
  const aO = axisName(outL), aE = axisName(eL);
  const sideO = aO === 'x' ? 'z' : 'x', sideE = aE === 'x' ? 'z' : 'x';
  for (let k = 0; k < LANE.floors; k++) push('floor', aO, Math.sign(outL[aO]), FH + k * PIECE_CELL, LANE.floorS * eL[sideO], -S);
  for (let k = 0; k < LANE.ramps; k++)
    push('ramp', aE, Math.sign(eL[aE]), LANE.floorS + PIECE_CELL / 2 + k * PIECE_CELL, LANE.rampO * outL[sideE], -S + k * PIECE_LEVEL);
  push('floor', aE, Math.sign(eL[aE]), LANE.landS - PIECE_CELL / 2, LANE.rampO * outL[sideE], -S + (S - FH));
  // paths
  const pA = (o: number, s: number) => {
    const w = upA.clone().multiplyScalar(-S).addScaledVector(out, o).addScaledVector(e, s);
    const l = a.f.local(w);
    return [l.x, l.z] as XZ;
  };
  const pB = (o: number, s: number) => {
    const w = upB.clone().multiplyScalar(-S).addScaledVector(upA, -o).addScaledVector(e, s);
    const l = b.f.local(w);
    return [l.x, l.z] as XZ;
  };
  a.seams.push(pA(FH - 3, LANE.floorS));
  b.seams.push(pB(FH - 3, LANE.landS));
  return {
    id: `${a.id}-${b.id}`, a: a.id, b: b.id, pieces,
    pathA: [pA(FH - 2, LANE.floorS), pA(LANE.rampO, LANE.floorS), pA(LANE.rampO, LANE.landS), pA(S + 5, LANE.landS)],
    pathB: [pB(FH - 4, LANE.landS), pB(FH + 4, LANE.landS)],
    back: [pA(LANE.rampO, LANE.landS), pA(LANE.rampO, LANE.floorS), pA(FH - 2, LANE.floorS)],
  };
}

/** Glowing beams along the cube edges, just outside the faces (they frame the gaps; no collision). */
function edgeBeams(b: Builder) {
  const w = new Frame(new Vector3(), new Quaternion());
  for (let i = 0; i < FACE_IDS.length; i++) for (let j = i + 1; j < FACE_IDS.length; j++) {
    const A = new Vector3(...FACE_UP[FACE_IDS[i]]), B = new Vector3(...FACE_UP[FACE_IDS[j]]);
    if (Math.abs(A.dot(B)) > 0.5) continue;
    const e = new Vector3().crossVectors(A, B);
    const half = (r: number, len: number): [number, number, number] =>
      [Math.abs(e.x) > 0.5 ? len : r, Math.abs(e.y) > 0.5 ? len : r, Math.abs(e.z) > 0.5 ? len : r];
    const c = A.clone().add(B).multiplyScalar(-(S + 1.2));
    b.box(w, c.x, c.y, c.z, ...half(1.2, S + 2.4), 0x2c3036, 'metal', false);
    const g = A.clone().add(B).multiplyScalar(-(S + 0.06));
    b.box(w, g.x, g.y, g.z, ...half(0.06, S), 0xbfe8ff, 'glow', false);
  }
}

// --- map ---------------------------------------------------------------------------------------

/**
 * The whole map: the inside of a cube. `teams` = teams that play (the others get no face); `spawnTeam` (the local
 * player's team) always gets the -Y face, the other teams random faces; the remaining faces are neutral cities.
 */
export function generateMap(seed = 1337, spawnTeam = 'red', teams: readonly string[] = TEAMS.map((t) => t.id)): MapData {
  const b = new Builder(seed, { half: S, face: FH }, WORLD.voidMargin, WORLD.killRadius);
  const rng = new Rng(seed);
  const playing = TEAMS.filter((t) => teams.includes(t.id));
  const own = playing.find((t) => t.id === spawnTeam) ?? playing[0];
  const rest = FACE_IDS.filter((id) => id !== 'ny');
  for (let i = rest.length - 1; i > 0; i--) { const j = rng.int(0, i); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  const teamOf = new Map<FaceId, TeamDef>();
  if (own) teamOf.set('ny', own);
  for (const t of playing) if (t !== own) teamOf.set(rest.shift()!, t);
  b.data.teams = playing.map((t) => t.id);

  const plans: FacePlan[] = FACE_IDS.map((id) => {
    const team = teamOf.get(id) ?? null;
    return { id, team, f: faceFrame(id), tiles: planTiles(rng, team), seams: [] };
  });
  const plan = (id: FaceId) => plans.find((p) => p.id === id)!;

  // lanes first: the faces keep their bridge starts clear
  const lanes: Omit<LaneDef, 'nodeA' | 'nodeB'>[] = [];
  for (let i = 0; i < FACE_IDS.length; i++) for (let j = i + 1; j < FACE_IDS.length; j++) {
    const A = FACE_IDS[i], B = FACE_IDS[j];
    if (Math.abs(new Vector3(...FACE_UP[A]).dot(new Vector3(...FACE_UP[B]))) > 0.5) continue;
    lanes.push(rng.chance(0.5) ? genLane(plan(A), plan(B)) : genLane(plan(B), plan(A)));
  }

  for (const p of plans) {
    const { f, tiles, team } = p;
    faceGround(b, p);
    faceStreets(b, p, rng);
    for (const t of tiles) fillTile(b, f, rng, t, t.i * TILE, t.j * TILE, team);
    const face: FaceDef = { id: p.id, team: team?.id ?? null, origin: f.p(0, 0, 0), up: f.up(), quat: f.rot(0), half: FH };
    b.data.faces.push(face);
    b.data.plates.push(plate(f, 0, 0, 0, [0, 1, 0], [1, 0, 0], [0, 0, 1], FH - 0.35, FH - 0.35, -2, 2 * S));
    b.data.nav[p.id] = { ...roadGraph(tiles), hub: [0, 0], ...(team ? hallNav(0, 0) : {}) };
  }
  for (const l of lanes) b.data.lanes.push({
    ...l,
    nodeA: nearestNode(b.data.nav[l.a], l.pathA[0]),
    nodeB: nearestNode(b.data.nav[l.b], l.pathB[0]),
  });
  edgeBeams(b);
  return b.data;
}

/** The face whose gravity is `up` (world, any length), or null. */
export function faceByUp(map: MapData, up: { x: number; y: number; z: number }): FaceDef | null {
  let best: FaceDef | null = null, bd = 0.7;
  const l = Math.hypot(up.x, up.y, up.z) || 1;
  for (const f of map.faces) {
    const d = (f.up[0] * up.x + f.up[1] * up.y + f.up[2] * up.z) / l;
    if (d > bd) { bd = d; best = f; }
  }
  return best;
}

/** The face of a team (null: the team does not play). */
export function faceOfTeam(map: MapData, team: string): FaceDef | null {
  return map.faces.find((f) => f.team === team) ?? null;
}
