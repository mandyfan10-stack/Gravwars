import { Quaternion, Vector3 } from 'three';
import { BlockSystem } from './blocks';
import { Combat, MAX_HP, Target } from './combat';
import { EYE_OFFSET, PLAYER_HEIGHT } from './constants';
import type { IslandNav, LaneDef, MapData } from './map';
import { BED_BREAK_TIME, Match } from './match';
import { Rng, upOf } from './math';
import { emptyInput, MoveInput, moveBasis } from './movement';
import type { PhysicsWorld, Rapier } from './physics';
import { PlayerSim } from './sim';
import { TeamId } from './teams';
import { createWeaponState, giveWeapon, isGun, WeaponId, WeaponState, weaponTick, WEAPONS } from './weapons';

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
  /**
   * Simplified economy: bots do not fish or shop. Everybody starts with fists like the player; a pistol arrives at
   * this match time, a rifle later. Ammo is unlimited.
   */
  pistolAt: 20,
  rifleAt: 150,
};

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Лёгкая', normal: 'Обычная', hard: 'Сложная' };
/** Bot tuning per difficulty, on top of the normal values above (the team size stays the same). */
const NORMAL = { ...BOT };
const DIFFICULTY: Record<Difficulty, Partial<typeof BOT>> = {
  easy: {
    sightRange: 24, reaction: 0.8, spread: 0.06, burst: 3, burstPause: 0.9,
    firstAttack: 120, attackStagger: 45, reattack: 50, targetPlayerChance: 0.4, pistolAt: 45, rifleAt: 240,
  },
  normal: {},
  hard: {
    sightRange: 36, reaction: 0.3, spread: 0.02, burst: 6, burstPause: 0.45,
    firstAttack: 40, attackStagger: 18, reattack: 15, targetPlayerChance: 0.7, pistolAt: 15, rifleAt: 110, respawnDelay: 3,
  },
};
/** Set the bot tuning for a difficulty. Call before the match starts. */
export function applyDifficulty(level: Difficulty) {
  Object.assign(BOT, NORMAL, DIFFICULTY[level]);
}

type XZ = [number, number];
/**
 * Where a bot stands: on an island (a base: `hall` = inside its hall, `roof` = on the hall roof) or on something
 * level with the central city (the city itself, the bridges, the bridge stubs), or in the air (no steering then).
 * x / z / h are in the frame of that surface.
 */
export type Loc =
  | { kind: 'island'; island: string; x: number; z: number; h: number; hall: boolean; roof: boolean }
  | { kind: 'center'; x: number; z: number; h: number }
  | { kind: 'air' };
type Ground = Exclude<Loc, { kind: 'air' }>;

interface IslandInfo { id: string; up: Vector3; q: Quaternion; inv: Quaternion; origin: Vector3; half: number; nav: IslandNav }

/** Hall height (map.ts genHall): above this - 1 m = on the roof. */
const HALL_ROOF = 7;

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
  /** Next bridge-piece check. */
  buildT: number;
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
const _inv = new Quaternion();
const _v = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();

/**
 * Bots: same movement / physics / weapons as the player. Navigation follows the map's structure:
 * hall → front door → walk into the bridge stub (gravity turns onto it) → along the own lane, laying floor pieces
 * over the void → central city → the target's lane → its stub → walk into its island → door → crystal.
 * A cheap local planner (line-of-sight detours) gets around obstacles on each surface.
 */
export class BotManager {
  readonly bots: Bot[] = [];
  private readonly rng = new Rng(4242);
  private readonly islands: IslandInfo[];
  private readonly centerQ: Quaternion;
  private readonly centerInv: Quaternion;
  /** Teams with an island (the others do not play). */
  private readonly teams: TeamId[];

