import { Quaternion, Vector3 } from 'three';
import { piecePlan, PIECE_CELL, PIECE_LEVEL, PieceKind } from '../blocks';
import { WORLD } from '../constants';
import type { GameMode } from '../lobby';
import { frameForUp, Rng } from '../math';
import { TEAMS, TeamDef } from '../teams';
import { Builder, FaceDef, FaceId, FaceNav, Frame, key, LaneDef, LanePiece, MapData, plate, V3, XZ } from './core';
import { barrier, bench, bin, BLOCK, hydrant, lamp, SW, TILE, tileCurbs } from './props';
import { ABYSS, abyssRect, fillTile, hallNav, OWN_GROUND, parkCars, pondRect, PONDS, Tile, TileKind } from './tiles';

const S = WORLD.cubeHalf;
const FH = WORLD.faceHalf;
/** Tiles per face side (5 × 36 m = 180 m = 2 × faceHalf). */
const N = 2;

/** The six faces and their inward normals. */
export const FACE_UP: Record<FaceId, V3> = {
  ny: [0, 1, 0], py: [0, -1, 0], nx: [1, 0, 0], px: [-1, 0, 0], nz: [0, 0, 1], pz: [0, 0, -1],
};
export const FACE_IDS = Object.keys(FACE_UP) as FaceId[];

export function faceFrame(id: FaceId, dist = S): Frame {
  const up = new Vector3(...FACE_UP[id]);
  return new Frame(up.clone().multiplyScalar(-dist), frameForUp(up));
}

const _ramps = (S - FH) / PIECE_LEVEL;
/** Bridge geometry over a cube edge (all distances from the face centre, m): see LaneDef. */
export const LANE = {
  /** Side coordinate (along the edge) of the floors on face a / of the landing on face b (cell centres). */
  floorS: -(_ramps + 1) * PIECE_CELL / 2,
  landS: (_ramps + 1) * PIECE_CELL / 2,
  /** Out coordinate of the ramp column (the cell next to the corner). */
  rampO: S - PIECE_CELL / 2,
  floors: (S - FH) / PIECE_CELL,
  ramps: _ramps,
};

interface Rect2 { x0: number; z0: number; x1: number; z1: number }

function subtractHoles(rects: Rect2[], holes: readonly Rect2[]): Rect2[] {
  let out = rects;
  for (const h of holes) {
    const next: Rect2[] = [];
    for (const r of out) {
      const ix0 = Math.max(r.x0, h.x0), ix1 = Math.min(r.x1, h.x1);
      const iz0 = Math.max(r.z0, h.z0), iz1 = Math.min(r.z1, h.z1);
      if (ix0 >= ix1 - 1e-4 || iz0 >= iz1 - 1e-4) {
        next.push(r);
        continue;
      }
      if (r.x0 < ix0) next.push({ x0: r.x0, z0: r.z0, x1: ix0, z1: r.z1 });
      if (ix1 < r.x1) next.push({ x0: ix1, z0: r.z0, x1: r.x1, z1: r.z1 });
      if (r.z0 < iz0) next.push({ x0: ix0, z0: r.z0, x1: ix1, z1: iz0 });
      if (iz1 < r.z1) next.push({ x0: ix0, z0: iz1, x1: ix1, z1: r.z1 });
    }
    out = next;
  }
  return out;
}

function isGraphConnected(nodeCount: number, edges: readonly [number, number][]): boolean {
  if (nodeCount <= 1) return true;
  const adj: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  const seen = new Array<boolean>(nodeCount).fill(false);
  const q = [0];
  seen[0] = true;
  let head = 0;
  while (head < q.length) {
    const u = q[head++];
    for (const v of adj[u]) if (!seen[v]) { seen[v] = true; q.push(v); }
  }
  return q.length === nodeCount;
}

