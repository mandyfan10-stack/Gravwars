import { Quaternion, Vector3 } from 'three';
import { EYE_OFFSET, PLAYER_HALF_SEGMENT, PLAYER_HEIGHT, PLAYER_RADIUS } from '../constants';
import { FaceId, HALL_H, LaneDef, navPath, nearestNode } from '../map';
import { upOf } from '../math';
import type { PlayerSim } from '../sim';
import type { TeamId } from '../teams';
import { hasAmmo } from '../weapons';
import {
  BED_AIM, BED_STAND, Bot, BotCtx, Dest, FaceInfo, Ground, isArmed, Loc, pickMaterial, polyDist, PondSpot, rest, Route, XZ,
} from './types';

const _up = new Vector3();
const _inv = new Quaternion();
const _v = new Vector3();
const _l = new Vector3();

/** Bot spatial sensing, cube-face routing, local obstacle detours, and bridge/cover placement. */
export class BotNav {
  constructor(private ctx: BotCtx) {}

  face(id: FaceId): FaceInfo {
    return this.ctx.faces.find((f) => f.id === id)!;
  }

  faceOfUp(up: Vector3): FaceInfo | null {
    return this.ctx.faces.find((f) => f.up.dot(up) > 0.99) ?? null;
  }

  /** The face of a team. */
  teamFace(team: TeamId): FaceInfo {
    return this.ctx.faces.find((f) => f.team === team) ?? this.ctx.faces[0];
  }

  localXZ(f: FaceInfo, p: Vector3): XZ {
    _l.copy(p).sub(f.origin).applyQuaternion(f.inv);
    return [_l.x, _l.z];
  }

  inHall(f: FaceInfo, p: XZ): boolean {
    const h = f.nav.hall;
    return !!h && Math.max(Math.abs(p[0] - h.c[0]), Math.abs(p[1] - h.c[1])) < h.half - 0.3;
  }

  /** Can a bot stand here: street-level ground under it, nothing in the way of its body? */
  spotFree(f: FaceInfo, p: Vector3): boolean {
    const { R, world, combat } = this.ctx;
    const from = p.clone().addScaledVector(f.up, 3);
    const hit = world.castRay(new R.Ray(from, f.up.clone().negate()), 6, true, undefined, undefined, undefined, undefined,
      combat.notCharacter);
    if (!hit) return false;
    const ground = from.addScaledVector(f.up, -hit.timeOfImpact);
    if (ground.clone().sub(f.origin).dot(f.up) > 1.2) return false; // on top of something (a bench, a car)
    const c = ground.addScaledVector(f.up, PLAYER_HEIGHT / 2 + 0.1);
    return !world.intersectionWithShape(c, f.q, new R.Capsule(PLAYER_HALF_SEGMENT, PLAYER_RADIUS), undefined, undefined, undefined,
      undefined, combat.notCharacter);
  }

  /** The pond (or collapsed road pit) whose basin (+ `margin`) contains this face-local point, if any. */
  wet(face: FaceId, x: number, z: number, margin = 0.5): PondSpot | null {
    for (const p of this.ctx.ponds)
      if (p.face === face && Math.abs(x - p.c[0]) < p.h[0] + margin && Math.abs(z - p.c[1]) < p.h[1] + margin) return p;
    if (this.ctx.map.roadHoles) {
      for (const h of this.ctx.map.roadHoles)
        if (h.face === face && Math.abs(x - h.xz[0]) < h.half[0] + margin && Math.abs(z - h.xz[1]) < h.half[1] + margin) {
          return { face, c: h.xz, h: h.half, water: new Vector3(), stands: [] };
        }
    }
    return null;
  }

