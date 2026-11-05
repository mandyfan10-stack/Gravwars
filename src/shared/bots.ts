import { Quaternion, Vector3 } from 'three';
import { BlockSystem } from './blocks';
import { Combat, MAX_HP, Target } from './combat';
import { EYE_OFFSET, PLAYER_HEIGHT, WORLD } from './constants';
import type { IslandNav, MapData } from './map';
import { BED_BREAK_TIME, Match } from './match';
import { frameForUp, Rng, upOf } from './math';
import { emptyInput, MoveInput, moveBasis } from './movement';
import type { PhysicsWorld, Rapier } from './physics';
import { crossesPortal } from './portals';
import { PlayerSim } from './sim';
import { TEAMS, TeamId, teamByDown } from './teams';
import { createWeaponState, WeaponState, weaponTick } from './weapons';

/** Tuning. Times in seconds, distances in metres. */
export const BOT = {
  perTeam: 2,
  sightRange: 30,
  /** At home, a bot only fights enemies this close to its own crystal (no base-to-base sniping). */
  defendRadius: 14,
  /** Delay between first seeing an enemy and opening fire. */
  reaction: 0.45,
  /** Aim error, radians (1 sigma-ish). */
  spread: 0.03,
  burst: 5,
  burstPause: 0.6,
  respawnDelay: 4,
  /** First attacker leaves this long after the start; the others follow one by one. */
  firstAttack: 60,
  attackStagger: 25,
  /** An attacker that died sets off again after this. */
  reattack: 25,
  /** Chance that an attacker goes for the player's crystal rather than another bot team's. */
  targetPlayerChance: 0.6,
  /** No progress for this long → teleport home (last-resort unstuck). */
  giveUp: 20,
  /** Walk speed (share of max) for the last metres before stepping off a face edge, so the fall stays on the island. */
  edgeWalk: 0.2,
};

/** Closer to the face edge than this (local |x| or |z|) = slow down for the drop. */
const EDGE_SLOW = 54;

type XZ = [number, number];
export type Loc =
  | { kind: 'face' | 'island' | 'mid'; team: TeamId; x: number; z: number; h: number; roof: boolean }
  | { kind: 'air' };

export type BotRole = 'defend' | 'attack';

export interface Bot {
  id: number;
  team: TeamId;
  role: BotRole;
  /** Index among the team's bots (spawn offset). */
  slot: number;
  sim: PlayerSim;
  target: Target;
  weapons: WeaponState;
  /** Team whose crystal the attacker is going for. */
  goal: TeamId | null;
  /** Match time when the attacker sets off. */
  departAt: number;
  respawnT: number;
  /** Eliminated: dead with no crystal. */
  out: boolean;
  enemy: Target | null;
  seenT: number;
  scanT: number;
  shots: number;
  /** All shots fired (views animate on change). */
  shotsTotal: number;
  pauseT: number;
  /** Current route (local XZ points of the current surface, frozen while the key stays the same) and progress. */
  routeKey: string;
  routePts: XZ[];
  wp: number;
  detour: XZ | null;
  checkT: number;
  progressT: number;
  bestDist: number;
  stuckT: number;
  jumpT: number;
  /** Block in the way that the bot is shooting through (collider handle). */
  breach: number | null;
  /** Time spent off the ground without moving (wedged on a ledge). */
  wedgeT: number;
  /** > 0 right after a portal: keep walking away from it. */
  exitT: number;
  bedT: number;
  stand: number;
  standT: number;
  patrol: number;
  patrolT: number;
  /** Position before the last tick (render interpolation). */
  prevPos: Vector3;
  /** Short description of what the bot is doing (debug HUD). */
  status: string;
}

const _up = new Vector3();
const _q = new Quaternion();
const _inv = new Quaternion();
const _v = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();

/** Canonical frame of a surface with this up: same as the map generator uses (island and face share it). */
function surfaceFrame(up: Vector3) {
  return frameForUp(up, _q);
}

/**
 * Bots: same movement / physics / weapons as the player. Navigation uses the map's structure:
 * roof → geyser → core face → portals → walk off the face edge → island → lift → roof → crystal.
 * A cheap local planner (line-of-sight detours) gets around obstacles on each surface.
 */