/** Road graph: corners of the tiles, edges along roads (pruning any broken road pit segments while keeping connectivity). */
function roadGraph(tiles: Tile[], brokenEdges: readonly [number, number][] = [], rimLimit = N * TILE + TILE / 2 - 3, allRims = false) {
  const has = new Set(tiles.map((t) => key(t.i, t.j)));
  const nodes: XZ[] = [];
  const index = new Map<string, number>();
  // a road meets the rim at the kerb: its node sits in the middle of the last half road instead
  const R = rimLimit;
  const node = (x0: number, z0: number) => {
    const x = Math.max(-R, Math.min(R, x0)), z = Math.max(-R, Math.min(R, z0));
    const k = key(x, z);
    if (!index.has(k)) { index.set(k, nodes.length); nodes.push([x, z]); }
    return index.get(k)!;
  };
  const edges: [number, number][] = [];
  const edgeMid: { u: number; v: number; mx: number; mz: number; horiz: boolean }[] = [];
  const H = TILE / 2;
  const edgeSet = new Set<string>();
  const brokenSet = new Set(brokenEdges.map(([a, b]) => (a < b ? `${a}:${b}` : `${b}:${a}`)));
  const addEdge = (u: number, v: number, mx: number, mz: number, horiz: boolean) => {
    if (u === v) return;
    const k = u < v ? `${u}:${v}` : `${v}:${u}`;
    if (brokenSet.has(k)) return;
    if (!edgeSet.has(k)) {
      edgeSet.add(k);
      edges.push([u, v]);
      edgeMid.push({ u, v, mx, mz, horiz });
    }
  };
  for (const t of tiles) for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as XZ[]) {
    const nb = has.has(key(t.i + di, t.j + dj));
    const mainAvenue = allRims || (di !== 0 && t.i === 0) || (dj !== 0 && t.j === 0);
    if (!nb && !mainAvenue) continue;
    const bx = t.i * TILE + di * H, bz = t.j * TILE + dj * H;
    const ax = Math.abs(dj), az = Math.abs(di); // along the border
    addEdge(node(bx - ax * H, bz - az * H), node(bx + ax * H, bz + az * H), bx, bz, Math.abs(dj) > 0);
  }
  return { nodes, edges, edgeMid };
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

interface RoadHolePlan { rect: Rect2; mx: number; mz: number; horiz: boolean }
interface FacePlan { id: FaceId; team: TeamDef | null; f: Frame; tiles: Tile[]; seams: XZ[]; holes: RoadHolePlan[]; nav: FaceNav }

const POOL: TileKind[] = [
  'tower', 'tower', 'office', 'office', 'houses', 'houses', 'houses',
  'park', 'pond', 'greenpond', 'parking', 'construction', 'plaza',
  'museum', 'abyss', 'pipes', 'pipeline', 'bar', 'store', 'court',
];

function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function planTiles(rng: Rng, team: TeamDef | null): Tile[] {
  // Unique per-face island perimeter: core 3×3 + cardinal bridgeheads [0,±2] / [±2,0] + random asymmetric outer wings
  const coords: XZ[] = [[0, 0]];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (i !== 0 || j !== 0) coords.push([i, j]);
  // Cardinal bridgehead tiles ensure every bridge lane always meets solid island rim
  coords.push([0, -2], [0, 2], [-2, 0], [2, 0]);
  const outerWings = shuffled(rng, [
    [-1, -2], [1, -2], [-1, 2], [1, 2],
    [-2, -1], [-2, 1], [2, -1], [2, 1],
  ] as XZ[]);
  const extraCount = rng.int(4, 6);
  for (let k = 0; k < extraCount; k++) coords.push(outerWings[k]);
  if (rng.chance(0.45)) coords.push([rng.pick([-2, 2]), rng.pick([-2, 2])]);

  const special = new Map<string, TileKind>();
  const ring1 = shuffled(rng, coords.filter(([i, j]) => Math.max(Math.abs(i), Math.abs(j)) === 1));
  const free = () => {
    for (const [i, j] of ring1) {
      const k = key(i, j);
      if (!special.has(k)) return k;
    }
    return key(1, 1);
  };
  if (team) {
    special.set(key(0, 0), 'hall');
    special.set(free(), rng.pick(['pond', 'greenpond'] as TileKind[]));
    special.set(free(), rng.pick(['park', 'plaza'] as TileKind[]));
  } else {
    special.set(key(0, 0), 'square');
    const alongX = rng.chance(0.5);
    special.set(alongX ? key(1, 0) : key(0, 1), 'market');
    special.set(alongX ? key(-1, 0) : key(0, -1), 'market');
    special.set(free(), 'museum');
    special.set(free(), rng.pick(['greenpond', 'pond', 'park'] as TileKind[]));
  }
  const deck = shuffled(rng, POOL);
  let di = 0;
  const pickTile = (): TileKind => {
    if (di < deck.length) return deck[di++];
    return rng.pick(POOL);
  };
  return coords.map(([i, j]) => ({ i, j, kind: special.get(key(i, j)) ?? pickTile() }));
}