  /** Does the straight line a → b (face-local) cross a pond? (A basin is a pit: the rays of `clear` pass over it.) */
  crossesPond(face: FaceId, a: XZ, b: XZ): boolean {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let t = 0; t <= len; t += 0.8) {
      const k = len ? t / len : 0;
      if (this.wet(face, a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, 0.4)) return true;
    }
    return false;
  }

  adjacent(a: FaceId, b: FaceId): boolean {
    return Math.abs(this.face(a).up.dot(this.face(b).up)) < 0.5;
  }

  /** Where the bot is (see Loc). */
  locate(sim: PlayerSim): Loc {
    if (!sim.state.onGround) return { kind: 'air' };
    const up = upOf(sim.state.frame, _up);
    const f = this.ctx.faces.find((i) => i.up.dot(up) > 0.99);
    if (!f) return { kind: 'air' };
    const l = _v.copy(sim.state.pos).sub(f.origin).applyQuaternion(f.inv);
    if (l.y < -3 || l.y > 2 * this.ctx.map.cube.half) return { kind: 'air' };
    let lane: LaneDef | null = null;
    if (Math.max(Math.abs(l.x), Math.abs(l.z)) > f.half) {
      // beyond the rim: on the bridge of one of this face's lanes (or on somebody's own stray floor)
      let bd = 10;
      for (const L of this.ctx.map.lanes) {
        if (L.a !== f.id) continue;
        const d = polyDist(L.pathA, l.x, l.z);
        if (d < bd) { bd = d; lane = L; }
      }
    }
    const hall = f.nav.hall;
    const inRect = !!hall && Math.max(Math.abs(l.x - hall.c[0]), Math.abs(l.z - hall.c[1])) < hall.half - 0.3;
    return { kind: 'face', face: f.id, x: l.x, z: l.z, h: l.y, hall: inRect && l.y < HALL_H - 1, roof: inRect && l.y > HALL_H - 1, lane };
  }

  /** Local XZ on the bot's current face → world point at the bot's height. */
  toWorld(loc: Ground, p: XZ, out = new Vector3()): Vector3 {
    const f = this.face(loc.face);
    return out.set(p[0], loc.h, p[1]).applyQuaternion(f.q).add(f.origin);
  }

  toWorldXZ(face: FaceId, p: XZ, out = new Vector3()): Vector3 {
    const f = this.face(face);
    return out.set(p[0], 0, p[1]).applyQuaternion(f.q).add(f.origin);
  }

  /** Walkable straight line? Rays at knee and chest height (characters do not count), and no pond on the way. */
  clear(sim: PlayerSim, from: Vector3, to: Vector3): boolean {
    const up = upOf(sim.state.frame, _up);
    for (const h of [-0.45, 0.4]) {
      const a = from.clone().addScaledVector(up, h);
      const b = to.clone().addScaledVector(up, h);
      if (!this.ctx.combat.lineOfSight(a, b, 0)) return false;
    }
    const f = this.faceOfUp(up);
    return !f || !this.crossesPond(f.id, this.localXZ(f, from), this.localXZ(f, to));
  }

  /** View angles looking at `dir` (world). */
  look(sim: PlayerSim, dir: Vector3): [number, number] {
    const local = _v.copy(dir).normalize().applyQuaternion(_inv.copy(sim.state.frame).invert());
    return [Math.atan2(-local.x, -local.z), Math.asin(Math.max(-1, Math.min(1, local.y)))];
  }

  /** Keys of every piece standing (lane pieces count as built when a player put the same piece there). */
  builtKeys(): Set<string> {
    if (this.ctx.keys.version !== this.ctx.blocks.version) {
      this.ctx.keys.version = this.ctx.blocks.version;
      this.ctx.keys.set.clear();
      for (const b of this.ctx.blocks.blocks.values()) if (b.key) this.ctx.keys.set.add(b.key);
    }
    return this.ctx.keys.set;
  }

  /** Pieces of a lane not built yet. */
  missing(L: LaneDef): number {
    const keys = this.builtKeys();
    return this.ctx.lanePlans.get(L.id)!.reduce((n, p) => n + (keys.has(p.key) ? 0 : 1), 0);
  }

  /** Face to cross to next on the way from `from` to `to`: learns from past failures and picks the safest / most complete lane. */
  nextFace(bot: Bot, from: FaceId, to: FaceId): FaceId {
    if (this.ctx.map.mode === 'skirmish' && from !== to) return to;
    const a = this.face(from), b = this.face(to);
    if (Math.abs(a.up.dot(b.up)) < 0.5) return to;
    const between = this.ctx.faces.filter((f) => Math.abs(f.up.dot(a.up)) < 0.5).map((f) => f.id);
    if (!between.length) return to;
    // Sort candidate intermediate faces by learned failures + missing bridge pieces
    between.sort((f1, f2) => {
      const l1 = this.laneBetween(from, f1, bot.id), l2 = this.laneBetween(from, f2, bot.id);
      const fail1 = (l1 ? (bot.laneFailures.get(l1.id) ?? 0) * 8 + this.missing(l1) * 0.25 : 99);
      const fail2 = (l2 ? (bot.laneFailures.get(l2.id) ?? 0) * 8 + this.missing(l2) * 0.25 : 99);
      if (Math.abs(fail1 - fail2) > 0.5) return fail1 - fail2;
      return f1.localeCompare(f2);
    });
    return between[(bot.id + bot.trip) % Math.min(2, between.length)] ?? between[0];
  }

  laneBetween(a: FaceId, b: FaceId, botId = 0): LaneDef {
    const all = this.ctx.map.lanes.filter((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    if (!all.length) return this.ctx.map.lanes[0];
    return all[Math.abs(botId) % all.length];
  }

  /**
   * Road points from the bot to a node of the face's road graph (the first node is skipped if it lies behind) and a
   * crossing next to the start that is off the way (for a wrong turn).
   */
  roads(loc: Ground, to: number): { pts: XZ[]; wrong?: XZ } {
    const nav = this.ctx.map.nav[loc.face];
    const start = nearestNode(nav, [loc.x, loc.z]);
    const path = navPath(nav, start, to);
    const pts = path.map((i) => nav.nodes[i]);
    if (pts.length > 1) {
      const [a, b] = pts;
      if (Math.hypot(loc.x - b[0], loc.z - b[1]) < Math.hypot(a[0] - b[0], a[1] - b[1])) pts.shift();
    }
    let wrong: XZ | undefined;
    if (path.length > 2) {
      const nb = nav.edges.filter(([a, b]) => a === start || b === start).map(([a, b]) => (a === start ? b : a)).filter((n) => n !== path[1]);
      if (nb.length) wrong = nav.nodes[nb[Math.abs(Math.floor(loc.x * 7 + loc.z * 13)) % nb.length]];
    }
    return { pts, wrong };
  }

  /**
   * Route on the current face towards the task's destination: local XZ points + what to do at the end. `push`: the
   * last point lies inside a surface that turns the gravity (the next face's ground, a lane's landing): walk straight
   * into it, no detours. `lane`: the bridge the route uses (its missing pieces are laid on the way).
   * Routes are rebuilt only when their key changes.
   */
  route(bot: Bot, loc: Ground, d: Dest): Route {
    const memo = (key: string, make: () => Omit<Route, 'key'>): Route => (key === bot.routeKey && bot.route ? bot.route : { key, ...make() });
    const N = this.ctx.map.nav[loc.face];
    const here = loc.face;
    const goal = d.face;
    // on a bridge of this face: on along it towards the next face, or back into the city
    if (loc.lane) {
      const L = loc.lane;
      const next = here === goal ? null : this.nextFace(bot, here, goal);
      if (next === L.b) return memo(`lane:${L.id}`, () => ({ pts: rest(L.pathA, loc.x, loc.z), end: 'go', push: true, lane: L, strict: 0 }));
      return memo(`back:${L.id}`, () => ({ pts: rest(L.back, loc.x, loc.z), end: 'go', lane: L, strict: 0 }));
    }
    if (here === goal) {
      const wantHall = d.kind !== 'point' || d.hall;
      if (N.hall) {
        const [hx, hz] = N.hall.c;
        const doors = N.doors!;
        if (loc.roof) return memo(`roof:${here}`, () => ({ pts: [[hx + 10, hz + 10], [hx + 10, hz], [hx + 10, hz - 10]], end: 'go' }));
        if (wantHall && !loc.hall) {
          const k = Math.hypot(loc.x - doors[0].out[0], loc.z - doors[0].out[1]) <= Math.hypot(loc.x - doors[1].out[0], loc.z - doors[1].out[1]) ? 0 : 1;
          const laneOff = ((bot.id % 5) - 2) * 0.55;
          const dOut: XZ = [doors[k].out[0] + laneOff, doors[k].out[1]];
          const dIn: XZ = [doors[k].in[0] + laneOff, doors[k].in[1]];
          return memo(`enter:${here}:${k}:${bot.id % 5}`, () => ({ pts: [...this.roads(loc, nearestNode(N, doors[k].out)).pts, dOut, dIn], end: 'go' }));
        }
        if (wantHall) return this.inside(bot, loc, d, memo);
        if (loc.hall && d.kind === 'point') return this.exitHall(bot, loc, d.pt, memo);
      }
      if (d.kind === 'point') {
        const pt = d.pt;
        return memo(`pt:${d.key}`, () => {
          // close and in plain sight: straight there; else along the roads
          if (Math.hypot(loc.x - pt[0], loc.z - pt[1]) < 26 && this.clear(bot.sim, bot.sim.state.pos, this.toWorld(loc, pt)))
            return { pts: [pt], end: d.end, arrive: d.arrive };
          const r = this.roads(loc, nearestNode(N, pt));
          return { pts: [...r.pts, pt], end: d.end, arrive: d.arrive, wrong: r.wrong };
        });
      }
      return memo(`hub:${here}`, () => ({ pts: [N.hub], end: 'hold' }));
    }
    const next = this.nextFace(bot, here, goal);
    const L = this.laneBetween(here, next, bot.id);
    const exit = L.a === here ? L.nodeA : L.nodeB;
    // leave the hall by the door on the side of the exit (around the crystal's fort)
    if (loc.hall && N.hall) return this.exitHall(bot, loc, N.nodes[exit], memo);
    const key = L.a === here ? `lane:${L.id}` : `land:${L.id}`;
    return memo(key, () => {
      const r = this.roads(loc, exit);
      return { pts: [...r.pts, ...(L.a === here ? L.pathA : L.pathB)], end: 'go', push: true, lane: L, strict: r.pts.length, wrong: r.wrong };
    });
  }

  /** Out of the hall by the door nearer to `e` (spread across doorway lanes to prevent queueing). */
  exitHall(bot: Bot, loc: Ground, e: XZ, memo: (key: string, make: () => Omit<Route, 'key'>) => Route): Route {
    const N = this.ctx.map.nav[loc.face];
    const [hx, hz] = N.hall!.c;
    const doors = N.doors!;
    const k = Math.hypot(e[0] - doors[0].out[0], e[1] - doors[0].out[1]) <= Math.hypot(e[0] - doors[1].out[0], e[1] - doors[1].out[1]) ? 0 : 1;
    const sz = k === 0 ? -1 : 1;
    const laneOff = ((bot.id % 5) - 2) * 0.55;
    const dIn: XZ = [doors[k].in[0] + laneOff, doors[k].in[1]];
    const dOut: XZ = [doors[k].out[0] + laneOff, doors[k].out[1]];
    return memo(`exit:${loc.face}:${k}:${bot.id % 5}`, () => ({ pts: [[hx + Math.sign(loc.x - hx || 1) * 4.5 + laneOff * 0.5, hz + sz * 7], dIn, dOut], end: 'go' }));
  }

  /** Inside a hall: the crystal stand (raid), the guard posts / patrol (home), a point (the shop). */
  inside(bot: Bot, loc: Ground, d: Dest, memo: (key: string, make: () => Omit<Route, 'key'>) => Route): Route {
    const N = this.ctx.map.nav[loc.face];
    const [hx, hz] = N.hall!.c;
    const stands = N.bedStands!;
    const stand = stands[bot.stand % stands.length];
    const patrol = () => memo(`patrol:${loc.face}:${bot.patrol}`, () => ({ pts: [N.patrol![bot.patrol % N.patrol!.length]], end: 'hold' }));
    if (d.kind === 'bed') {
      if (!this.ctx.match.bed(d.team).alive) return patrol();
      const off: XZ = [stand[0] - hx, stand[1] - hz];
      const len = Math.hypot(off[0], off[1]) || 1;
      // rockets at the fort first, from further back (the blast would hurt it at the stand)
      if (bot.rocketFort) return memo(`rocket:${d.team}:${bot.stand}`, () => ({ pts: [[hx + (off[0] / len) * 7.5, hz + (off[1] / len) * 7.5]], end: 'bed' }));
      // only fists: right up to the crystal
      if (!isArmed(bot, 1)) return memo(`bed:${d.team}:${bot.stand}:m`, () => ({ pts: [[hx + (off[0] / len) * 2.1, hz + (off[1] / len) * 2.1]], end: 'bed' }));
      // a gun: far enough to shoot over the fort at the top of the crystal, still within the 5 m of the rule
      return memo(`bed:${d.team}:${bot.stand}`, () => ({ pts: [[hx + (off[0] / len) * BED_STAND, hz + (off[1] / len) * BED_STAND]], end: 'bed' }));
    }
    if (d.kind === 'home') {
      if (bot.task.kind === 'defend') {
        const by = this.ctx.alarms.get(bot.team)?.by;
        const f = this.face(loc.face);
        if (by?.alive) {
          const p = this.localXZ(f, by.center);
          if (this.inHall(f, p)) return memo(`chase:${Math.round(p[0] / 3)}:${Math.round(p[1] / 3)}`, () => ({ pts: [p], end: 'hold', arrive: 3 }));
        }
        return memo(`guard:${loc.face}:${bot.stand}`, () => ({ pts: [stand], end: 'hold' }));
      }
      if (bot.task.kind === 'fortify') return memo(`fortify:${loc.face}:${bot.stand}`, () => ({ pts: [stand], end: 'act' }));
      return patrol();
    }
    return memo(`pt:${d.key}`, () => ({ pts: [d.pt], end: d.end, arrive: d.arrive }));
  }

  /** On the way along a lane: lay its missing pieces near the bot, paying with its own wood/stone/metal; also opens team doors. */
  bridge(bot: Bot, lane: LaneDef | undefined, dt: number, ahead: Vector3) {
    bot.buildT -= dt;
    if (bot.buildT > 0) return;
    bot.buildT = 0.14;
    const pos = bot.sim.state.pos;
    const eye = pos.clone().addScaledVector(bot.target.up, EYE_OFFSET);
    _v.copy(ahead).sub(pos);
    if (_v.lengthSq() > 1e-4) {
      const door = this.ctx.blocks.aimedDoor(eye, _v.clone().normalize(), 3.2);
      if (door && !door.block.open && (!door.block.team || door.block.team === bot.team)) {
        this.ctx.blocks.setDoorState(door.block, true);
      }
    }
    if (!lane) {
      bot.blocked = false;
      // Under fire in the open: occasionally place a cover wall (with shooting hole or team door) if carrying blocks
      if (bot.enemy && bot.hurtT > this.ctx.match.time - 1.5 && !this.ctx.blocks.nearCrystal(pos, 7)) {
        const mat = pickMaterial(bot, 'stone') ?? pickMaterial(bot, 'wood');
        if (mat && this.ctx.rng.chance(0.08)) {
          const toEnemy = bot.enemy.center.clone().sub(pos);
          const variant = this.ctx.rng.chance(0.5) ? 'hole' : this.ctx.rng.chance(0.5) ? 'door' : 'plain';
          const plan = this.ctx.blocks.plan('wall', pos, bot.target.up, toEnemy, eye, toEnemy, variant);
          if (plan && this.ctx.blocks.place(plan, mat, bot.team, true) === 'ok') {
            bot.kit[mat]--;
            bot.built++;
            bot.builtAt = this.ctx.match.time;
          }
        }
      }
      return;
    }
    const keys = this.builtKeys();
    const can = bot.eco.has('builder');
    let blocked = false;
    for (const p of this.ctx.lanePlans.get(lane.id)!) {
      const d2 = p.center.distanceToSquared(pos);
      if (d2 > 10 * 10 || keys.has(p.key)) continue;
      const front = d2 < 8.5 * 8.5 && _l.copy(p.center).sub(pos).dot(_v) > 0;
      const mat = pickMaterial(bot, 'wood');
      if (!can || !mat) { if (front) blocked = true; continue; }
      const r = this.ctx.blocks.place(p, mat, bot.team, true);
      if (r === 'ok') { bot.kit[mat]--; bot.built++; bot.builtAt = this.ctx.match.time; }
    }
    bot.blocked = blocked;
  }

  /** Best intermediate point (rings around the bot) that sees both the bot and the goal. */
  findDetour(bot: Bot, loc: Ground, goal: Vector3): XZ | null {
    const s = bot.sim.state;
    let best: XZ | null = null;
    let bestCost = Infinity;
    // greedy fallback: a reachable point that gets closest to the goal (re-planned from there)
    let greedy: XZ | null = null;
    let greedyD = s.pos.distanceTo(goal) - 1;
    for (const r of [2, 4, 7, 11, 15]) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const c: XZ = [loc.x + Math.cos(a) * r, loc.z + Math.sin(a) * r];
        const w = this.toWorld(loc, c);
        const cost = w.distanceTo(s.pos) + w.distanceTo(goal);
        const toGoal = w.distanceTo(goal);
        if (cost >= bestCost && toGoal >= greedyD) continue;
        if (this.wet(loc.face, c[0], c[1], 0.8) || !this.standable(bot.sim, w) || !this.clear(bot.sim, s.pos, w)) continue;
        if (cost < bestCost && this.clear(bot.sim, w, goal)) { best = c; bestCost = cost; }
        else if (toGoal < greedyD) { greedy = c; greedyD = toGoal; }
      }
      if (best) break;
    }
    return best ?? greedy;
  }

  /** First block (prioritizing hostile builds) on the straight/angled path towards `to`. */
  blockInTheWay(sim: PlayerSim, to: Vector3, team?: TeamId, enemyOnly = false): number | null {
    const up = upOf(sim.state.frame, _up).clone();
    const dir = to.clone().sub(sim.state.pos);
    dir.addScaledVector(up, -dir.dot(up));
    if (dir.lengthSq() < 1e-4) return null;
    dir.normalize();
    let neutralHandle: number | null = null;
    for (const h of [-0.45, 0.4, 1.15]) {
      const from = sim.state.pos.clone().addScaledVector(up, h);
      const hit = this.ctx.world.castRay(new this.ctx.R.Ray(from, dir), 4.6, true, undefined, undefined, undefined, undefined, this.ctx.combat.notCharacter);
      const blk = hit ? this.ctx.blocks.byCollider(hit.collider.handle) : undefined;
      if (!blk) continue;
      if (team && blk.team === team) continue; // never shoot own team builds when looking for obstacle
      if (blk.team && team && blk.team !== team) return hit!.collider.handle;
      if (!enemyOnly && neutralHandle === null) neutralHandle = hit!.collider.handle;
    }
    return enemyOnly ? null : neutralHandle;
  }

  /** Find a visible enemy-built block worth demolishing (enemy cover hiding a target, or blocks near an enemy base/crystal). */
  enemyStructureTarget(bot: Bot, eye: Vector3, goalBed?: Vector3): number | null {
    const { R, world, combat, blocks } = this.ctx;
    const up = bot.target.up;
    // 1. Enemy block sheltering the last-seen enemy target
    if (bot.searchT > 0 && bot.searchPos && eye.distanceTo(bot.searchPos) < 22) {
      const dir = bot.searchPos.clone().sub(eye);
      const dist = dir.length();
      if (dist > 0.5) {
        const hit = world.castRay(new R.Ray(eye, dir.divideScalar(dist)), Math.min(dist, 16), true, undefined, undefined, bot.sim.mover.collider, undefined, combat.notCharacter);
        const blk = hit ? blocks.byCollider(hit.collider.handle) : undefined;
        if (blk && blk.team && blk.team !== bot.team && (blk.kind !== 'floor' || blk.variant !== 'plain')) {
          return hit!.collider.handle;
        }
      }
    }
    // 2. Hostile structures near the enemy crystal / base hall during a raid (walls, doors, 1x1 forts, ramps)
    if (!isArmed(bot, 1) && !hasAmmo(bot.weapons, 'rocket')) return null;
    const focus = goalBed ?? eye;
    const inRaidRadius = eye.distanceTo(focus) < 16;
    if (!inRaidRadius) return null;
    let best: number | null = null;
    let bestD = Infinity;
    for (const blk of blocks.blocks.values()) {
      if (!blk.team || blk.team === bot.team) continue;
      // Don't break flat floor bridges the bot itself might walk on unless very close to crystal
      if (blk.kind === 'floor' && Math.abs(blk.center.clone().sub(eye).dot(up)) < 0.8 && blk.center.distanceTo(focus) > 5.5) continue;
      if (blk.center.distanceTo(focus) > 13.5) continue;
      const d = blk.center.distanceTo(eye);
      if (d > 16 || d >= bestD) continue;
      const dir = blk.center.clone().sub(eye).normalize();
      const hit = world.castRay(new R.Ray(eye, dir), d + 0.5, true, undefined, undefined, bot.sim.mover.collider, undefined, combat.notCharacter);
      if (hit && hit.collider.handle === blk.collider.handle) {
        bestD = d;
        best = blk.collider.handle;
      }
    }
    return best;
  }

  /** Is there ground under this point (do not detour into the void)? */
  standable(sim: PlayerSim, p: Vector3): boolean {
    const down = upOf(sim.state.frame, _up).clone().negate();
    return !!this.ctx.world.castRay(new this.ctx.R.Ray(p, down), PLAYER_HEIGHT / 2 + 0.5, true, undefined, undefined, undefined, undefined, this.ctx.combat.notCharacter);
  }

  /** The first block between the near crystal stand and the crystal (what the rockets should clear). */
  fortBlock(bot: Bot, loc: Ground, bed: Vector3) {
    const N = this.ctx.map.nav[loc.face];
    const [hx, hz] = N.hall!.c;
    const st = N.bedStands![bot.stand % N.bedStands!.length];
    const len = Math.hypot(st[0] - hx, st[1] - hz) || 1;
    const stand: XZ = [hx + ((st[0] - hx) / len) * BED_STAND, hz + ((st[1] - hz) / len) * BED_STAND];
    const eye = this.toWorld(loc, stand).addScaledVector(bot.target.up, EYE_OFFSET);
    const hit = this.ctx.match.firstHit(eye, bed.clone().addScaledVector(bot.target.up, BED_AIM), bot.sim.mover.collider);
    return hit ? this.ctx.blocks.byCollider(hit.collider.handle) ?? null : null;
  }
}