export class BotManager {
  readonly bots: Bot[] = [];
  private readonly rng = new Rng(4242);
  /** Portals on each face: local position and the team of the face they lead to. */
  private readonly portals = new Map<TeamId, { x: number; z: number; to: TeamId }[]>();
  /** Where to run off each face so that the fall ends on that team's island. */
  readonly drops = new Map<TeamId, { approach: XZ; edge: XZ }>();
  /** Faces for which a verified drop was found. */
  readonly dropOk = new Set<TeamId>();

  constructor(private R: Rapier, private world: PhysicsWorld, private map: MapData, private combat: Combat,
    private match: Match, private blocks: BlockSystem, readonly playerTeam: TeamId, perTeam = BOT.perTeam) {
    this.indexPortals();
    this.findDrops();
    match.membersAlive = (team) => this.bots.filter((b) => b.team === team && !b.out).length;
    match.characterFilter = combat.notCharacter;
    let id = 100;
    let wave = 0;
    for (const t of TEAMS) {
      if (t.id === playerTeam) continue;
      for (let slot = 0; slot < perTeam; slot++) {
        const role: BotRole = slot === 0 ? 'defend' : 'attack';
        const sim = new PlayerSim(R, world, map, t.id);
        combat.addCharacter(sim.mover.collider);
        const target: Target = {
          id: id++, team: t.id, center: sim.state.pos, up: upOf(sim.state.frame), hp: MAX_HP, alive: true, respawnIn: -1,
          onImpulse: (v) => sim.applyImpulse(v),
        };
        combat.targets.push(target);
        const bot: Bot = {
          id: target.id, team: t.id, role, slot, sim, target, weapons: createWeaponState(), goal: null,
          departAt: role === 'attack' ? BOT.firstAttack + BOT.attackStagger * wave++ : Infinity,
          respawnT: 0, out: false, enemy: null, seenT: 0, scanT: this.rng.range(0, 0.15), shots: 0, shotsTotal: 0, pauseT: 0,
          routeKey: '', routePts: [], wp: 0, detour: null, checkT: 0, progressT: 0, bestDist: Infinity, stuckT: 0, jumpT: 0,
          breach: null, wedgeT: 0, exitT: 0, bedT: 0, stand: 0, standT: 0, patrol: slot, patrolT: 0, prevPos: new Vector3(), status: '',
        };
        this.placeAtSpawn(bot);
        this.bots.push(bot);
      }
    }
  }

  // --- setup ------------------------------------------------------------------------------------

  private faceOf(p: Vector3) {
    const n = new Vector3();
    const ax = Math.abs(p.x), ay = Math.abs(p.y), az = Math.abs(p.z);
    if (ax >= ay && ax >= az) n.set(Math.sign(p.x), 0, 0);
    else if (ay >= az) n.set(0, Math.sign(p.y), 0);
    else n.set(0, 0, Math.sign(p.z));
    return { n, team: teamByDown(n.clone().negate()).id };
  }