/** Ground slabs, sidewalks, road markings, collapsed road pits, and ruined/broken borders (open where a bridge lane leaves). */
function faceGround(b: Builder, p: FacePlan, outerRimCheck = true) {
  const { f, tiles, seams, holes } = p;
  const H = TILE / 2;
  const has = new Set(tiles.map((t) => key(t.i, t.j)));
  const nearSeam = (x: number, z: number, r: number) => seams.some((s) => Math.hypot(s[0] - x, s[1] - z) < r);
  const brng = new Rng(p.id.charCodeAt(0) * 131 + p.id.charCodeAt(1) * 17);
  const allTileHoles: Rect2[] = holes.map((h) => h.rect);
  for (const t of tiles) {
    const cx = t.i * TILE, cz = t.j * TILE;
    const isAbyss = !!ABYSS[t.kind];
    const hole = PONDS[t.kind] ? pondRect(t.kind, cx, cz) : isAbyss ? abyssRect(t.kind, cx, cz) : null;
    const holesHere: Rect2[] = hole ? [hole, ...allTileHoles] : allTileHoles;
    const topRects = subtractHoles([{ x0: cx - H, z0: cz - H, x1: cx + H, z1: cz + H }], holesHere);
    for (const r of topRects) b.span(f, r.x0, -1.5, r.z0, r.x1, 0, r.z1, 0x77736d, 'asphalt');
    const subRects = subtractHoles(
      [{ x0: cx - H + 0.3, z0: cz - H + 0.3, x1: cx + H - 0.3, z1: cz + H - 0.3 }],
      isAbyss ? holesHere : allTileHoles,
    );
    for (const r of subRects) b.span(f, r.x0, -3.2, r.z0, r.x1, -1.5, r.z1, 0x8f8a80, 'concrete');
    if (!OWN_GROUND.has(t.kind)) {
      b.block(f, cx, 0, cz, BLOCK, SW / 2, BLOCK, 0xcfc4ac, 'paving');
      if (t.kind !== 'hall') tileCurbs(b, f, cx, cz);
    }

    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as XZ[]) {
      const rim = !has.has(key(t.i + di, t.j + dj));
      // side frame: local +z points out of the tile through this side, x runs along it
      const s = f.sub(cx + di * H, 0, cz + dj * H, Math.atan2(di, dj));
      if (!rim) {
        // shared road: dashed centre line (drawn once, from the tile with the smaller index, skipped over road pits)
        if (di + dj > 0) for (let a = -H + 7; a <= H - 7; a += 3.6) {
          const l = f.local(new Vector3(...s.p(a, 0, 0)));
          if (allTileHoles.some((h) => l.x >= h.x0 - 0.8 && l.x <= h.x1 + 0.8 && l.z >= h.z0 - 0.8 && l.z <= h.z1 + 0.8)) continue;
          b.box(s, a, 0.015, 0, 0.9, 0.012, 0.08, 0xece6d6, 'paint', false);
        }
        continue;
      }
      // If this rim is an internal indentation (where an outer tile is missing), keep a 4 m road apron so corner road nodes stay walkable
      const outerFaceRim = outerRimCheck ? (Math.abs(t.i + di) > N || Math.abs(t.j + dj) > N) : true;
      if (!outerFaceRim) {
        b.box(s, 0, -0.75, 2.0, H, 0.75, 2.0, 0x77736d, 'asphalt');
        b.box(s, 0, -2.1, 1.7, H, 0.6, 1.7, 0x8f8a80, 'concrete');
      }
      // Ruined / broken border: jagged concrete & asphalt ledges, gaps, rubble chunks and exposed rebar instead of a straight wall
      const zOff = outerFaceRim ? 0 : 4.0;
      for (let a = -H; a < H; a += PIECE_CELL) {
        const m = a + PIECE_CELL / 2;
        const w = new Vector3(...s.p(m, 0, -0.3));
        const l = f.local(w);
        if (nearSeam(l.x, l.z, 4.5)) {
          // bridge start: chevrons on the road
          for (let k = 0; k < 3; k++) b.box(s, m, 0.015, -1.2 - k * 1.4, 1.4, 0.012, 0.25, p.team ? p.team.color : 0xe8e2d0, 'paint', false);
          continue;
        }
        // jagged broken slab teeth sticking out into the void
        if (brng.chance(0.72)) {
          const jut = brng.range(0.45, 1.85);
          const drop = brng.range(0.04, 0.32);
          const thick = brng.range(0.45, 0.95);
          b.box(s, m + brng.range(-0.25, 0.25), -drop - thick, zOff + jut, PIECE_CELL * brng.range(0.32, 0.52), thick, jut,
            brng.chance(0.5) ? 0x77736d : 0x8f8a80, brng.chance(0.5) ? 'asphalt' : 'concrete', false);
        }
        // lower broken under-slab shelf & sticking-out rebar
        if (brng.chance(0.55)) {
          const jut2 = brng.range(0.8, 2.6);
          b.box(s, m, -2.1, zOff + jut2 * 0.7, PIECE_CELL * 0.42, 0.55, jut2 * 0.7, 0x847e74, 'concrete', false);
          b.box(s, m + brng.range(-0.5, 0.5), -1.35, zOff + jut2 + 0.4, 0.06, 0.06, 0.9, 0x3b3530, 'metal', false);
        }
        // broken kerb / rubble fragments along the edge (kept clear of the road x = TILE/2 so tests can walk off cleanly)
        const onMainRoad = Math.abs(l.x - H) < 3.5 || Math.abs(l.x + H) < 3.5 || Math.abs(l.z - H) < 3.5 || Math.abs(l.z + H) < 3.5;
        if (!onMainRoad && brng.chance(0.48)) {
          const rh = brng.range(0.14, 0.36);
          b.box(s, m + brng.range(-0.4, 0.4), rh, zOff - brng.range(0.2, 0.7), brng.range(0.4, 0.95), rh, brng.range(0.28, 0.55),
            brng.chance(0.6) ? 0x9e9789 : 0x6f6b65, 'stone', false);
        }
      }
    }
  }
}