  constructor(private R: Rapier, private world: PhysicsWorld, private map: MapData, private combat: Combat,
    private match: Match, private blocks: BlockSystem, readonly playerTeam: TeamId, perTeam = BOT.perTeam) {
    this.teams = map.teams as TeamId[];
    this.islands = map.islands.filter((i) => i.team).map((i) => {
      const q = new Quaternion(...i.quat);
      return { id: i.id, up: new Vector3(...i.up), q, inv: q.clone().invert(), origin: new Vector3(...i.origin), half: i.half, nav: map.nav[i.id] };
    });
    const c = map.islands.find((i) => i.id === 'center')!;
    this.centerQ = new Quaternion(...c.quat);
    this.centerInv = this.centerQ.clone().invert();
    match.membersAlive = (team) => this.bots.filter((b) => b.team === team && !b.out).length;
    match.characterFilter = combat.notCharacter;
    let id = 100;
    let wave = 0;
    for (const tid of this.teams) {
      if (tid === playerTeam) continue;
      const t = { id: tid };
      for (let slot = 0; slot < perTeam; slot++) {
        const role: BotRole = slot === 0 ? 'defend' : 'attack';
        const sim = new PlayerSim(R, world, map, t.id);
        sim.gravity.blocks = () => blocks.blocks.values();
        blocks.characters.push(sim.mover.collider); // building must not trap it (nor measure the ground on it)
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
          breach: null, wedgeT: 0, buildT: 0, bedT: 0, stand: 0, standT: 0, patrol: slot, patrolT: 0, prevPos: new Vector3(), status: '',
        };
        this.placeAtSpawn(bot);
        this.bots.push(bot);
      }
    }
  }

  /** Re-plan the attack waves from the current BOT tuning (difficulty changed before the match started). */
  retime() {
    let wave = 0;
    for (const b of this.bots) if (b.role === 'attack') b.departAt = BOT.firstAttack + BOT.attackStagger * wave++;
  }

  // --- setup ------------------------------------------------------------------------------------

  private placeAtSpawn(bot: Bot) {
    const sim = bot.sim;
    sim.respawn('spawn');
    sim.events.length = 0;
    // spread team-mates so their capsules do not overlap
    sim.state.pos.add(_v.set(1.4 * (bot.slot + 1), 0, -1.4 * bot.slot).applyQuaternion(sim.state.frame));
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

  /** Where the bot is (see Loc). */
  locate(sim: PlayerSim): Loc {
    if (!sim.state.onGround) return { kind: 'air' };
    const up = upOf(sim.state.frame, _up);
    if (up.z > 0.99) {
      const l = _v.copy(sim.state.pos).applyQuaternion(this.centerInv);
      return { kind: 'center', x: l.x, z: l.z, h: l.y };
    }
    const isl = this.islands.find((i) => i.up.dot(up) > 0.99);
    if (!isl) return { kind: 'air' };
    const l = _v.copy(sim.state.pos).sub(isl.origin).applyQuaternion(isl.inv);
    if (l.y < -1 || l.y > 60 || Math.max(Math.abs(l.x), Math.abs(l.z)) > isl.half + 1) return { kind: 'air' };
    const hall = isl.nav.hall!;
    const inRect = Math.max(Math.abs(l.x - hall.c[0]), Math.abs(l.z - hall.c[1])) < hall.half - 0.3;
    return { kind: 'island', island: isl.id, x: l.x, z: l.z, h: l.y, hall: inRect && l.y < HALL_ROOF - 1, roof: inRect && l.y > HALL_ROOF - 1 };
  }

  /** Local XZ on the bot's current surface → world point at the bot's height. */
  private toWorld(loc: Ground, p: XZ, out = new Vector3()) {
    if (loc.kind === 'center') return out.set(p[0], loc.h, p[1]).applyQuaternion(this.centerQ);
    const isl = this.islands.find((i) => i.id === loc.island)!;
    return out.set(p[0], loc.h, p[1]).applyQuaternion(isl.q).add(isl.origin);
  }

  /** Walkable straight line? Rays at knee and chest height; characters do not count. */
  private clear(sim: PlayerSim, from: Vector3, to: Vector3) {
    const up = upOf(sim.state.frame, _up);
    for (const h of [-0.45, 0.4]) {
      const a = from.clone().addScaledVector(up, h);
      const b = to.clone().addScaledVector(up, h);
      if (!this.combat.lineOfSight(a, b, 0)) return false;
    }
    return true;
  }

  /** View angles looking at `dir` (world). */
  private look(sim: PlayerSim, dir: Vector3): [number, number] {
    const local = _v.copy(dir).normalize().applyQuaternion(_inv.copy(sim.state.frame).invert());
    return [Math.atan2(-local.x, -local.z), Math.asin(Math.max(-1, Math.min(1, local.y)))];
  }

  // --- brain -------------------------------------------------------------------------------------

  private chooseGoal(bot: Bot): TeamId {
    const alive = this.teams.filter((t) => t !== bot.team && this.match.bed(t).alive);
    if (!alive.length) return this.playerTeam;
    if (alive.includes(this.playerTeam) && this.rng.chance(BOT.targetPlayerChance)) return this.playerTeam;
    const others = alive.filter((t) => t !== this.playerTeam);
    return others.length ? this.rng.pick(others) : this.playerTeam;
  }

  /** Team whose base the bot is heading for right now. */
  private heading(bot: Bot): TeamId {
    const ownBed = this.match.bed(bot.team).alive;
    const attacking = bot.role === 'attack' || !ownBed;
    // defenders have no departure time: they leave as soon as their own crystal is gone
    if (!attacking || (bot.role === 'attack' && this.match.time < bot.departAt)) return bot.team;
    // a goal without a crystal is dropped once another base is worth attacking (the player's team included:
    // a bot must not camp the player's roof forever while enemy crystals still stand)
    const enemyBeds = this.teams.some((t) => t !== bot.team && this.match.bed(t).alive);
    if (!bot.goal || (!this.match.bed(bot.goal).alive && (enemyBeds || this.match.isOut(bot.goal)))) bot.goal = this.chooseGoal(bot);
    return bot.goal;
  }

  /**
   * Route on the current surface: local XZ points + what to do at the end. `push`: the last point lies inside a wall
   * that turns the gravity (stub, island ground): walk straight into it, no detours.
   */
  private route(bot: Bot, loc: Ground): { key: string; pts: XZ[]; end: 'go' | 'bed' | 'hold'; push?: boolean } {
    const goal = this.heading(bot);
    if (loc.kind === 'center') return this.laneRoute(goal, loc);
    const N = this.map.nav[loc.island];
    const [hx, hz] = N.hall!.c;
    const doors = N.doors!;
    if (loc.roof) return { key: `roof:${loc.island}`, pts: [[hx + 10, hz + 10], [hx + 10, hz], [hx + 10, hz - 10]], end: 'go' };
    if (loc.island === goal) {
      if (!loc.hall) {
        const k = Math.hypot(loc.x - doors[0].out[0], loc.z - doors[0].out[1]) <= Math.hypot(loc.x - doors[1].out[0], loc.z - doors[1].out[1]) ? 0 : 1;
        return { key: `enter:${loc.island}:${k}`, pts: [doors[k].out, doors[k].in], end: 'go' };
      }
      if (goal !== bot.team && this.match.bed(goal).alive) return { key: `bed:${goal}:${bot.stand}`, pts: [N.bedStands![bot.stand % N.bedStands!.length]], end: 'bed' };
      return { key: `patrol:${loc.island}:${bot.patrol}`, pts: [N.patrol![bot.patrol % N.patrol!.length]], end: 'hold' };
    }
    // leave: out of the front door (around the crystal's fort), then into the stub
    if (loc.hall) return { key: `exit:${loc.island}`, pts: [[hx + Math.sign(loc.x - hx || 1) * 4.5, hz - 7], doors[0].in, doors[0].out], end: 'go' };
    return { key: `stub:${loc.island}`, pts: [N.stub![0], N.stub![1]], end: 'go', push: true };
  }

  /** The lane a point beyond the city's rim is on (bridges and stubs), or null inside the city. */
  private laneAt(x: number, z: number): TeamId | null {
    const H = this.map.centerHalf;
    if (Math.max(Math.abs(x), Math.abs(z)) < H) return null;
    let best: TeamId | null = null;
    let bd = Infinity;
    for (const t of this.teams) {
      const L = this.map.lanes[t];
      // distance to the segment rim → base
      const dx = L.base[0] - L.rim[0], dz = L.base[1] - L.rim[1];
      const k = Math.max(0, Math.min(1, ((x - L.rim[0]) * dx + (z - L.rim[1]) * dz) / (dx * dx + dz * dz)));
      const d = Math.hypot(x - L.rim[0] - dx * k, z - L.rim[1] - dz * k);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /** On the central city / a bridge: along own lane into the city, across the square, out along the goal's lane. */
  private laneRoute(goal: TeamId, loc: Extract<Loc, { kind: 'center' }>): { key: string; pts: XZ[]; end: 'go'; push: boolean } {
    const G: LaneDef = this.map.lanes[goal];
    const on = this.laneAt(loc.x, loc.z);
    if (on === goal) return { key: `lane:${goal}:out`, pts: [G.base], end: 'go', push: true };
    const pts: XZ[] = [];
    if (on) {
      const S = this.map.lanes[on];
      pts.push(S.rim, S.hub);
    } else if (Math.min(Math.abs(loc.x), Math.abs(loc.z)) > 8) {
      // off the boulevards (chased into the streets): back to the nearest one first
      pts.push(Math.abs(loc.x) < Math.abs(loc.z) ? [0, loc.z] : [loc.x, 0]);
    }
    pts.push(G.hub, G.rim, G.base);
    return { key: `lane:${goal}:${on ?? 'city'}`, pts, end: 'go', push: true };
  }

  /** Bridge building: on a lane beyond the rim, lay a floor piece ahead if there is nothing to walk on. */
  private bridge(bot: Bot, loc: Ground, wish: Vector3, dt: number) {
    if (loc.kind !== 'center' || wish.lengthSq() < 0.01) return;
    if (Math.max(Math.abs(loc.x), Math.abs(loc.z)) < this.map.centerHalf - 5) return;
    bot.buildT -= dt;
    if (bot.buildT > 0) return;
    bot.buildT = 0.1;
    const s = bot.sim.state;
    const up = upOf(s.frame, _up).clone();
    const plan = this.blocks.plan('floor', s.pos, up, wish);
    if (!plan) return;
    // something to walk on there already (the city, a stub, a piece somebody built)?
    const from = plan.center.clone().addScaledVector(up, 0.6);
    const hit = this.world.castRay(new this.R.Ray(from, up.clone().negate()), 1, true, undefined, undefined, undefined, undefined, this.combat.notCharacter);
    if (hit) return;
    this.blocks.place(plan, 'wood', bot.team, true);
  }

  private findEnemy(bot: Bot, eye: Vector3): Target | null {
    let best: Target | null = null;
    let bestD = BOT.sightRange;
    const home = this.heading(bot) === bot.team ? this.match.bed(bot.team).pos : null;
    for (const t of this.combat.targets) {
      if (!t.alive || t.team === bot.team) continue;
      if (home && t.center.distanceTo(home) > BOT.defendRadius) continue;
      const d = eye.distanceTo(t.center);
      // city NPCs: only those who go for this bot or get in its face
      if (t.npc && t.aggro !== bot.id && d > 4) continue;
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
        }
      }
      upOf(bot.sim.state.frame, bot.target.up);
      const select = this.arm(bot);
      // semi-automatic guns fire on the press: release the trigger every other tick
      const pull = fire && (WEAPONS[bot.weapons.current].auto || !bot.weapons.held);
      const fired = weaponTick(bot.weapons, { fire: pull, reload: false, select }, dt);
      if (fired && aim) {
        const eye = bot.sim.state.pos.clone().addScaledVector(bot.target.up, EYE_OFFSET);
        this.combat.use(fired, bot.id, eye, aim, bot.sim.state.vel, bot.target.up.clone().negate());
        bot.shotsTotal++;
        if (++bot.shots >= BOT.burst) {
          bot.shots = 0;
          bot.pauseT = BOT.burstPause;
        }
      }
    }
  }

  /** Bot loadout by match time (see BOT.pistolAt); returns the weapon to hold. Spare ammo never runs out. */
  private arm(bot: Bot): WeaponId {
    const ws = bot.weapons;
    const t = this.match.time;
    if (t >= BOT.pistolAt && !ws.owned.pistol) giveWeapon(ws, 'pistol');
    if (t >= BOT.rifleAt && !ws.owned.rifle) giveWeapon(ws, 'rifle');
    for (const w of ['pistol', 'rifle'] as const) if (isGun(w) && ws.owned[w]) ws.reserve[w] = 999;
    return ws.owned.rifle ? 'rifle' : ws.owned.pistol ? 'pistol' : 'fists';
  }

  /** How far the bot's current weapon is worth using. */
  private range(bot: Bot) {
    return bot.weapons.current === 'fists' ? WEAPONS.fists.reach : BOT.sightRange;
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

    // lost: wedged on a ledge, or standing on something that is no known surface: hop, then give up and go home
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
      const goal = this.toWorld(loc, goalXZ);
      const planar = (p: Vector3) => { _v.copy(p).sub(s.pos); return _v.addScaledVector(up, -_v.dot(up)); };
      const dist = planar(goal).length();
      const last = bot.wp >= pts.length - 1;
      if (!last && dist < 0.9) bot.wp++;
      // reached the end of a 'go' route but nothing happened (the gravity did not turn): re-plan
      if (last && r.end === 'go' && dist < 0.6) bot.routeKey = '';
      const arrived = last && r.end !== 'go' && dist < 0.6;

      // local planner: if the straight line is blocked, pick a detour point that sees both ends
      const push = !!r.push && last;
      bot.checkT -= dt;
      if (push) bot.detour = null;
      else if (!arrived && bot.checkT <= 0) {
        bot.checkT = 0.5;
        if (bot.detour) {
          const d = this.toWorld(loc, bot.detour);
          if (planar(d).length() < 0.9 || this.clear(sim, s.pos, goal)) bot.detour = null;
        } else if (!this.clear(sim, s.pos, goal)) bot.detour = this.findDetour(bot, loc, goal);
      }
      const steerTo = bot.detour ? this.toWorld(loc, bot.detour) : goal;
      if (!arrived) wish.copy(planar(steerTo)).normalize();
      this.bridge(bot, loc, wish, dt);

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
    if (bot.enemy && bot.seenT > BOT.reaction && eye.distanceTo(bot.enemy.center) < this.range(bot) + 0.3) {
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
  private findDetour(bot: Bot, loc: Ground, goal: Vector3): XZ | null {
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
        const w = this.toWorld(loc, c);
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