  private onCore(p: Vector3) {
    return Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) < this.map.coreHalf + 6;
  }

  private indexPortals() {
    for (const p of this.map.portals) {
      const pos = new Vector3(...p.pos);
      // only face ↔ face portals; the gates to the middle islands are walked through by the 'mid' route
      if (!this.onCore(pos) || !this.onCore(new Vector3(...this.map.portals[p.partner].pos))) continue;
      const { n, team } = this.faceOf(pos);
      const partner = this.faceOf(new Vector3(...this.map.portals[p.partner].pos));
      const local = pos.clone().addScaledVector(n, -this.map.coreHalf).applyQuaternion(surfaceFrame(n).clone().invert());
      if (!this.portals.has(team)) this.portals.set(team, []);
      this.portals.get(team)!.push({ x: local.x, z: local.z, to: partner.team });
    }
  }

  /** Simulate running off each edge of each face; keep the first that lands on the right island. */
  private findDrops() {
    // middle of each edge first (lands on the island's road), then shifted along the edge: falling along the
    // middle of a side face can run into that face's portals
    const candidates: { approach: XZ; edge: XZ }[] = [];
    const h = this.map.coreHalf;
    for (const off of [0, 8, -8, 16, -16, 28, -28])
      for (const [ax, az] of [[1, 0], [-1, 0], [0, -1], [0, 1]] as XZ[])
        candidates.push({ approach: [ax * (h - 20) + az * off, az * (h - 20) + ax * off], edge: [ax * (h + 4) + az * off, az * (h + 4) + ax * off] });
    for (const t of TEAMS) {
      const sim = new PlayerSim(this.R, this.world, this.map, t.id);
      const up = upOf(sim.state.frame, new Vector3());
      const q = surfaceFrame(up).clone();
      const frame = sim.state.frame.clone();
      let chosen = candidates[0];
      for (const c of candidates) {
        const s = sim.state;
        s.frame.copy(frame); // a previous try may have gone through a portal
        s.pos.set(c.approach[0], PLAYER_HEIGHT / 2 + 0.05, c.approach[1]).applyQuaternion(q).addScaledVector(up, this.map.coreHalf);
        s.vel.set(0, 0, 0);
        s.yaw = 0;
        sim.mover.place(s);
        sim.events.length = 0;
        let left = false;
        let ok = false;
        for (let k = 0; k < 16; k++) sim.tick(emptyInput(), 1 / 64); // settle on the face
        for (let k = 0; k < 64 * 16; k++) {
          const target = new Vector3(c.edge[0], 0, c.edge[1]).applyQuaternion(q).addScaledVector(up, this.map.coreHalf);
          const input = emptyInput();
          if (!left) {
            this.steer(sim, input, target.sub(s.pos));
            const local = _v.copy(s.pos).addScaledVector(up, -this.map.coreHalf).applyQuaternion(_inv.copy(q).invert());
            if (Math.max(Math.abs(local.x), Math.abs(local.z)) > EDGE_SLOW) input.forward = BOT.edgeWalk;
          }
          sim.tick(input, 1 / 64);
          if (sim.events.some((e) => e.type === 'teleport' || e.type === 'respawn')) break;
          if (!s.onGround) left = true;
          const loc = this.locate(sim);
          if (left && s.onGround) {
            ok = loc.kind === 'island' && loc.team === t.id;
            break;
          }
        }
        if (ok) {
          chosen = c;
          this.dropOk.add(t.id);
          break;
        }
      }
      this.drops.set(t.id, chosen);
      sim.mover.dispose();
    }
  }

  private placeAtSpawn(bot: Bot) {
    const sim = bot.sim;
    sim.respawn('spawn');
    sim.events.length = 0;
    // spread team-mates so their capsules do not overlap
    const q = surfaceFrame(upOf(sim.state.frame, _up));
    sim.state.pos.add(_v.set(1.4 * (bot.slot + 1), 0, -1.4 * bot.slot).applyQuaternion(q));
    sim.mover.place(sim.state);
    bot.prevPos.copy(sim.state.pos);
    bot.target.hp = MAX_HP;
    bot.target.alive = true;
    Object.assign(bot.weapons, createWeaponState());
    bot.routeKey = '';
    bot.enemy = null;
    bot.bedT = 0;
  }

  /** Dead bots wait far away so their capsule does not block anybody. */
  private park(bot: Bot) {
    bot.sim.state.pos.set(0, 5000 + bot.id * 5, 0);
    bot.sim.state.vel.set(0, 0, 0);
    bot.sim.mover.place(bot.sim.state);
    bot.prevPos.copy(bot.sim.state.pos);
  }

  // --- geometry helpers --------------------------------------------------------------------------

  /** Where the bot is: on a core face, on an island (street / roof), or in the air (no steering then). */
  locate(sim: PlayerSim): Loc {
    if (!sim.state.onGround) return { kind: 'air' };
    const up = upOf(sim.state.frame, _up);
    const team = teamByDown(up.clone().negate()).id;
    _inv.copy(surfaceFrame(up)).invert();
    const face = _v.copy(sim.state.pos).addScaledVector(up, -this.map.coreHalf).applyQuaternion(_inv);
    if (Math.abs(face.y - PLAYER_HEIGHT / 2) < 0.7 && Math.max(Math.abs(face.x), Math.abs(face.z)) < this.map.coreHalf + 0.6)
      return { kind: 'face', team, x: face.x, z: face.z, h: face.y, roof: false };
    const mid = _v.copy(sim.state.pos).addScaledVector(up, this.map.midDistance).applyQuaternion(_inv);
    if (mid.y > -1 && mid.y < 20 && Math.max(Math.abs(mid.x), Math.abs(mid.z)) < this.map.midHalf + 1)
      return { kind: 'mid', team, x: mid.x, z: mid.z, h: mid.y, roof: false };
    const isl = _v.copy(sim.state.pos).addScaledVector(up, this.map.islandDistance).applyQuaternion(_inv);
    const nav = this.map.nav[team];
    if (nav && isl.y > -1 && isl.y < nav.roofHeight + 10 && Math.max(Math.abs(isl.x), Math.abs(isl.z)) < this.map.islandHalf + 1)
      return { kind: 'island', team, x: isl.x, z: isl.z, h: isl.y, roof: isl.y > nav.roofHeight - 3 };
    return { kind: 'air' };
  }

  /** Local XZ on the bot's current surface → world point at the bot's height. */
  private toWorld(sim: PlayerSim, loc: Exclude<Loc, { kind: 'air' }>, p: XZ, out = new Vector3()) {
    const up = upOf(sim.state.frame, _up);
    const base = loc.kind === 'face' ? this.map.coreHalf : loc.kind === 'mid' ? -this.map.midDistance : -this.map.islandDistance;
    return out.set(p[0], loc.h, p[1]).applyQuaternion(surfaceFrame(up)).addScaledVector(up, base);
  }

  /** Walkable straight line? Rays at knee and chest height; characters do not count; portals count unless allowed. */
  private clear(sim: PlayerSim, from: Vector3, to: Vector3, portalsOk = false) {
    if (!portalsOk && sim.portals.some((p) => crossesPortal(p, from, to))) return false;
    const up = upOf(sim.state.frame, _up);
    for (const h of [-0.45, 0.4]) {
      const a = from.clone().addScaledVector(up, h);
      const b = to.clone().addScaledVector(up, h);
      if (!this.combat.lineOfSight(a, b, 0)) return false;
    }
    return true;
  }

  /** Set yaw / forward to walk along `dir` (world). */
  private steer(sim: PlayerSim, input: MoveInput, dir: Vector3) {
    const local = _v.copy(dir).applyQuaternion(_inv.copy(sim.state.frame).invert());
    if (local.x * local.x + local.z * local.z < 1e-6) return;
    input.yaw = Math.atan2(-local.x, -local.z);
    input.pitch = 0;
    input.forward = 1;
  }

  /** View angles looking at `dir` (world). */
  private look(sim: PlayerSim, dir: Vector3): [number, number] {
    const local = _v.copy(dir).normalize().applyQuaternion(_inv.copy(sim.state.frame).invert());
    return [Math.atan2(-local.x, -local.z), Math.asin(Math.max(-1, Math.min(1, local.y)))];
  }

  private nextFace(from: TeamId, to: TeamId): TeamId {
    const prev = new Map<TeamId, TeamId>([[from, from]]);
    const queue: TeamId[] = [from];
    while (queue.length) {
      const f = queue.shift()!;
      if (f === to) break;
      for (const p of this.portals.get(f) ?? []) if (!prev.has(p.to)) { prev.set(p.to, f); queue.push(p.to); }
    }
    let step = to;
    while (prev.get(step) !== from && prev.get(step) !== step) step = prev.get(step)!;
    return step;
  }

  // --- brain -------------------------------------------------------------------------------------

  private chooseGoal(bot: Bot): TeamId {
    const alive = TEAMS.filter((t) => t.id !== bot.team && this.match.bed(t.id).alive).map((t) => t.id);
    if (!alive.length) return this.playerTeam;
    if (alive.includes(this.playerTeam) && this.rng.chance(BOT.targetPlayerChance)) return this.playerTeam;
    const others = alive.filter((t) => t !== this.playerTeam);
    return others.length ? this.rng.pick(others) : this.playerTeam;
  }

  /** Team whose base the bot is heading for right now. */
  private heading(bot: Bot): TeamId {
    const ownBed = this.match.bed(bot.team).alive;
    const attacking = bot.role === 'attack' || !ownBed;
    if (!attacking || this.match.time < bot.departAt) return bot.team;
    if (!bot.goal || (bot.goal !== this.playerTeam && !this.match.bed(bot.goal).alive)) bot.goal = this.chooseGoal(bot);
    return bot.goal;
  }

  /** Route on the current surface: list of local XZ points + what to do at the end. */
  private route(bot: Bot, loc: Exclude<Loc, { kind: 'air' }>): { key: string; pts: XZ[]; end: 'go' | 'bed' | 'hold' } {
    const goal = this.heading(bot);
    const N = this.map.nav[loc.team];
    if (loc.kind === 'mid') {
      const [a, c] = this.map.mid[loc.team].portal;
      return { key: `mid:${loc.team}`, pts: [a, c], end: 'go' };
    }
    if (loc.kind === 'face') {
      if (loc.team === goal) {
        const d = this.drops.get(loc.team)!;
        return { key: `drop:${loc.team}`, pts: [d.approach, d.edge], end: 'go' };
      }
      const next = this.nextFace(loc.team, goal);
      const p = (this.portals.get(loc.team) ?? []).find((q) => q.to === next)!;
      const s = loc.z < p.z ? 1 : -1;
      return { key: `portal:${loc.team}:${next}`, pts: [[p.x, p.z - 3 * s], [p.x, p.z + 3 * s]], end: 'go' };
    }
    if (!loc.roof) {
      return { key: `lift:${loc.team}`, pts: [...roadPath(N, [loc.x, loc.z]), N.lift], end: 'go' };
    }
    if (loc.team !== goal) return { key: `geyser:${loc.team}`, pts: [N.roofMid, N.geyser], end: 'go' };
    if (goal !== bot.team && this.match.bed(goal).alive) return { key: `bed:${goal}:${bot.stand}`, pts: [N.bedStands[bot.stand % N.bedStands.length]], end: 'bed' };
    return { key: `patrol:${loc.team}:${bot.patrol}`, pts: [N.patrol[bot.patrol % N.patrol.length]], end: 'hold' };
  }

  private findEnemy(bot: Bot, eye: Vector3): Target | null {
    let best: Target | null = null;
    let bestD = BOT.sightRange;
    const home = this.heading(bot) === bot.team ? this.match.bed(bot.team).pos : null;
    for (const t of this.combat.targets) {
      if (!t.alive || t.team === bot.team) continue;
      if (home && t.center.distanceTo(home) > BOT.defendRadius) continue;
      const d = eye.distanceTo(t.center);
      if (d > bestD || !this.combat.lineOfSight(eye, t.center)) continue;
      best = t;
      bestD = d;
    }
    return best;
  }

  /** One simulation tick for every bot. */
  tick(dt: number) {
    for (const bot of this.bots) {
      if (bot.out) continue;
      if (!bot.target.alive) {
        if (bot.respawnT <= 0) {
          bot.respawnT = BOT.respawnDelay;
          this.park(bot);
        }
        bot.respawnT -= dt;
        bot.status = 'мёртв';
        if (bot.respawnT <= 0) {
          if (this.match.bed(bot.team).alive) {
            this.placeAtSpawn(bot);
            if (bot.role === 'attack') bot.departAt = this.match.time + BOT.reattack;
          } else {
            bot.out = true;
            bot.status = 'выбыл';
          }
        }
        continue;
      }
      bot.prevPos.copy(bot.sim.state.pos);
      const { input, fire, aim } = this.think(bot, dt);
      bot.sim.tick(input, dt);
      for (const e of bot.sim.events.splice(0)) {
        if (e.type === 'respawn' && e.reason === 'void') {
          bot.prevPos.copy(bot.sim.state.pos);
          if (this.match.bed(bot.team).alive) this.placeAtSpawn(bot);
          else {
            bot.target.alive = false;
            bot.respawnT = 0.01;
          }
        } else if (e.type === 'teleport') {
          bot.prevPos.copy(bot.sim.state.pos);
          bot.exitT = 1;
        }
      }
      upOf(bot.sim.state.frame, bot.target.up);
      const fired = weaponTick(bot.weapons, { fire, reload: false, select: null }, dt);
      if (fired && aim) {
        const eye = bot.sim.state.pos.clone().addScaledVector(bot.target.up, EYE_OFFSET);
        this.combat.fire(fired, bot.id, eye, aim, bot.sim.state.vel, bot.target.up.clone().negate());
        bot.shotsTotal++;
        if (++bot.shots >= BOT.burst) {
          bot.shots = 0;
          bot.pauseT = BOT.burstPause;
        }
      }
    }
  }

  private think(bot: Bot, dt: number): { input: MoveInput; fire: boolean; aim: Vector3 | null } {
    const sim = bot.sim;
    const s = sim.state;
    const input = emptyInput();
    input.yaw = s.yaw;
    input.pitch = s.pitch;
    const up = upOf(s.frame, new Vector3());
    const eye = s.pos.clone().addScaledVector(up, EYE_OFFSET);

    // perception
    bot.scanT -= dt;
    if (bot.scanT <= 0) {
      bot.scanT = 0.15;
      bot.enemy = this.findEnemy(bot, eye);
    }
    if (bot.enemy && !bot.enemy.alive) bot.enemy = null;
    bot.seenT = bot.enemy ? bot.seenT + dt : 0;
    bot.pauseT = Math.max(0, bot.pauseT - dt);
    const loc = this.locate(sim);

    let aimAt: Vector3 | null = null;
    let wantFire = false;
    const wish = new Vector3();

    // lost: wedged on a ledge, or standing on something that is neither a face nor an island (top of a portal
    // arch on the side of the core): hop, then give up and go home
    const lost = loc.kind === 'air' && (s.onGround || s.vel.lengthSq() < 0.36);
    bot.wedgeT = lost ? bot.wedgeT + dt : 0;
    if (bot.wedgeT > 0.5) bot.jumpT = 0.1;
    if (bot.wedgeT > 3) { bot.wedgeT = 0; this.placeAtSpawn(bot); }
    if (loc.kind === 'air') bot.status = 'в полёте';
    else {
      const r = this.route(bot, loc);
      if (r.key !== bot.routeKey) {
        bot.routeKey = r.key;
        bot.routePts = r.pts;
        bot.wp = 0;
        bot.detour = null;
        bot.checkT = 0;
        bot.bestDist = Infinity;
        bot.progressT = 0;
      }
      const pts = bot.routePts;
      const goalXZ = pts[Math.min(bot.wp, pts.length - 1)];
      const goal = this.toWorld(sim, loc, goalXZ);
      const planar = (p: Vector3) => { _v.copy(p).sub(s.pos); return _v.addScaledVector(up, -_v.dot(up)); };
      const dist = planar(goal).length();
      const last = bot.wp >= pts.length - 1;
      if (!last && dist < 0.9) bot.wp++;
      // reached the end of a 'go' route but nothing happened (portal from the wrong side, missed pad): re-plan
      if (last && r.end === 'go' && dist < 0.6) bot.routeKey = '';
      const arrived = last && r.end !== 'go' && dist < 0.6;

      // local planner: if the straight line is blocked, pick a detour point that sees both ends
      const portalsOk = (r.key.startsWith('portal:') || r.key.startsWith('mid:')) && last;
      bot.checkT -= dt;
      if (!arrived && bot.checkT <= 0 && bot.exitT <= 0) {
        bot.checkT = 0.5;
        if (bot.detour) {
          const d = this.toWorld(sim, loc, bot.detour);
          if (planar(d).length() < 0.9 || this.clear(sim, s.pos, goal, portalsOk)) bot.detour = null;
        } else if (!this.clear(sim, s.pos, goal, portalsOk)) bot.detour = this.findDetour(bot, loc, goal);
      }
      const steerTo = bot.detour ? this.toWorld(sim, loc, bot.detour) : goal;
      if (bot.exitT > 0) {
        // just came out of a portal: keep going the way the portal threw us
        bot.exitT -= dt;
        wish.copy(s.vel).addScaledVector(up, -s.vel.dot(up));
        if (wish.lengthSq() < 0.01) moveBasis(s.frame, s.yaw, wish, _right);
        wish.normalize();
      } else if (!arrived) {
        wish.copy(planar(steerTo)).normalize();
        if (loc.kind === 'face' && r.key.startsWith('drop:') && Math.max(Math.abs(loc.x), Math.abs(loc.z)) > EDGE_SLOW) wish.multiplyScalar(BOT.edgeWalk);
      }

      bot.status = r.key;
      // stuck: jump, then give up and go home
      const d2 = planar(steerTo).length();
      if (!arrived && d2 < bot.bestDist - 0.25) { bot.bestDist = d2; bot.progressT = 0; }
      else if (!arrived) bot.progressT += dt;
      if (bot.progressT > 1.2) {
        bot.jumpT = 0.25; bot.bestDist = d2; bot.progressT = 0; bot.stuckT += 1.2; bot.detour = null; bot.checkT = 0;
        // an intermediate point may sit inside something (a parked car): skip it
        if (!last && bot.stuckT > 2) bot.wp++;
      }
      if (arrived || bot.progressT === 0) bot.stuckT = Math.max(0, bot.stuckT - dt * 0.5);
      if (bot.stuckT > BOT.giveUp) { bot.stuckT = 0; this.placeAtSpawn(bot); }
      // stuck behind blocks (someone's wall, own fortification): shoot through them
      if (!arrived && bot.stuckT > 3 && bot.breach === null) bot.breach = this.blockInTheWay(sim, steerTo);
      if (bot.breach !== null) {
        const block = this.blocks.byCollider(bot.breach);
        if (!block) { bot.breach = null; bot.stuckT = 0; }
        else { aimAt = block.center.clone(); wantFire = true; bot.status = 'пробивает стену'; }
      }

      if (r.end === 'hold' && arrived) {
        bot.patrolT += dt;
        if (bot.patrolT > 5) { bot.patrolT = 0; bot.patrol++; }
      }
      if (r.end === 'bed' && arrived) {
        const bed = this.match.bed(this.heading(bot));
        const hit = this.match.firstHit(eye, bed.pos, sim.mover.collider);
        if (!hit) {
          aimAt = bed.pos.clone();
          bot.bedT += dt;
          bot.status = `ломает кристалл ${bed.team}`;
          if (bot.bedT >= BED_BREAK_TIME) { this.match.destroyBed(bed.team); bot.bedT = 0; }
        } else {
          bot.bedT = 0;
          const block = this.blocks.byCollider(hit.collider.handle);
          const dir = bed.pos.clone().sub(eye).normalize();
          if (block) {
            aimAt = eye.clone().addScaledVector(dir, hit.timeOfImpact + 0.1);
            wantFire = true;
            bot.status = 'ломает укрепление';
          } else {
            bot.standT += dt;
            if (bot.standT > 2) { bot.standT = 0; bot.stand++; }
          }
        }
      } else bot.bedT = 0;
    }

    // combat overrides the view: shoot the enemy while still walking the route
    if (bot.enemy && bot.seenT > BOT.reaction) {
      aimAt = bot.enemy.center.clone().addScaledVector(bot.enemy.up, 0.25);
      wantFire = true;
    }

    let aim: Vector3 | null = null;
    if (aimAt) {
      const dir = aimAt.sub(eye).normalize();
      [input.yaw, input.pitch] = this.look(sim, dir);
      aim = dir.add(new Vector3(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)).multiplyScalar(BOT.spread)).normalize();
    } else if (wish.lengthSq() > 0.01) {
      [input.yaw] = this.look(sim, wish);
      input.pitch = 0;
    }
    // movement relative to the view; none in the air (air strafing would bend geyser / drop trajectories)
    moveBasis(s.frame, input.yaw, _fwd, _right);
    if (!s.onGround) { /* ballistic */ } else if (wish.lengthSq() > 0.01) {
      input.forward = wish.dot(_fwd);
      input.right = wish.dot(_right);
    } else if (bot.enemy && bot.seenT > BOT.reaction) {
      input.right = Math.sin(this.match.time * 2.3 + bot.id) > 0 ? 1 : -1; // strafe while holding a position
    }
    if (bot.jumpT > 0) { input.jump = true; bot.jumpT -= dt; }
    return { input, fire: wantFire && bot.pauseT <= 0, aim };
  }

  /** Best intermediate point (rings around the bot) that sees both the bot and the goal. */
  private findDetour(bot: Bot, loc: Exclude<Loc, { kind: 'air' }>, goal: Vector3): XZ | null {
    const s = bot.sim.state;
    let best: XZ | null = null;
    let bestCost = Infinity;
    // greedy fallback: a reachable point that gets closest to the goal (re-planned from there)
    let greedy: XZ | null = null;
    let greedyD = s.pos.distanceTo(goal) - 1;
    for (const r of [2.5, 5, 9, 14]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const c: XZ = [loc.x + Math.cos(a) * r, loc.z + Math.sin(a) * r];
        const w = this.toWorld(bot.sim, loc, c);
        const cost = w.distanceTo(s.pos) + w.distanceTo(goal);
        const toGoal = w.distanceTo(goal);
        if (cost >= bestCost && toGoal >= greedyD) continue;
        if (!this.standable(bot.sim, w) || !this.clear(bot.sim, s.pos, w)) continue;
        if (cost < bestCost && this.clear(bot.sim, w, goal)) { best = c; bestCost = cost; }
        else if (toGoal < greedyD) { greedy = c; greedyD = toGoal; }
      }
      if (best) break;
    }
    return best ?? greedy;
  }

  /** First block on the straight path towards `to` (knee / chest height), if any. */
  private blockInTheWay(sim: PlayerSim, to: Vector3): number | null {
    const up = upOf(sim.state.frame, _up).clone();
    const dir = to.clone().sub(sim.state.pos);
    dir.addScaledVector(up, -dir.dot(up));
    if (dir.lengthSq() < 1e-4) return null;
    dir.normalize();
    for (const h of [-0.45, 0.4, 1.2]) {
      const from = sim.state.pos.clone().addScaledVector(up, h);
      const hit = this.world.castRay(new this.R.Ray(from, dir), 3, true, undefined, undefined, undefined, undefined, this.combat.notCharacter);
      if (hit && this.blocks.byCollider(hit.collider.handle)) return hit.collider.handle;
    }
    return null;
  }

  /** Is there ground under this point (do not detour into the void)? */
  private standable(sim: PlayerSim, p: Vector3) {
    const down = upOf(sim.state.frame, _up).clone().negate();
    return !!this.world.castRay(new this.R.Ray(p, down), PLAYER_HEIGHT / 2 + 0.5, true, undefined, undefined, undefined, undefined, this.combat.notCharacter);
  }
}

/** Shortest road path (Dijkstra over the island's road graph) from the node nearest to `from` to the lift node. */
export function roadPath(nav: IslandNav, from: XZ): XZ[] {
  const n = nav.nodes.length;
  const d2 = (a: XZ, b: XZ) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let start = 0;
  for (let i = 1; i < n; i++) if (d2(nav.nodes[i], from) < d2(nav.nodes[start], from)) start = i;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of nav.edges) { adj[a].push(b); adj[b].push(a); }
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[start] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === nav.liftNode) break;
    done[u] = true;
    for (const v of adj[u]) {
      const nd = dist[u] + d2(nav.nodes[u], nav.nodes[v]);
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
    }
  }
  const path: XZ[] = [];
  for (let u = nav.liftNode; u >= 0; u = prev[u]) { path.unshift(nav.nodes[u]); if (u === start) break; }
  if (path.length && path[0] !== nav.nodes[start]) return [nav.nodes[start], nav.nodes[nav.liftNode]];
  return path;
}