/** Street lamps, benches, bins, parked cars, barriers, and road-hole hazard curbs. */
function faceStreets(b: Builder, p: FacePlan, rng: Rng) {
  const { f, tiles, seams, holes } = p;
  const H = TILE / 2;
  const has = new Set(tiles.map((t) => key(t.i, t.j)));
  const furnished = new Set<TileKind>(['tower', 'office', 'parking', 'museum', 'market', 'plaza', 'square', 'bar', 'store', 'court', 'pipeline']);
  const clear = (x: number, z: number) =>
    seams.some((s) => Math.hypot(s[0] - x, s[1] - z) < 12) // bridge starts
    || holes.some((h) => x >= h.rect.x0 - 4 && x <= h.rect.x1 + 4 && z >= h.rect.z0 - 4 && z <= h.rect.z1 + 4)
    || (Math.abs(x) < 24 && Math.abs(z) < 24); // around the hall / the square
  for (const h of holes) {
    const r = h.rect;
    // Hazard barriers along the approach ends of the collapsed road hole
    if (h.horiz) {
      barrier(b, f, r.x0 - 0.65, h.mz, Math.PI / 2);
      barrier(b, f, r.x1 + 0.65, h.mz, Math.PI / 2);
      b.span(f, r.x0 - 0.35, 0, r.z0, r.x0, 0.08, r.z1, 0xe8b225, 'paint');
      b.span(f, r.x1, 0, r.z0, r.x1 + 0.35, 0.08, r.z1, 0xe8b225, 'paint');
    } else {
      barrier(b, f, h.mx, r.z0 - 0.65, 0);
      barrier(b, f, h.mx, r.z1 + 0.65, 0);
      b.span(f, r.x0, 0, r.z0 - 0.35, r.x1, 0.08, r.z0, 0xe8b225, 'paint');
      b.span(f, r.x0, 0, r.z1, r.x1, 0.08, r.z1 + 0.35, 0xe8b225, 'paint');
    }
  }
  for (const t of tiles) {
    const cx = t.i * TILE, cz = t.j * TILE;
    if (t.kind !== 'hall') for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) lamp(b, f, cx + sx * (BLOCK - 0.5), cz + sz * (BLOCK - 0.5), Math.atan2(sx, sz));
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as XZ[]) {
      const rim = !has.has(key(t.i + di, t.j + dj));
      const skipSide = (t.kind === 'plaza' && dj === -1) || ((t.kind === 'museum' || t.kind === 'bar' || t.kind === 'store') && dj === -1);
      if (furnished.has(t.kind) && !skipSide) {
        const s = f.sub(cx + di * (BLOCK - 1), 0, cz + dj * (BLOCK - 1), Math.atan2(di, dj));
        if (rng.chance(0.5)) bench(b, s, rng.range(-3.5, 3.5), 0.25, 0);
        if (rng.chance(0.5)) bin(b, s, rng.pick([-6.8, 6.8]), 0.4);
        if (rng.chance(0.3)) hydrant(b, s, rng.pick([-8.8, 8.8]), 0.55);
      }
      const s = f.sub(cx + di * H, 0, cz + dj * H, Math.atan2(di, dj));
      const toFace = (a: number, z: number) => f.local(new Vector3(...s.p(a, 0, z)));
      parkCars(b, s, rng, H, rim, (a) => { const l = toFace(a, -4.9); return clear(l.x, l.z); });
      if (rim && rng.chance(0.4)) {
        const a = rng.range(-H + 7, H - 7);
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

/** Vertical 10-level switchback bridge lane connecting opposing ny <-> py islands in Skirmish mode on the global grid. */
function genSkirmishLane(a: FacePlan, b: FacePlan, sideSign: -1 | 1, halfY: number): Omit<LaneDef, 'nodeA' | 'nodeB'> {
  const upA = new Vector3(...FACE_UP[a.id]);
  const pieces: LanePiece[] = [];
  const push = (kind: PieceKind, along: 'x' | 'z', sg: number, bnd: number, side: number, level: number) => {
    const p = piecePlan(kind, upA, along, sg, bnd, side, level);
    pieces.push({ kind, center: toV3(p.center), half: toV3(p.half), quat: [p.quat.x, p.quat.y, p.quat.z, p.quat.w], key: p.key, level: p.level });
  };
  const edgeX = TILE * 1.5; // 54 m (exact global cell boundary 12 * 4.5 m)
  const z1 = -PIECE_CELL / 2; // -2.25 m
  const z2 = PIECE_CELL / 2;  // +2.25 m
  // Lower starter floor outside [-1,0]/[1,0] rim -> 5 outbound ramps (-22.5 -> 0) -> 2 turnaround floors (y=0)
  push('floor', 'x', sideSign, edgeX, z1, -halfY);
  for (let k = 0; k < 5; k++) push('ramp', 'x', sideSign, edgeX + (k + 1) * PIECE_CELL, z1, -halfY + k * PIECE_LEVEL);
  push('floor', 'x', sideSign, edgeX + 6 * PIECE_CELL, z1, 0);
  push('floor', 'x', sideSign, edgeX + 6 * PIECE_CELL, z2, 0);
  // 5 return ramps (0 -> +22.5) -> top landing floor in a's gravity flush with py's rim at |x| = 54..58.5
  for (let m = 0; m < 5; m++) push('ramp', 'x', -sideSign, -(edgeX + 6 * PIECE_CELL) + m * PIECE_CELL, z2, m * PIECE_LEVEL);
  push('floor', 'x', -sideSign, -(edgeX + PIECE_CELL), z2, halfY);

  const toA = (x: number, y: number, z: number): XZ => {
    const l = a.f.local(new Vector3(x, y, z));
    return [l.x, l.z];
  };
  const toB = (x: number, y: number, z: number): XZ => {
    const l = b.f.local(new Vector3(x, y, z));
    return [l.x, l.z];
  };
  const xTurn = sideSign * (edgeX + 6.5 * PIECE_CELL);
  const xStart = sideSign * (edgeX - 2.0);
  const xTopLanding = sideSign * (edgeX + 0.5 * PIECE_CELL);
  a.seams.push(toA(xStart, -halfY, z1));
  b.seams.push(toB(xStart, +halfY, z2));
  return {
    id: `${a.id}-${b.id}-${sideSign < 0 ? 'w' : 'e'}`,
    a: a.id,
    b: b.id,
    pieces,
    pathA: [toA(xStart, -halfY, z1), toA(xTurn, 0, z1), toA(xTurn, 0, z2), toA(xTopLanding, +halfY, z2), toA(sideSign * (edgeX - 3.5), +halfY - 0.6, z2)],
    pathB: [toB(sideSign * (edgeX - 3.5), +halfY, z2), toB(xTopLanding, +halfY, z2)],
    back: [toA(xTurn, 0, z2), toA(xTurn, 0, z1), toA(xStart, -halfY, z1)],
  };
}

/** Edge beams disabled so the skybox city horizon blends seamlessly between islands. */
function edgeBeams(_b: Builder) {}

// --- map ---------------------------------------------------------------------------------------

/**
 * The whole map: the inside of a cube. `teams` = teams that play (the others get no face); `spawnTeam` (the local
 * player's team) always gets the -Y face. Supports `'duel'` (4 islands) and `'skirmish'` (2 close mirrored islands
 * separated vertically by 10 build cells = 45 m).
 */
export function generateMap(seed = 1337, spawnTeam = 'red', teams: readonly string[] = TEAMS.map((t) => t.id), mode: GameMode = 'standard'): MapData {
  const skirmish = mode === 'skirmish';
  const halfY = skirmish ? 5 * PIECE_LEVEL : S; // 22.5 m -> 45 m (10 cells) between floors in Skirmish
  const skirmishFaceHalf = TILE * 1.5; // 54 m (3 tiles across)
  const mapHalf = skirmish ? skirmishFaceHalf + PIECE_CELL * 8 : S; // 90 m XZ boundary (clears 85.5 m sky ramps)
  const mapFaceHalf = skirmish ? skirmishFaceHalf : FH;
  const b = new Builder(seed, { half: mapHalf, ...(skirmish ? { halfY } : {}), face: mapFaceHalf }, WORLD.voidMargin, WORLD.killRadius);
  b.data.mode = mode;
  b.data.roadHoles = [];
  const rng = new Rng(seed);
  const playing = TEAMS.filter((t) => teams.includes(t.id));
  const own = playing.find((t) => t.id === spawnTeam) ?? playing[0];
  const facePool: FaceId[] = skirmish ? ['ny', 'py'] : mode === 'duel' ? ['ny', 'py', 'nx', 'px'] : FACE_IDS;
  const teamOf = new Map<FaceId, TeamDef>();
  if (mode === 'duel' || skirmish) {
    if (own) teamOf.set('ny', own);
    const rival = playing.find((t) => t !== own);
    if (rival) teamOf.set('py', rival);
  } else {
    const rest = facePool.filter((id) => id !== 'ny');
    for (let i = rest.length - 1; i > 0; i--) { const j = rng.int(0, i); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    if (own) teamOf.set('ny', own);
    for (const t of playing) if (t !== own && rest.length) teamOf.set(rest.shift()!, t);
  }
  b.data.teams = playing.filter((t) => [...teamOf.values()].includes(t)).map((t) => t.id);

  // In Skirmish mode: pick 3 random tiles + deterministic tile sub-seeds, mirrored symmetrically on both ny & py
  const skDeck = shuffled(rng, POOL);
  const skKinds: [TileKind, TileKind, TileKind] = [skDeck[0], skDeck[1], skDeck[2]];
  const skSeeds: [number, number, number] = [rng.int(1, 1e8), rng.int(1, 1e8), rng.int(1, 1e8)];
  const skCoords = (id: FaceId): { tile: Tile; subSeed: number }[] => {
    const mirror = id === 'py';
    return [
      { tile: { i: 0, j: 0, kind: 'hall' }, subSeed: seed ^ 7 },
      { tile: { i: mirror ? 1 : -1, j: 0, kind: skKinds[0] }, subSeed: skSeeds[0] },
      { tile: { i: mirror ? -1 : 1, j: 0, kind: skKinds[1] }, subSeed: skSeeds[1] },
      { tile: { i: 0, j: -1, kind: skKinds[2] }, subSeed: skSeeds[2] },
    ];
  };

  const tileSubSeeds = new Map<FaceId, number[]>();
  const plans: FacePlan[] = facePool.map((id) => {
    const team = teamOf.get(id) ?? null;
    let tiles: Tile[];
    if (skirmish) {
      const paired = skCoords(id);
      tiles = paired.map((p) => p.tile);
      tileSubSeeds.set(id, paired.map((p) => p.subSeed));
    } else {
      tiles = planTiles(rng, team);
    }
    const rim = skirmish ? skirmishFaceHalf - 3 : N * TILE + TILE / 2 - 3;
    const baseGraph = roadGraph(tiles, [], rim, skirmish);
    return {
      id,
      team,
      f: faceFrame(id, halfY),
      tiles,
      seams: [],
      holes: [],
      nav: { nodes: baseGraph.nodes, edges: baseGraph.edges, hub: [0, 0], ...(team ? hallNav(0, 0) : {}) },
    };
  });
  const plan = (id: FaceId) => plans.find((p) => p.id === id)!;

  // lanes first: the faces keep their bridge starts clear
  const lanes: Omit<LaneDef, 'nodeA' | 'nodeB'>[] = [];
  if (skirmish) {
    lanes.push(genSkirmishLane(plan('ny'), plan('py'), -1, halfY));
    lanes.push(genSkirmishLane(plan('ny'), plan('py'), 1, halfY));
  } else {
    for (let i = 0; i < facePool.length; i++) for (let j = i + 1; j < facePool.length; j++) {
      const A = facePool[i], B = facePool[j];
      if (Math.abs(new Vector3(...FACE_UP[A]).dot(new Vector3(...FACE_UP[B]))) > 0.5) continue;
      lanes.push(rng.chance(0.5) ? genLane(plan(A), plan(B)) : genLane(plan(B), plan(A)));
    }
  }

  // Pick 2..3 collapsed road segments per face where removing the road edge leaves all road intersections reachable
  for (const p of plans) {
    if (skirmish) continue;
    const g = roadGraph(p.tiles);
    const candidates = shuffled(rng, g.edgeMid).filter((e) => {
      if (Math.max(Math.abs(e.mx), Math.abs(e.mz)) <= 26) return false;
      if (p.seams.some((s) => Math.hypot(s[0] - e.mx, s[1] - e.mz) < 15)) return false;
      if (Math.max(Math.abs(e.mx), Math.abs(e.mz)) >= N * TILE + TILE / 2 - 4) return false;
      return true;
    });
    const broken: [number, number][] = [];
    const targetHoles = mode === 'duel' ? 2 : 3;
    for (const c of candidates) {
      if (p.holes.length >= targetHoles) break;
      if (p.holes.some((h) => Math.hypot(h.mx - c.mx, h.mz - c.mz) < 34)) continue;
      const testEdges = p.nav.edges.filter(([a, b2]) => !((a === c.u && b2 === c.v) || (a === c.v && b2 === c.u)));
      if (!isGraphConnected(p.nav.nodes.length, testEdges)) continue;
      p.nav.edges = testEdges;
      broken.push([c.u, c.v]);
      const hw = 2.6, hl = 2.9;
      const rect: Rect2 = c.horiz
        ? { x0: c.mx - hl, x1: c.mx + hl, z0: c.mz - hw, z1: c.mz + hw }
        : { x0: c.mx - hw, x1: c.mx + hw, z0: c.mz - hl, z1: c.mz + hl };
      p.holes.push({ rect, mx: c.mx, mz: c.mz, horiz: c.horiz });
      b.data.roadHoles!.push({ face: p.id, xz: [c.mx, c.mz], half: c.horiz ? [hl, hw] : [hw, hl] });
    }
    void broken;
  }

  const maxH = skirmish ? 19.0 : undefined;
  for (const p of plans) {
    const { f, tiles, team, nav } = p;
    faceGround(b, p, !skirmish);
    faceStreets(b, p, skirmish ? new Rng(seed + 404) : rng);
    const subSeeds = tileSubSeeds.get(p.id);
    tiles.forEach((t, idx) => fillTile(b, f, subSeeds ? new Rng(subSeeds[idx]) : rng, t, t.i * TILE, t.j * TILE, team, maxH));
    const face: FaceDef = { id: p.id, team: team?.id ?? null, origin: f.p(0, 0, 0), up: f.up(), quat: f.rot(0), half: mapFaceHalf };
    b.data.faces.push(face);
    if (skirmish) {
      // Exact per-tile gravity plates so stepping off any of the 4 tiles falls into void, while opposite ground captures cleanly
      const th = TILE / 2 - 0.35;
      for (const t of tiles) {
        b.data.plates.push(plate(f, t.i * TILE, 0, t.j * TILE, [0, 1, 0], [1, 0, 0], [0, 0, 1], th, th, -2, 2 * halfY));
      }
    } else {
      b.data.plates.push(plate(f, 0, 0, 0, [0, 1, 0], [1, 0, 0], [0, 0, 1], mapFaceHalf - 0.35, mapFaceHalf - 0.35, -2, 2 * halfY));
    }
    b.data.nav[p.id] = nav;
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
