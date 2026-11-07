import { Quaternion, Vector3 } from 'three';
import { BlockMaterial, BlockSystem, PiecePlan } from './blocks';
import { lootValue, Needs, nextBuy, shop } from './botShop';
import { Combat, MAX_HP, Target } from './combat';
import { DEFAULT_MOVEMENT, EYE_OFFSET, PLAYER_HALF_SEGMENT, PLAYER_HEIGHT, PLAYER_RADIUS } from './constants';
import { Currency, EAT_COOLDOWN, Economy, ITEMS, MAX_MEDKITS, Pickup, Pickups, PICKUPS } from './economy';
import { FISHING } from './fishing';
import { FaceId, FaceNav, HALL_H, LaneDef, MapData, navPath, nearestNode } from './map';
import { BED_HP, KILL_REWARD, Match } from './match';
import { Rng, upOf } from './math';
import { emptyInput, MoveInput, moveBasis } from './movement';
import type { PhysicsWorld, Rapier } from './physics';
import { PlayerSim } from './sim';
import { TeamId } from './teams';
import { createWeaponState, hasAmmo, isGun, KICK, kicked, kickReady, WeaponId, WeaponState, weaponTick, WEAPONS } from './weapons';

/** Tuning. Times in seconds, distances in metres. */
export const BOT = {
  perTeam: 2,
  sightRange: 30,
  /** Away from a raid, a bot fights enemies on its own face, or others this close (no sniping at other faces' walls). */
  defendRadius: 14,
  /** Delay between first seeing an enemy and opening fire. */
  reaction: 0.45,
  /** Aim error, radians (1 sigma-ish). */
  spread: 0.03,
  /** Share of a moving target's lead the bot gets right (bullets are slow: aim where the enemy will be). */
  lead: 0.8,
  burst: 5,
  burstPause: 0.6,
  respawnDelay: 4,
  /** The first raider may set off this long after the start (once it has its gear); the others follow one by one. */
  firstAttack: 60,
  attackStagger: 25,
  /** A raider that died sets off again after this. */
  reattack: 25,
  /** Chance that a raider goes for the player's crystal rather than another bot team's. */
  targetPlayerChance: 0.6,
  /** No progress for this long → teleport home (last-resort unstuck). */
  giveUp: 20,
  /** Chance to strike in time when a fish bites (bots fish like the player: a rod from the shop, park ponds). */
  fishSkill: 0.75,
  /**
   * How often a bot gets things wrong (0..1): stops and looks around, takes a wrong turn, shoots the crystal from too
   * far, sets off without enough wood, reloads at the start of a fight, buys junk.
   */
  mistakes: 0.15,
  /** A raider still not equipped this long after its departure time goes with what it has. */
  patience: 80,
  /** Chance that a raider still at home runs back to the crystal when the base is attacked. */
  answer: 0.6,
  /** HP below which a bot uses a medkit. */
  healAt: 40,
  /** A raider waits this long at the door for a squad mate. */
  rally: 10,
  /** Chance that the defender joins a squad mate's raid when the base is calm (+25 % after 5 minutes). */
  join: 0.3,
};

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Лёгкая', normal: 'Обычная', hard: 'Сложная' };
/** Bot tuning per difficulty, on top of the normal values above (the team size stays the same). */
const NORMAL = { ...BOT };
const DIFFICULTY: Record<Difficulty, Partial<typeof BOT>> = {
  easy: {
    sightRange: 24, reaction: 0.8, spread: 0.06, lead: 0.45, burst: 3, burstPause: 0.9,
    firstAttack: 120, attackStagger: 45, reattack: 50, targetPlayerChance: 0.4,
    fishSkill: 0.55, mistakes: 0.35, patience: 140, answer: 0.35, healAt: 25, rally: 6, join: 0.15,
  },
  normal: {},
  hard: {
    sightRange: 36, reaction: 0.3, spread: 0.02, lead: 1, burst: 6, burstPause: 0.45,
    firstAttack: 40, attackStagger: 18, reattack: 15, targetPlayerChance: 0.7, respawnDelay: 3,
    fishSkill: 0.92, mistakes: 0.05, patience: 60, answer: 0.85, healAt: 50, rally: 14, join: 0.45,
  },
};
/** Set the bot tuning for a difficulty. Call before the match starts. */
export function applyDifficulty(level: Difficulty) {
  Object.assign(BOT, NORMAL, DIFFICULTY[level]);
}
/** A separate tuning for one bot (lobby: every bot has its own difficulty). */
export function tuning(level: Difficulty): typeof BOT {
  return { ...NORMAL, ...DIFFICULTY[level] };
}
/** Bots per team, by difficulty (lobby). Teams left out get none; the player's team may have bots (allies). */
export type BotRoster = Partial<Record<TeamId, Difficulty[]>>;

type XZ = [number, number];
/**
 * Where a bot stands: on a face of the cube (`hall` = inside its team hall, `roof` = on the hall roof; `lane` = on
 * the bridge of one of this face's lanes, beyond its rim), or in the air (no steering then). x / z / h are in the
 * face's frame.
 */
export type Loc =
  | { kind: 'face'; face: FaceId; x: number; z: number; h: number; hall: boolean; roof: boolean; lane: LaneDef | null }
  | { kind: 'air' };
type Ground = Exclude<Loc, { kind: 'air' }>;

interface FaceInfo { id: FaceId; team: string | null; up: Vector3; q: Quaternion; inv: Quaternion; origin: Vector3; half: number; nav: FaceNav }

/**
 * A route on the current face: face-local XZ points and what to do at the end (`act` / `hold` / `bed`: stop there;
 * `go`: walk on, the gravity turns). `strict`: points from this index on are a bridge lane: never skipped when stuck,
 * no detours (a detour off a lane is a fall into the void). `arrive`: how close counts as there. `wrong`: a crossing
 * off the way (a wrong turn, when the bot makes that mistake).
 */
interface Route {
  key: string; pts: XZ[]; end: 'go' | 'bed' | 'hold' | 'act'; push?: boolean; lane?: LaneDef; strict?: number; arrive?: number; wrong?: XZ;
}

export type BotRole = 'defend' | 'attack';

/** What a bot is busy with (it always has one). */
export type Task =
  /** Pick up something lying around (apples, bottles, money). */
  | { kind: 'gather'; item: Pickup }
  /** Fish at a pond (stand = which side). */
  | { kind: 'fish'; pond: number; stand: number }
  /** Kill a bandit for the money it drops. */
  | { kind: 'hunt'; target: Target }
  /** Sell the loot and buy at a counter. */
  | { kind: 'shop'; shop: number }
  /** Crystals from a generator of a neutral face. */
  | { kind: 'crystals'; gen: number }
  /** Patch the fort around its own crystal. */
  | { kind: 'fortify' }
  /** The base is attacked: back to the crystal, fight the intruders. */
  | { kind: 'defend' }
  /** Wait at the door for a squad mate. */
  | { kind: 'rally' }
  /** Off to break an enemy crystal. */
  | { kind: 'raid' }
  /** Walk around the own hall (or head home) until something turns up. */
  | { kind: 'patrol' };
export type TaskKind = Task['kind'];
export const TASK_LABEL: Record<TaskKind, string> = {
  gather: 'собирает', fish: 'идёт на рыбалку', hunt: 'охотится на бандита', shop: 'идёт в магазин', crystals: 'за кристаллами',
  fortify: 'чинит укрепление', defend: 'защищает базу', rally: 'ждёт напарника', raid: 'рейд', patrol: 'патрулирует',
};

/** Where the task takes the bot: a team's hall (a raid, home duties) or a point on a face. */
type Dest =
  | { kind: 'bed'; face: FaceId; team: TeamId }
  | { kind: 'home'; face: FaceId }
  | { kind: 'point'; face: FaceId; pt: XZ; hall: boolean; key: string; end: 'act' | 'hold'; arrive: number };

export interface Bot {
  id: number;
  team: TeamId;
  role: BotRole;
  /** Index among the team's bots (spawn offset). */
  slot: number;
  /** Its tuning: the shared BOT (follows applyDifficulty) or its own difficulty from the lobby. */
  tune: typeof BOT;
  sim: PlayerSim;
  target: Target;
  weapons: WeaponState;
  /** Money (cash, crystals): earned, picked up and spent by the player's rules. */
  wallet: Record<Currency, number>;
  /** Building material it carries (bridges, the crystal's fort). */
  kit: Record<BlockMaterial, number>;
  /** Pockets, tools and the shop: the same rules as the player's. */
  eco: Economy;
  /** Character: prefers the shotgun, earns with a rod, makes crystal runs. */
  likes: { shotgun: boolean; fish: boolean; crystals: boolean };
  task: Task;
  /** Seconds in the current task; time to the next re-plan; the task is over (plan the next one now). */
  taskT: number;
  planT: number;
  done: boolean;
  /** A defender who went raiding with a squad mate (back to the crystal after a death). */
  joined: boolean;
  /** Sets off unprepared (out of patience, or a mistake). */
  rash: boolean;
  /** Buys something less useful first on this shop visit (a mistake). */
  impulse: boolean;
  /** Alarm (serial) this raider already decided about. */
  answered: number;
  /** Team whose crystal the raider is going for. */
  goal: TeamId | null;
  /** Lives so far: picks a different face to cross when the goal is on the opposite face. */
  trip: number;
  /** Match time when the raider may set off. */
  departAt: number;
  respawnT: number;
  /** Eliminated: dead with no crystal. */
  out: boolean;
  enemy: Target | null;
  seenT: number;
  scanT: number;
  /** Seconds since an enemy was last in sight. */
  calmT: number;
  shots: number;
  /** All shots fired (views animate on change). */
  shotsTotal: number;
  /** All kicks made (views animate on change). */
  kicksTotal: number;
  pauseT: number;
  /** Current route (local XZ points of the current surface, frozen while the key stays the same) and progress. */
  route: Route | null;
  routeKey: string;
  routePts: XZ[];
  strictAt: number | undefined;
  wp: number;
  detour: XZ | null;
  checkT: number;
  progressT: number;
  bestDist: number;
  stuckT: number;
  jumpT: number;
  /** Block in the way that the bot is shooting through (collider handle), and for how long. */
  breach: number | null;
  breachT: number;
  /** Time spent off the ground without moving (wedged on a ledge). */
  wedgeT: number;
  /** Time it has stayed within a metre of `anchor` although it should be going somewhere (wedged on a post, behind a counter). */
  frozenT: number;
  anchor: Vector3;
  /** A hop in a random direction to get unstuck: seconds left and where. */
  nudgeT: number;
  nudge: Vector3;
  /** Next bridge-piece / fort-block check. */
  buildT: number;
  /** Lane pieces missing just ahead and no wood to lay them. */
  blocked: boolean;
  /** Standing at the end of the bridge without wood (s); times it had to give up a way like that. */
  strandT: number;
  strands: number;
  stand: number;
  standT: number;
  patrol: number;
  patrolT: number;
  /** Blasting the enemy crystal's fort with rockets from further back first. */
  rocketFort: boolean;
  /** Shooting the crystal from too far (a mistake): seconds left. */
  farT: number;
  /** Stopped to look around (a mistake): seconds left; time to the next roll. */
  hesitateT: number;
  mistakeT: number;
  /** Fishing: time since the cast, when the fish bites, fish caught on this trip. */
  fishT: number;
  fishAt: number;
  caught: number;
  /** At the pond with the line in the water right now (the view shows the rod). */
  fishing: boolean;
  /** Waiting on the spot (s): at an empty generator, at the counter. */
  genWait: number;
  eatT: number;
  lootT: number;
  nadeT: number;
  rocketT: number;
  /** A weapon it means to use for a moment (a grenade throw, rockets at a fort) and for how long. */
  pick: WeaponId | null;
  pickT: number;
  /** Who hurt it last (target id) and when (match time). */
  hurtBy: number;
  hurtT: number;
  /** Spots it gave up on (pickups, ponds, generators): key → until match time. */
  avoid: Map<string, number>;
  /** Totals (tests, debug): money earned (sales, drops, kills) / spent, pieces built, pickups taken, purchases. */
  earned: number;
  spent: number;
  built: number;
  /** Match time of the last piece it laid (the "builds a bridge" status). */
  builtAt: number;
  taken: number;
  bought: string[];
  /** Position before the last tick (render interpolation). */
  prevPos: Vector3;
  /** Short description of what the bot is doing (debug HUD). */
  status: string;
}

interface ShopSpot { face: FaceId; team: string; xz: XZ; hall: boolean }
/** A pond: the water, the sides to fish from, and its sunken basin (face-local centre / half size, rim included). */
interface PondSpot { face: FaceId; water: Vector3; stands: XZ[]; c: XZ; h: XZ }
interface GenSpot { face: FaceId; xz: XZ }
interface FortCell { pos: Vector3; material: BlockMaterial }
interface Alarm { until: number; by: Target | null; serial: number }
interface Thought { input: MoveInput; fire: boolean; aim: Vector3 | null; kick: Vector3 | null; reload: boolean; select: WeaponId }

const _up = new Vector3();
const _inv = new Quaternion();
const _v = new Vector3();
const _l = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const GUNS = ['rifle', 'shotgun', 'pistol'] as const;
/**
 * Where a raider with a gun stands, m from the crystal axis: the line from its eye to the top of the crystal clears
 * the 3-block fort (top 3 m up, ring out to 2.5 m), and the eye is still within CRYSTAL.range of the axis.
 */
const BED_STAND = 4.6;
/** It aims this far above the crystal's centre (over the fort). */
const BED_AIM = 1;
/** Seconds of one fishing round: cast, wait for the bite, strike, pause. */
const fishRound = (rng: Rng) => FISHING.castTime + rng.range(FISHING.waitMin, FISHING.waitMax) + FISHING.biteTime * 0.55 + FISHING.after;

/**
 * Bots: same movement / physics / weapons / shop rules as the player. Every bot always has a task: earn money
 * (pick up apples / bottles / dropped cash, fish, hunt bandits, crystals from the neutral generators), shop, patch
 * its crystal's fort, defend the base when it is attacked, gather a squad and raid an enemy crystal (paying for the
 * bridges with its own wood). Navigation follows the map: hall → door → roads to a bridge lane at the rim → along
 * the lane (laying its missing pieces) to the corner, up the next face's wall, off the landing onto that face →
 * (the opposite face: through a neighbour) → door → crystal. A cheap local planner (line-of-sight detours) gets
 * around obstacles on each surface.
 */
export class BotManager {
  readonly bots: Bot[] = [];
  private readonly rng = new Rng(4242);
  private readonly faces: FaceInfo[];
  /** Lane pieces as build plans (bots lay the missing ones as they walk a lane). */
  private readonly lanePlans = new Map<string, PiecePlan[]>();
  /** Teams with a face (the others do not play). */
  private readonly teams: TeamId[];
  private readonly byId = new Map<number, Bot>();
  /** Where to stand at every shop counter, by the ponds, at the generators; the forts around the crystals. */
  private readonly shops: ShopSpot[] = [];
  private readonly ponds: PondSpot[] = [];
  private readonly gens: GenSpot[] = [];
  private readonly forts = new Map<TeamId, FortCell[]>();
  private readonly alarms = new Map<TeamId, Alarm>();
  private watchT = 0;
  private keys = { version: -1, set: new Set<string>() };
  private readonly gaps = new Map<TeamId, { t: number; cells: FortCell[] }>();
  private loot: Pickups | null = null;

  constructor(private R: Rapier, private world: PhysicsWorld, private map: MapData, private combat: Combat,
    private match: Match, private blocks: BlockSystem, readonly playerTeam: TeamId, perTeam = BOT.perTeam, roster?: BotRoster) {
    this.teams = map.teams as TeamId[];
    this.faces = map.faces.map((f) => {
      const q = new Quaternion(...f.quat);
      return { id: f.id, team: f.team, up: new Vector3(...f.up), q, inv: q.clone().invert(), origin: new Vector3(...f.origin), half: f.half, nav: map.nav[f.id] };
    });
    for (const l of map.lanes) this.lanePlans.set(l.id, l.pieces.map((p) => ({
      kind: p.kind, center: new Vector3(...p.center), half: new Vector3(...p.half), quat: new Quaternion(...p.quat), key: p.key, level: p.level,
    })));
    match.membersAlive = (team) => this.bots.filter((b) => b.team === team && !b.out).length;
    match.characterFilter = combat.notCharacter;
    match.attach(combat);
    this.survey();
    // a bot that kills a fighter of another team earns the same reward as the player
    const prevKill = combat.onKill;
    combat.onKill = (victim, owner) => {
      prevKill(victim, owner);
      const b = this.byId.get(owner);
      if (b && !victim.npc && victim.team !== b.team) {
        b.wallet.cash += KILL_REWARD;
        b.earned += KILL_REWARD;
      }
    };
    let id = 100;
    let wave = 0;
    for (const tid of this.teams) {
      // no roster: the old setup, `perTeam` bots with the shared tuning in every team but the player's
      const levels: (Difficulty | null)[] = roster ? roster[tid] ?? [] : tid === playerTeam ? [] : Array(perTeam).fill(null);
      for (let slot = 0; slot < levels.length; slot++) {
        const level = levels[slot];
        const tune = level ? tuning(level) : BOT;
        // the first bot of every team (allies too) stays home, the rest go on the attack
        const role: BotRole = slot === 0 ? 'defend' : 'attack';
        const sim = new PlayerSim(R, world, map, tid);
        sim.gravity.blocks = () => blocks.blocks.values();
        blocks.characters.push(sim.mover.collider); // building must not trap it (nor measure the ground on it)
        combat.addCharacter(sim.mover.collider);
        const target: Target = {
          id: id++, team: tid, center: sim.state.pos, up: upOf(sim.state.frame), vel: sim.state.vel, hp: MAX_HP, alive: true, respawnIn: -1, regen: true,
          onImpulse: (v) => sim.applyImpulse(v),
        };
        combat.targets.push(target);
        const weapons = createWeaponState();
        const wallet = { cash: 0, crystal: 0 };
        const kit: Record<BlockMaterial, number> = { wood: 0, stone: 0, metal: 0 };
        const bot: Bot = {
          id: target.id, team: tid, role, slot, tune, sim, target, weapons, wallet, kit, eco: new Economy(wallet, { inventory: kit }, weapons),
          likes: { shotgun: this.rng.chance(0.35), fish: role === 'defend' || this.rng.chance(0.65), crystals: this.rng.chance(0.5) },
          task: { kind: 'patrol' }, taskT: 0, planT: this.rng.range(0, 0.5), done: true, joined: false, rash: false, impulse: false, answered: 0,
          goal: null, trip: slot, departAt: role === 'attack' ? tune.firstAttack + tune.attackStagger * wave++ : Infinity,
          respawnT: 0, out: false, enemy: null, seenT: 0, scanT: this.rng.range(0, 0.15), calmT: 0, shots: 0, shotsTotal: 0, kicksTotal: 0, pauseT: 0,
          route: null, routeKey: '', routePts: [], strictAt: undefined, wp: 0, detour: null, checkT: 0, progressT: 0, bestDist: Infinity, stuckT: 0,
          jumpT: 0, breach: null, breachT: 0, wedgeT: 0, frozenT: 0, anchor: new Vector3(), nudgeT: 0, nudge: new Vector3(), buildT: 0, blocked: false, strandT: 0, strands: 0, stand: slot, standT: 0, patrol: slot, patrolT: 0,
          rocketFort: false, farT: 0, hesitateT: 0, mistakeT: this.rng.range(8, 20), fishT: 0, fishAt: 0, caught: 0, fishing: false, genWait: 0, eatT: 0, lootT: 0,
          nadeT: 0, rocketT: 0, pick: null, pickT: 0, hurtBy: -1, hurtT: -99, avoid: new Map(), earned: 0, spent: 0, built: 0, builtAt: -99, taken: 0, bought: [],
          prevPos: new Vector3(), status: '',
        };
        target.onHit = (owner) => {
          bot.hurtBy = owner;
          bot.hurtT = this.match.time;
        };
        this.placeAtSpawn(bot);
        this.bots.push(bot);
        this.byId.set(bot.id, bot);
      }
    }
  }

  /** Pickups on the map (apples, bottles, dropped money): bots collect and sell them. Set by the game. */
  get pickups() {
    return this.loot;
  }
  set pickups(p: Pickups | null) {
    this.loot = p;
    if (p) p.passThrough ??= this.combat.notCharacter;
  }

  /** Re-plan the attack waves from the current BOT tuning (difficulty changed before the match started). */
  retime() {
    let wave = 0;
    for (const b of this.bots) if (b.role === 'attack') b.departAt = b.tune.firstAttack + b.tune.attackStagger * wave++;
  }

  // --- setup ------------------------------------------------------------------------------------

  /** Where bots stand at the shop counters, by the ponds and the generators; the forts around the crystals. */
  private survey() {
    const map = this.map;
    for (const b of map.bases) {
      const up = new Vector3(...b.up);
      const f = this.faceOfUp(up);
      if (!f) continue;
      const shop = new Vector3(...b.shop);
      const out = shop.clone().sub(new Vector3(...b.keeper.pos));
      out.addScaledVector(up, -out.dot(up)).normalize();
      const xz = this.localXZ(f, shop.addScaledVector(out, 1.6));
      this.shops.push({ face: f.id, team: b.team, xz, hall: this.inHall(f, xz) });
    }
    for (const p of map.ponds) {
      const f = this.faceOfUp(new Vector3(...p.up));
      if (!f) continue;
      const q = new Quaternion(...p.quat), water = new Vector3(...p.pos);
      const stands: XZ[] = [];
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const w = new Vector3(ax * (p.half[0] + 1.4), 0, az * (p.half[1] + 1.4)).applyQuaternion(q).add(water);
        if (this.spotFree(f, w)) stands.push(this.localXZ(f, w));
      }
      // the basin in face-local axes (a pond turned by 90° swaps its sizes)
      const ax = new Vector3(1, 0, 0).applyQuaternion(q).applyQuaternion(f.inv);
      const h: XZ = Math.abs(ax.x) > 0.7 ? [p.half[0], p.half[1]] : [p.half[1], p.half[0]];
      this.ponds.push({ face: f.id, water, stands, c: this.localXZ(f, water), h });
    }
    for (const g of this.match.generators) {
      const f = this.faceOfUp(g.up)!;
      this.gens.push({ face: f.id, xz: this.localXZ(f, g.pos) });
    }
    for (const s of map.statues) this.forts.set(s.team as TeamId, s.fort.map((c) => ({ pos: new Vector3(...c.pos), material: c.material })));
  }

  /** Can a bot stand here: street-level ground under it, nothing in the way of its body? */
  private spotFree(f: FaceInfo, p: Vector3) {
    const from = p.clone().addScaledVector(f.up, 3);
    const hit = this.world.castRay(new this.R.Ray(from, f.up.clone().negate()), 6, true, undefined, undefined, undefined, undefined,
      this.combat.notCharacter);
    if (!hit) return false;
    const ground = from.addScaledVector(f.up, -hit.timeOfImpact);
    if (ground.clone().sub(f.origin).dot(f.up) > 1.2) return false; // on top of something (a bench, a car)
    const c = ground.addScaledVector(f.up, PLAYER_HEIGHT / 2 + 0.1);
    return !this.world.intersectionWithShape(c, f.q, new this.R.Capsule(PLAYER_HALF_SEGMENT, PLAYER_RADIUS), undefined, undefined, undefined,
      undefined, this.combat.notCharacter);
  }

  /** (Re)spawn: gear, money and tools stay with the bot (the pockets were spilled where it died). */
  private placeAtSpawn(bot: Bot) {
    const sim = bot.sim;
    sim.respawn('spawn');
    sim.events.length = 0;
    // spread team-mates so their capsules do not overlap
    sim.state.pos.add(_v.set(1.4 * ((bot.slot % 3) + 1), 0, -1.5 * Math.floor(bot.slot / 3)).applyQuaternion(sim.state.frame));
    sim.mover.place(sim.state);
    bot.prevPos.copy(sim.state.pos);
    bot.target.hp = MAX_HP;
    bot.target.alive = true;
    this.combat.guard(bot.target);
    bot.weapons.reloadT = 0;
    bot.routeKey = '';
    bot.route = null;
    bot.enemy = null;
    bot.trip++;
    bot.task = { kind: 'patrol' };
    bot.done = true;
    bot.joined = false;
    bot.rash = false;
    bot.rocketFort = false;
    bot.farT = 0;
    bot.strands = 0;
    bot.blocked = false;
    bot.pick = null;
    bot.breach = null;
    bot.stuckT = 0;
    bot.frozenT = 0;
    bot.nudgeT = 0;
  }

  /** Dead bots wait far away so their capsule does not block anybody. */
  private park(bot: Bot) {
    bot.sim.state.pos.set(0, 5000 + bot.id * 5, 0);
    bot.sim.state.vel.set(0, 0, 0);
    bot.sim.mover.place(bot.sim.state);
    bot.prevPos.copy(bot.sim.state.pos);
  }

  /** Death: the items and half of the cash fall out where the body is (`drop` false: lost in the void). */
  private spill(bot: Bot, drop: boolean) {
    const piles = bot.eco.spill();
    if (!drop || !this.loot) return;
    for (const p of piles) this.loot.drop(p.kind, bot.sim.state.pos, bot.target.up, p.amount);
  }

  // --- geometry helpers --------------------------------------------------------------------------

  private face(id: FaceId) {
    return this.faces.find((f) => f.id === id)!;
  }

  private faceOfUp(up: Vector3) {
    return this.faces.find((f) => f.up.dot(up) > 0.99) ?? null;
  }

  /** The face of a team. */
  private teamFace(team: TeamId) {
    return this.faces.find((f) => f.team === team) ?? this.faces[0];
  }

  private localXZ(f: FaceInfo, p: Vector3): XZ {
    _l.copy(p).sub(f.origin).applyQuaternion(f.inv);
    return [_l.x, _l.z];
  }

  private inHall(f: FaceInfo, p: XZ) {
    const h = f.nav.hall;
    return !!h && Math.max(Math.abs(p[0] - h.c[0]), Math.abs(p[1] - h.c[1])) < h.half - 0.3;
  }

  /** The pond whose sunken basin (+ `margin`) contains this face-local point, if any. */
  private wet(face: FaceId, x: number, z: number, margin = 0.5): PondSpot | null {
    for (const p of this.ponds)
      if (p.face === face && Math.abs(x - p.c[0]) < p.h[0] + margin && Math.abs(z - p.c[1]) < p.h[1] + margin) return p;
    return null;
  }

  /** Does the straight line a → b (face-local) cross a pond? (A basin is a pit: the rays of `clear` pass over it.) */
  private crossesPond(face: FaceId, a: XZ, b: XZ) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let t = 0; t <= len; t += 0.8) {
      const k = len ? t / len : 0;
      if (this.wet(face, a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, 0.4)) return true;
    }
    return false;
  }

  private adjacent(a: FaceId, b: FaceId) {
    return Math.abs(this.face(a).up.dot(this.face(b).up)) < 0.5;
  }

  /** Where the bot is (see Loc). */
  locate(sim: PlayerSim): Loc {
    if (!sim.state.onGround) return { kind: 'air' };
    const up = upOf(sim.state.frame, _up);
    const f = this.faces.find((i) => i.up.dot(up) > 0.99);
    if (!f) return { kind: 'air' };
    const l = _v.copy(sim.state.pos).sub(f.origin).applyQuaternion(f.inv);
    if (l.y < -3 || l.y > 2 * this.map.cube.half) return { kind: 'air' };
    let lane: LaneDef | null = null;
    if (Math.max(Math.abs(l.x), Math.abs(l.z)) > f.half) {
      // beyond the rim: on the bridge of one of this face's lanes (or on somebody's own stray floor)
      let bd = 10;
      for (const L of this.map.lanes) {
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
  private toWorld(loc: Ground, p: XZ, out = new Vector3()) {
    const f = this.face(loc.face);
    return out.set(p[0], loc.h, p[1]).applyQuaternion(f.q).add(f.origin);
  }

  /** Walkable straight line? Rays at knee and chest height (characters do not count), and no pond on the way. */
  private clear(sim: PlayerSim, from: Vector3, to: Vector3) {
    const up = upOf(sim.state.frame, _up);
    for (const h of [-0.45, 0.4]) {
      const a = from.clone().addScaledVector(up, h);
      const b = to.clone().addScaledVector(up, h);
      if (!this.combat.lineOfSight(a, b, 0)) return false;
    }
    const f = this.faceOfUp(up);
    return !f || !this.crossesPond(f.id, this.localXZ(f, from), this.localXZ(f, to));
  }

  /** View angles looking at `dir` (world). */
  private look(sim: PlayerSim, dir: Vector3): [number, number] {
    const local = _v.copy(dir).normalize().applyQuaternion(_inv.copy(sim.state.frame).invert());
    return [Math.atan2(-local.x, -local.z), Math.asin(Math.max(-1, Math.min(1, local.y)))];
  }

  // --- what the world looks like to a bot --------------------------------------------------------

  /** Keys of every piece standing (lane pieces count as built when a player put the same piece there). */
  private builtKeys() {
    if (this.keys.version !== this.blocks.version) {
      this.keys.version = this.blocks.version;
      this.keys.set.clear();
      for (const b of this.blocks.blocks.values()) if (b.key) this.keys.set.add(b.key);
    }
    return this.keys.set;
  }

  /** Pieces of a lane not built yet. */
  private missing(L: LaneDef) {
    const keys = this.builtKeys();
    return this.lanePlans.get(L.id)!.reduce((n, p) => n + (keys.has(p.key) ? 0 : 1), 0);
  }

  /** Holes in the fort around a team's crystal (cached for a moment). */
  private fortGap(team: TeamId): FortCell[] {
    const g = this.gaps.get(team);
    if (g && this.match.time - g.t < 2) return g.cells;
    const cells = (this.forts.get(team) ?? []).filter((c) => this.blocks.isFree(c.pos));
    this.gaps.set(team, { t: this.match.time, cells });
    return cells;
  }

  /** Material for a fort block: the one the cell had, else whatever it carries (null = nothing). */
  private material(bot: Bot, want: BlockMaterial): BlockMaterial | null {
    for (const m of [want, 'stone', 'metal', 'wood'] as BlockMaterial[]) if (bot.kit[m] > 0) return m;
    return null;
  }

  /** Raider: goes for enemy crystals (attackers, a defender who joined a squad, everybody once the own crystal is gone). */
  private raider(bot: Bot) {
    return bot.role === 'attack' || bot.joined || !this.match.bed(bot.team).alive;
  }

  /** Has a gun with at least this many rounds (a shotgun counts with fewer: 12). */
  private armed(bot: Bot, rounds: number) {
    const ws = bot.weapons;
    return GUNS.some((w) => ws.owned[w] && ws.ammo[w] + ws.reserve[w] >= (w === 'shotgun' ? Math.min(rounds, 12) : rounds));
  }

  /** Wood the bridges between `from` and the raid goal still need (+2 spare), 0 if they are all built. */
  private woodNeed(bot: Bot, from = this.teamFace(bot.team).id): number {
    const goal = this.teamFace(this.raidGoal(bot)).id;
    let miss = 0;
    let at = from;
    for (let k = 0; k < 3 && at !== goal; k++) {
      const next = this.nextFace(bot, at, goal);
      miss += this.missing(this.laneBetween(at, next));
      at = next;
    }
    return miss ? miss + 2 : 0;
  }

  /** Ready to raid: a gun with ammo, and wood for the bridges (or none needed). */
  private ready(bot: Bot) {
    const need = this.woodNeed(bot);
    return this.armed(bot, 30) && (need === 0 || (bot.eco.has('builder') && bot.kit.wood >= need));
  }

  private needs(bot: Bot): Needs {
    const raider = this.raider(bot);
    return {
      raider, wood: raider ? this.woodNeed(bot) : 0, fort: raider ? 0 : this.fortGap(bot.team).length,
      shotgun: bot.likes.shotgun, fisher: bot.likes.fish, impulse: bot.impulse,
    };
  }

  /** Something at the shop it can afford now (after selling its loot), or loot worth cashing in. */
  private worthShopping(bot: Bot) {
    const loot = lootValue(bot.eco);
    return loot >= 30 || nextBuy(bot.eco, this.needs(bot), loot) !== null;
  }

  private avoided(bot: Bot, key: string) {
    return (bot.avoid.get(key) ?? -1) > this.match.time;
  }

  /** A counter the bot may use on this face (its own team's or a neutral one), nearest first; -1 = none. */
  private shopOn(bot: Bot, face: FaceId): number {
    let best = -1, bd = Infinity;
    const pos = bot.sim.state.pos;
    this.shops.forEach((s, i) => {
      if (s.face !== face || (s.team !== bot.team && s.team !== '') || this.avoided(bot, `shop${i}`)) return;
      const d = this.toWorldXZ(s.face, s.xz).distanceTo(pos);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  private toWorldXZ(face: FaceId, p: XZ, out = new Vector3()) {
    const f = this.face(face);
    return out.set(p[0], 0, p[1]).applyQuaternion(f.q).add(f.origin);
  }

  /** The best thing lying on the own face within `radius` of `from`: worth the walk, not claimed by a team-mate. */
  private bestPickup(bot: Bot, from: Vector3, radius: number): Pickup | null {
    if (!this.loot) return null;
    const f = this.teamFace(bot.team);
    const pos = bot.sim.state.pos;
    // keep away from the bandits (unarmed: well away)
    const gangs = this.gangs(f);
    const keep = this.armed(bot, 1) ? 9 : 16;
    // the player's team-mates leave the apples and bottles to the player once they can fish
    const ally = bot.team === this.playerTeam && bot.eco.has('rod');
    let best: Pickup | null = null, score = 0;
    for (const it of this.loot.items) {
      if (!it.alive || it.up.dot(f.up) < 0.99) continue;
      if (it.kind === 'medkit' && bot.eco.items.medkit >= MAX_MEDKITS) continue;
      if (ally && (it.kind === 'apple' || it.kind === 'bottle')) continue;
      if (it.pos.distanceTo(from) > radius || this.avoided(bot, `item${it.id}`)) continue;
      if (gangs.some((g) => g.center.distanceTo(it.pos) < keep)) continue;
      if (this.bots.some((o) => o !== bot && o.task.kind === 'gather' && o.task.item === it)) continue;
      const value = it.kind === 'cash' ? it.amount : ITEMS[it.kind].sell * Math.max(1, it.amount) || 6;
      const sc = value / (it.pos.distanceTo(pos) + 12);
      if (sc > score) { score = sc; best = it; }
    }
    return best;
  }

  /** Bandits alive on a face. */
  private gangs(f: FaceInfo) {
    return this.combat.targets.filter((t) => t.alive && t.npc === 'gang' && t.up.dot(f.up) > 0.99);
  }

  /** Money per second a pickup is worth, counting the walk there. */
  private pickupRate(bot: Bot, it: Pickup) {
    const value = it.kind === 'cash' ? it.amount : ITEMS[it.kind].sell * Math.max(1, it.amount) || 6;
    return value / (it.pos.distanceTo(bot.sim.state.pos) / 6 + 2.5);
  }

  /** A free side of a pond on the own face, nearest to the bot (defenders: also near the hall); null = none. */
  private pond(bot: Bot): [number, number] | null {
    const home = this.teamFace(bot.team);
    const pos = bot.sim.state.pos;
    const hall = home.nav.hall ? this.toWorldXZ(home.id, home.nav.hall.c) : pos;
    const stay = !this.raider(bot);
    const gangs = this.gangs(home);
    let best: [number, number] | null = null, bd = Infinity;
    this.ponds.forEach((p, i) => {
      if (p.face !== home.id || gangs.some((g) => g.center.distanceTo(p.water) < 14)) return;
      p.stands.forEach((_, j) => {
        if (this.avoided(bot, `pond${i}:${j}`)) return;
        if (this.bots.some((o) => o !== bot && o.task.kind === 'fish' && o.task.pond === i && o.task.stand === j)) return;
        // the fish are sold in the hall: a pond near it is worth more (defenders stay close anyway)
        const d = p.water.distanceTo(pos) + p.water.distanceTo(hall) * (stay ? 1 : 0.6);
        if (d < bd) { bd = d; best = [i, j]; }
      });
    });
    return best;
  }

  /** A bandit on the own face within `r`: it drops money when killed. */
  private bandit(bot: Bot, r: number): Target | null {
    const up = this.teamFace(bot.team).up;
    let best: Target | null = null, bd = r;
    for (const t of this.combat.targets) {
      if (!t.alive || t.npc !== 'gang' || t.up.dot(up) < 0.99) continue;
      const d = t.center.distanceTo(bot.sim.state.pos);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /**
   * A generator worth a crystal run (rockets cost crystals): one on the neutral face the bot is crossing, or, while a
   * raider waits for its departure, one on a neutral face next door with a bridge it can afford. -1 = none.
   */
  private genRun(bot: Bot, here: FaceId): number {
    const ws = bot.weapons;
    // only once it has its main gun: rockets are a luxury
    if (!bot.likes.crystals || !this.raider(bot) || !(ws.owned.rifle || ws.owned.shotgun) || !this.armed(bot, 15) || this.match.time < 120) return -1;
    if (bot.wallet.crystal >= 5 || (ws.owned.rocket && ws.ammo.rocket + ws.reserve.rocket >= 4)) return -1;
    const home = this.teamFace(bot.team).id;
    let best = -1, bs = 0;
    this.gens.forEach((g, i) => {
      if (this.avoided(bot, `gen${i}`)) return;
      const stored = this.match.generators[i].stored;
      let w = 0;
      if (g.face === here && here !== home && stored > 0) w = stored + 1;
      else if (here === home && this.match.time < bot.departAt && stored >= 2 && this.adjacent(home, g.face)) {
        const miss = this.missing(this.laneBetween(home, g.face));
        if (miss === 0 || (bot.eco.has('builder') && bot.kit.wood >= miss + 2)) w = stored * 0.5;
      }
      if (w > bs) { bs = w; best = i; }
    });
    return best;
  }

  /** Per team: is the base attacked (crystal hit, enemy fighters close to it)? Checked four times a second. */
  private watch(dt: number) {
    this.watchT -= dt;
    if (this.watchT > 0) return;
    this.watchT = 0.25;
    const now = this.match.time;
    for (const team of this.teams) {
      const bed = this.match.bed(team);
      if (!bed.alive) continue;
      const f = this.teamFace(team);
      let by: Target | null = null, bd = 30;
      for (const t of this.combat.targets) {
        if (!t.alive || t.npc || t.team === team || t.up.dot(f.up) < 0.9) continue;
        const d = t.center.distanceTo(bed.pos);
        if (d < bd) { bd = d; by = t; }
      }
      const hit = bed.hp < BED_HP && bed.calm < 1;
      const a = this.alarms.get(team) ?? { until: -1, by: null, serial: 0 };
      if (hit || by) {
        if (a.until < now) a.serial++;
        a.until = now + 8;
        if (by) a.by = by;
      }
      if (a.by && !a.by.alive) a.by = null;
      this.alarms.set(team, a);
    }
  }

  private alarmed(team: TeamId) {
    const a = this.alarms.get(team);
    return !!a && a.until > this.match.time && this.match.bed(team).alive;
  }

  // --- brain: tasks -----------------------------------------------------------------------------

  private setTask(bot: Bot, task: Task) {
    bot.done = false;
    if (sameTask(task, bot.task)) return;
    bot.task = task;
    bot.taskT = 0;
    bot.stuckT = 0;
    if (task.kind === 'fish') { bot.fishT = 0; bot.fishAt = fishRound(this.rng); bot.caught = 0; }
    if (task.kind === 'shop') bot.impulse = this.rng.chance(bot.tune.mistakes * 0.5);
    if (task.kind === 'crystals' || task.kind === 'shop') bot.genWait = 0;
  }

  /** The task is over: plan the next one at once. */
  private finish(bot: Bot) {
    bot.done = true;
    bot.planT = 0;
  }

  /** Re-plan: the alarm first; otherwise keep the task while it makes sense, then choose the next one. */
  private plan(bot: Bot, loc: Loc) {
    const home = this.teamFace(bot.team);
    const a = this.alarms.get(bot.team);
    if (a && this.alarmed(bot.team) && bot.task.kind !== 'defend') {
      const atHome = loc.kind === 'face' ? loc.face === home.id : bot.target.up.dot(home.up) > 0.99;
      if (atHome) {
        let go = !this.raider(bot) || bot.joined;
        if (!go && bot.answered !== a.serial) {
          bot.answered = a.serial;
          go = this.rng.chance(bot.tune.answer);
        }
        if (go) {
          bot.joined = false;
          this.setTask(bot, { kind: 'defend' });
          return;
        }
      }
    }
    if (loc.kind === 'air' && !bot.done) return;
    if (!this.valid(bot, loc)) this.setTask(bot, this.choose(bot, loc));
  }

  private valid(bot: Bot, loc: Loc): boolean {
    if (bot.done) return false;
    const task = bot.task, t = bot.taskT;
    switch (task.kind) {
      case 'defend': return this.alarmed(bot.team);
      case 'gather': return task.item.alive && t < 30;
      case 'fish': return t < 90 && !this.worthShopping(bot);
      case 'hunt': return task.target.alive && t < 40 && bot.target.hp > 35 && this.armed(bot, 1)
        && task.target.center.distanceTo(bot.sim.state.pos) < 70;
      case 'shop': return t < 60;
      case 'crystals': return t < 150 && bot.wallet.crystal < 8 && bot.genWait < 18;
      case 'fortify': return t < 45 && this.fortGap(bot.team).length > 0 && !!this.material(bot, 'stone');
      case 'rally': return t < bot.tune.rally + 3;
      case 'raid': {
        if (!this.raider(bot)) return false;
        // nothing left to shoot with, still at home: restock first
        const atHome = loc.kind === 'face' && loc.face === this.teamFace(bot.team).id;
        if (this.armed(bot, 1)) return true;
        if (atHome) return !this.worthShopping(bot);
        const goalBed = this.match.bed(this.raidGoal(bot));
        return bot.wallet.cash < 6 || (goalBed.alive && goalBed.pos.distanceTo(bot.sim.state.pos) < 20);
      }
      case 'patrol': return t < 5;
    }
  }

  private choose(bot: Bot, loc: Loc): Task {
    const t = this.match.time;
    const home = this.teamFace(bot.team).id;
    const here = loc.kind === 'face' ? loc.face : home;
    const bedAlive = this.match.bed(bot.team).alive;
    if (this.raider(bot)) {
      this.raidGoal(bot);
      const canGo = bot.joined || !bedAlive || t >= bot.departAt;
      if (canGo && here !== home) {
        // out there already: crystals and a counter on a neutral face on the way, then on with the raid
        const gen = this.genRun(bot, here);
        if (gen >= 0) return { kind: 'crystals', gen };
        const s = this.shopOn(bot, here);
        if (s >= 0 && this.worthShopping(bot)) return { kind: 'shop', shop: s };
        // out of ammo but not of money: home for more (unless the crystal is right there)
        const own = this.shopOn(bot, home);
        const goalBed = this.match.bed(this.raidGoal(bot));
        if (own >= 0 && !this.armed(bot, 1) && bot.wallet.cash >= 6 && !(goalBed.alive && goalBed.pos.distanceTo(bot.sim.state.pos) < 20))
          return { kind: 'shop', shop: own };
        return { kind: 'raid' };
      }
      if (canGo) {
        // geared up, or fed up with waiting (or just rash: a mistake)
        if (!bot.rash && (t >= bot.departAt + bot.tune.patience || !bedAlive || this.rng.chance(bot.tune.mistakes * 0.15))) bot.rash = true;
        if (this.ready(bot) || bot.rash) {
          const s = this.shopOn(bot, here);
          if (s >= 0 && !bot.rash && this.worthShopping(bot)) return { kind: 'shop', shop: s };
          return this.squad(bot) ? { kind: 'rally' } : { kind: 'raid' };
        }
      }
    }
    const s = this.shopOn(bot, here);
    if (s >= 0 && this.worthShopping(bot)) return { kind: 'shop', shop: s };
    if (!this.raider(bot) && bedAlive && here === home && bot.eco.has('builder') && this.fortGap(bot.team).length
      && this.material(bot, 'stone')) return { kind: 'fortify' };
    const gen = this.genRun(bot, here);
    if (gen >= 0) return { kind: 'crystals', gen };
    return this.earn(bot, here);
  }

  /** Make money: a bandit nearby, things lying around, fishing; else back to the hall. */
  private earn(bot: Bot, here: FaceId): Task {
    const home = this.teamFace(bot.team);
    if (here !== home.id) return { kind: 'patrol' }; // head home first
    const stay = !this.raider(bot);
    const from = stay && home.nav.hall ? this.toWorldXZ(home.id, home.nav.hall.c) : bot.sim.state.pos;
    const radius = stay ? 60 : 140;
    // bandits: only with a gun that kills them before the ammo costs more than they drop
    const ws = bot.weapons;
    if (((ws.owned.rifle && ws.ammo.rifle + ws.reserve.rifle >= 40) || (ws.owned.shotgun && ws.ammo.shotgun + ws.reserve.shotgun >= 12))
      && bot.target.hp > 60) {
      const g = this.bandit(bot, stay ? 35 : 55);
      if (g) return { kind: 'hunt', target: g };
    }
    const it = this.bestPickup(bot, from, radius);
    const p = bot.eco.has('rod') ? this.pond(bot) : null;
    // with a rod, a walk is only worth it for something that pays better than fishing
    const fishing = (ITEMS.fish.sell * bot.tune.fishSkill) / 5.6;
    if (it && (!p || this.pickupRate(bot, it) > fishing * 0.8)) return { kind: 'gather', item: it };
    if (p) return { kind: 'fish', pond: p[0], stand: p[1] };
    return { kind: 'patrol' };
  }

  /** Is a squad mate coming (a ready raider, the defender joining)? Asks the defender along. */
  private squad(bot: Bot): boolean {
    if (!this.match.bed(bot.team).alive) return false;
    const t = this.match.time;
    let any = false;
    for (const m of this.bots) {
      if (m === bot || m.team !== bot.team || m.out || !m.target.alive) continue;
      if (m.task.kind === 'rally') { any = true; continue; }
      if (m.task.kind === 'raid' || m.task.kind === 'defend') continue;
      if (m.role === 'attack' && t >= m.departAt - 15 && this.ready(m)) any = true;
      else if (m.role === 'defend' && !m.joined && this.mayJoin(m)) {
        m.joined = true;
        m.goal = bot.goal;
        this.setTask(m, { kind: 'rally' });
        any = true;
      }
    }
    return any;
  }

  /** The defender goes along when the base is calm, the fort holds and it is armed. */
  private mayJoin(def: Bot) {
    const a = this.alarms.get(def.team);
    if (a && a.until > this.match.time - 30) return false;
    if (!this.armed(def, 30) || def.target.hp < 70 || this.fortGap(def.team).length > 4) return false;
    return this.rng.chance(def.tune.join + (this.match.time > 300 ? 0.25 : 0));
  }

  /** Squad meeting point: outside the front door (team-mates side by side). */
  private rallyPoint(bot: Bot): XZ {
    const N = this.teamFace(bot.team).nav;
    const o = N.doors![0].out;
    return [o[0] + (bot.slot % 2 ? 2.2 : -2.2), o[1] - 2];
  }

  private chooseGoal(bot: Bot): TeamId {
    const alive = this.teams.filter((t) => t !== bot.team && this.match.bed(t).alive);
    const fallback = bot.team !== this.playerTeam ? this.playerTeam : this.teams.find((t) => t !== bot.team) ?? bot.team;
    if (!alive.length) return fallback;
    if (alive.includes(this.playerTeam) && this.rng.chance(bot.tune.targetPlayerChance)) return this.playerTeam;
    const others = alive.filter((t) => t !== this.playerTeam);
    if (!others.length) return fallback;
    // a neighbour (one bridge) rather than the far side; few defenders; a damaged crystal; holes in the fort
    const home = this.teamFace(bot.team);
    const w = others.map((t) => {
      const near = Math.abs(this.teamFace(t).up.dot(home.up)) < 0.5 ? 2 : 1;
      const guards = this.bots.filter((b) => b.team === t && b.target.alive && !b.out).length;
      const bed = this.match.bed(t);
      return (near * (1 + (BED_HP - bed.hp) / BED_HP) * (1 + this.fortGap(t).length / 16)) / (1 + guards * 0.5);
    });
    let r = this.rng.range(0, w.reduce((a, b) => a + b, 0));
    for (let i = 0; i < others.length; i++) if ((r -= w[i]) <= 0) return others[i];
    return others[others.length - 1];
  }

  /** Team whose crystal the raider goes for (a broken one is dropped once another base is worth attacking). */
  private raidGoal(bot: Bot): TeamId {
    const enemyBeds = this.teams.some((t) => t !== bot.team && this.match.bed(t).alive);
    if (!bot.goal || bot.goal === bot.team || (!this.match.bed(bot.goal).alive && (enemyBeds || this.match.isOut(bot.goal)))) bot.goal = this.chooseGoal(bot);
    return bot.goal;
  }

  private dest(bot: Bot): Dest {
    const task = bot.task;
    const home = this.teamFace(bot.team).id;
    switch (task.kind) {
      case 'raid': {
        const team = this.raidGoal(bot);
        return { kind: 'bed', face: this.teamFace(team).id, team };
      }
      case 'shop': {
        const s = this.shops[task.shop];
        return { kind: 'point', face: s.face, pt: s.xz, hall: s.hall, key: `shop${task.shop}`, end: 'act', arrive: 0.8 };
      }
      case 'gather': {
        const f = this.faceOfUp(task.item.up);
        if (!f) break;
        const pt = this.localXZ(f, task.item.pos);
        return { kind: 'point', face: f.id, pt, hall: this.inHall(f, pt), key: `item${task.item.id}`, end: 'act', arrive: 1.2 };
      }
      case 'fish': {
        const p = this.ponds[task.pond];
        return { kind: 'point', face: p.face, pt: p.stands[task.stand], hall: false, key: `pond${task.pond}:${task.stand}`, end: 'act', arrive: 0.7 };
      }
      case 'hunt': {
        const f = this.faceOfUp(task.target.up);
        if (!f) break;
        const pt = this.localXZ(f, task.target.center);
        return { kind: 'point', face: f.id, pt, hall: false, key: `hunt${task.target.id}:${Math.round(pt[0] / 5)}:${Math.round(pt[1] / 5)}`, end: 'hold', arrive: 8 };
      }
      case 'crystals': {
        const g = this.gens[task.gen];
        return { kind: 'point', face: g.face, pt: g.xz, hall: false, key: `gen${task.gen}`, end: 'act', arrive: 1 };
      }
      case 'rally': {
        const pt = this.rallyPoint(bot);
        return { kind: 'point', face: home, pt, hall: false, key: `rally${bot.slot % 2}`, end: 'act', arrive: 1.2 };
      }
    }
    return { kind: 'home', face: home };
  }

  /** The task's own business on the spot (or on the way). */
  private act(bot: Bot, arrived: boolean, dt: number): { aim?: Vector3; fire?: boolean; label?: string } | null {
    const task = bot.task;
    const pos = bot.sim.state.pos;
    switch (task.kind) {
      case 'shop': {
        if (!arrived) return null;
        // a moment at the counter (sell, pick, pay)
        bot.genWait += dt;
        if (bot.genWait < 1) return { label: 'покупает' };
        const r = shop(bot.eco, () => this.needs(bot));
        bot.earned += r.sold;
        bot.spent += r.spent;
        bot.bought.push(...r.bought);
        this.finish(bot);
        return { label: 'покупает' };
      }
      case 'gather': {
        if (!task.item.alive) { this.finish(bot); return null; }
        if (pos.distanceTo(task.item.pos) < PICKUPS.reach) {
          this.take(bot, task.item);
          this.finish(bot);
        }
        return null;
      }
      case 'fish': {
        if (!arrived) return null;
        bot.fishT += dt;
        if (bot.fishT >= bot.fishAt) {
          if (this.rng.chance(bot.tune.fishSkill)) { bot.eco.items.fish++; bot.caught++; }
          bot.fishT = 0;
          bot.fishAt = fishRound(this.rng);
        }
        bot.fishing = true;
        return { aim: this.ponds[task.pond].water.clone(), label: 'рыбачит' };
      }
      case 'crystals': {
        if (!arrived) return null;
        const n = this.match.collect(pos);
        if (n > 0) { bot.wallet.crystal += n; bot.earned += n; bot.genWait = 0; }
        else bot.genWait += dt;
        if (bot.wallet.crystal >= 5) this.finish(bot);
        // empty for long: maybe the other one has some
        if (bot.genWait > 6 && this.match.generators.some((g, i) => i !== task.gen && g.stored > 0 && this.gens[i].face === this.gens[task.gen].face)) {
          bot.avoid.set(`gen${task.gen}`, this.match.time + 20);
          this.finish(bot);
        }
        return { label: 'ждёт кристаллы' };
      }
      case 'fortify': {
        if (!arrived) return null;
        bot.buildT -= dt;
        if (bot.buildT > 0) return { label: 'чинит укрепление' };
        bot.buildT = 0.4;
        for (const c of this.fortGap(bot.team)) {
          if (c.pos.distanceTo(pos) > 7.5) continue;
          if (this.combat.targets.some((t) => t.alive && t.center.distanceTo(c.pos) < 1.4)) continue;
          const m = this.material(bot, c.material);
          if (!m) break;
          if (!this.blocks.isFree(c.pos)) continue;
          this.blocks.add(c.pos, m, bot.team);
          bot.kit[m]--;
          bot.built++;
          this.gaps.delete(bot.team);
          return { aim: c.pos.clone(), label: 'чинит укрепление' };
        }
        this.finish(bot);
        return null;
      }
      case 'rally': {
        if (!arrived) return null;
        const mates = this.bots.filter((m) => m !== bot && m.team === bot.team && m.target.alive && !m.out && m.task.kind === 'rally'
          && m.sim.state.pos.distanceTo(pos) < 10);
        if (mates.length || bot.taskT > bot.tune.rally) {
          for (const m of [bot, ...mates]) {
            m.goal = bot.goal;
            m.trip = bot.trip;
            this.setTask(m, { kind: 'raid' });
          }
        }
        return null;
      }
    }
    return null;
  }

  /** Pick up a pickup within reach. */
  private take(bot: Bot, it: Pickup) {
    if (!this.loot || !it.alive) return;
    if (it.kind === 'medkit' && bot.eco.items.medkit >= MAX_MEDKITS) return;
    this.loot.take(it);
    if (it.kind === 'cash') { bot.wallet.cash += it.amount; bot.earned += it.amount; }
    else bot.eco.items[it.kind] += Math.max(1, it.amount);
    bot.taken++;
  }

  /** Every tick, whatever the task: heal (medkit when badly hurt, apples), pick up what lies within reach. */
  private upkeep(bot: Bot, dt: number) {
    bot.eatT -= dt;
    bot.lootT -= dt;
    bot.nadeT -= dt;
    bot.rocketT -= dt;
    const tg = bot.target;
    if (bot.eatT <= 0) {
      if (tg.hp < bot.tune.healAt && bot.eco.take('medkit')) {
        tg.hp = MAX_HP;
        bot.eatT = 1.5;
        bot.pauseT = Math.max(bot.pauseT, 0.5);
      } else if (tg.hp < MAX_HP - ITEMS.apple.heal && bot.eco.take('apple')) {
        tg.hp = Math.min(MAX_HP, tg.hp + ITEMS.apple.heal);
        bot.eatT = EAT_COOLDOWN + 0.4;
      }
    }
    if (bot.lootT <= 0 && this.loot) {
      bot.lootT = 0.3;
      const it = this.loot.nearest(bot.sim.state.pos);
      if (it && it.up.dot(tg.up) > 0.9) this.take(bot, it);
    }
  }

  /** Out of wood at the end of a bridge: home to buy more, or (away from home) another way / another goal. */
  private stranded(bot: Bot, loc: Ground) {
    bot.strandT = 0;
    if (loc.face === this.teamFace(bot.team).id) {
      bot.rash = false;
      bot.departAt = Math.max(bot.departAt, this.match.time + 30);
      const s = this.shopOn(bot, loc.face);
      this.setTask(bot, s >= 0 ? { kind: 'shop', shop: s } : { kind: 'patrol' });
      return;
    }
    bot.strands++;
    bot.trip++;
    if (bot.strands >= 2) bot.goal = this.chooseGoal(bot);
    if (bot.strands > 3) this.placeAtSpawn(bot);
    bot.routeKey = '';
  }

  // --- brain: getting there ------------------------------------------------------------------------

  /** Face to cross to next on the way from `from` to `to`: the goal itself if adjacent, else one of the four between. */
  private nextFace(bot: Bot, from: FaceId, to: FaceId): FaceId {
    const a = this.face(from), b = this.face(to);
    if (Math.abs(a.up.dot(b.up)) < 0.5) return to;
    const between = this.faces.filter((f) => Math.abs(f.up.dot(a.up)) < 0.5).map((f) => f.id).sort();
    return between[(bot.id + bot.trip) % between.length];
  }

  private laneBetween(a: FaceId, b: FaceId): LaneDef {
    return this.map.lanes.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))!;
  }

  /**
   * Road points from the bot to a node of the face's road graph (the first node is skipped if it lies behind) and a
   * crossing next to the start that is off the way (for a wrong turn).
   */
  private roads(loc: Ground, to: number): { pts: XZ[]; wrong?: XZ } {
    const nav = this.map.nav[loc.face];
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
  private route(bot: Bot, loc: Ground, d: Dest): Route {
    const memo = (key: string, make: () => Omit<Route, 'key'>): Route => (key === bot.routeKey && bot.route ? bot.route : { key, ...make() });
    const N = this.map.nav[loc.face];
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
          return memo(`enter:${here}:${k}`, () => ({ pts: [...this.roads(loc, nearestNode(N, doors[k].out)).pts, doors[k].out, doors[k].in], end: 'go' }));
        }
        if (wantHall) return this.inside(bot, loc, d, memo);
        if (loc.hall && d.kind === 'point') return this.exitHall(loc, d.pt, memo);
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
    const L = this.laneBetween(here, next);
    const exit = L.a === here ? L.nodeA : L.nodeB;
    // leave the hall by the door on the side of the exit (around the crystal's fort)
    if (loc.hall && N.hall) return this.exitHall(loc, N.nodes[exit], memo);
    const key = L.a === here ? `lane:${L.id}` : `land:${L.id}`;
    return memo(key, () => {
      const r = this.roads(loc, exit);
      return { pts: [...r.pts, ...(L.a === here ? L.pathA : L.pathB)], end: 'go', push: true, lane: L, strict: r.pts.length, wrong: r.wrong };
    });
  }

  /** Out of the hall by the door nearer to `e` (around the crystal's fort). */
  private exitHall(loc: Ground, e: XZ, memo: (key: string, make: () => Omit<Route, 'key'>) => Route): Route {
    const N = this.map.nav[loc.face];
    const [hx, hz] = N.hall!.c;
    const doors = N.doors!;
    const k = Math.hypot(e[0] - doors[0].out[0], e[1] - doors[0].out[1]) <= Math.hypot(e[0] - doors[1].out[0], e[1] - doors[1].out[1]) ? 0 : 1;
    const sz = k === 0 ? -1 : 1;
    return memo(`exit:${loc.face}:${k}`, () => ({ pts: [[hx + Math.sign(loc.x - hx || 1) * 4.5, hz + sz * 7], doors[k].in, doors[k].out], end: 'go' }));
  }

  /** Inside a hall: the crystal stand (raid), the guard posts / patrol (home), a point (the shop). */
  private inside(bot: Bot, loc: Ground, d: Dest, memo: (key: string, make: () => Omit<Route, 'key'>) => Route): Route {
    const N = this.map.nav[loc.face];
    const [hx, hz] = N.hall!.c;
    const stands = N.bedStands!;
    const stand = stands[bot.stand % stands.length];
    const patrol = () => memo(`patrol:${loc.face}:${bot.patrol}`, () => ({ pts: [N.patrol![bot.patrol % N.patrol!.length]], end: 'hold' }));
    if (d.kind === 'bed') {
      if (!this.match.bed(d.team).alive) return patrol();
      const off: XZ = [stand[0] - hx, stand[1] - hz];
      const len = Math.hypot(off[0], off[1]) || 1;
      // rockets at the fort first, from further back (the blast would hurt it at the stand)
      if (bot.rocketFort) return memo(`rocket:${d.team}:${bot.stand}`, () => ({ pts: [[hx + (off[0] / len) * 7.5, hz + (off[1] / len) * 7.5]], end: 'bed' }));
      // only fists: right up to the crystal
      if (!this.armed(bot, 1)) return memo(`bed:${d.team}:${bot.stand}:m`, () => ({ pts: [[hx + (off[0] / len) * 2.1, hz + (off[1] / len) * 2.1]], end: 'bed' }));
      // a gun: far enough to shoot over the fort at the top of the crystal, still within the 5 m of the rule
      return memo(`bed:${d.team}:${bot.stand}`, () => ({ pts: [[hx + (off[0] / len) * BED_STAND, hz + (off[1] / len) * BED_STAND]], end: 'bed' }));
    }
    if (d.kind === 'home') {
      if (bot.task.kind === 'defend') {
        const by = this.alarms.get(bot.team)?.by;
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

  /** On the way along a lane: lay its missing pieces near the bot, paying with its own wood; `ahead`: where it walks. */
  private bridge(bot: Bot, lane: LaneDef | undefined, dt: number, ahead: Vector3) {
    if (!lane) { bot.blocked = false; return; }
    bot.buildT -= dt;
    if (bot.buildT > 0) return;
    bot.buildT = 0.15;
    const pos = bot.sim.state.pos;
    const keys = this.builtKeys();
    const can = bot.eco.has('builder');
    let blocked = false;
    _v.copy(ahead).sub(pos);
    for (const p of this.lanePlans.get(lane.id)!) {
      const d2 = p.center.distanceToSquared(pos);
      if (d2 > 8 * 8 || keys.has(p.key)) continue;
      const front = d2 < 6.5 * 6.5 && _l.copy(p.center).sub(pos).dot(_v) > 0;
      if (!can || bot.kit.wood < 1) { if (front) blocked = true; continue; }
      const r = this.blocks.place(p, 'wood', bot.team, true);
      if (r === 'ok') { bot.kit.wood--; bot.built++; bot.builtAt = this.match.time; }
    }
    bot.blocked = blocked;
  }

  private findEnemy(bot: Bot, eye: Vector3, raiding: boolean): Target | null {
    let best: Target | null = null;
    let bestD = bot.tune.sightRange;
    const up = bot.target.up;
    const prey = bot.task.kind === 'hunt' ? bot.task.target : null;
    for (const t of this.combat.targets) {
      if (!t.alive || t.guard || t.team === bot.team) continue; // spawn protection: no point shooting
      const d = eye.distanceTo(t.center);
      // city NPCs: the hunted bandit and those who go for this bot (a bum walking past is left alone)
      if (t.npc) { if (t !== prey && t.aggro !== bot.id) continue; }
      // not on a raid: enemies on this face (no sniping at the walls of other faces) or close
      else if (!raiding && d > bot.tune.defendRadius && t.up.dot(up) < 0.9) continue;
      if (d > bestD || !this.combat.lineOfSight(eye, t.center)) continue;
      best = t;
      bestD = d;
    }
    // shot at by someone it does not see in its sector: turn to them
    if (!best && this.match.time - bot.hurtT < 2) {
      const a = this.combat.target(bot.hurtBy);
      if (a && a.alive && !a.guard && a.team !== bot.team && eye.distanceTo(a.center) < bot.tune.sightRange * 1.3
        && this.combat.lineOfSight(eye, a.center)) best = a;
    }
    return best;
  }

  /** One simulation tick for every bot. */
  tick(dt: number) {
    this.watch(dt);
    for (const bot of this.bots) {
      if (bot.out) continue;
      if (!bot.target.alive) {
        if (bot.respawnT <= 0) {
          bot.respawnT = bot.tune.respawnDelay;
          this.spill(bot, true);
          this.park(bot);
        }
        bot.respawnT -= dt;
        bot.status = 'мёртв';
        if (bot.respawnT <= 0) {
          if (this.match.bed(bot.team).alive) {
            this.placeAtSpawn(bot);
            if (bot.role === 'attack') bot.departAt = this.match.time + bot.tune.reattack;
          } else {
            bot.out = true;
            bot.status = 'выбыл';
          }
        }
        continue;
      }
      bot.prevPos.copy(bot.sim.state.pos);
      this.upkeep(bot, dt);
      const th = this.think(bot, dt);
      bot.sim.tick(th.input, dt);
      for (const e of bot.sim.events.splice(0)) {
        if (e.type === 'land') this.combat.fall(bot.target, e.speed);
        if (e.type === 'respawn' && e.reason === 'void') {
          this.spill(bot, false); // the void keeps what it carried
          bot.prevPos.copy(bot.sim.state.pos);
          if (this.match.bed(bot.team).alive) this.placeAtSpawn(bot);
          else {
            bot.target.alive = false;
            bot.respawnT = 0.01;
          }
        }
      }
      upOf(bot.sim.state.frame, bot.target.up);
      // an enemy right in its face: a kick shoves it away (and off a bridge, with luck)
      if (th.kick && kickReady(bot.weapons)) {
        const eye = bot.sim.state.pos.clone().addScaledVector(bot.target.up, EYE_OFFSET);
        kicked(bot.weapons, this.combat.kick(bot.id, eye, th.kick, bot.target.up) > 0);
        bot.kicksTotal++;
      }
      // semi-automatic guns fire on the press: release the trigger every other tick
      const pull = th.fire && (WEAPONS[bot.weapons.current].auto || !bot.weapons.held);
      const fired = weaponTick(bot.weapons, { fire: pull, reload: th.reload && !th.fire, select: th.select }, dt);
      if (fired && th.aim) {
        const eye = bot.sim.state.pos.clone().addScaledVector(bot.target.up, EYE_OFFSET);
        if (!bot.sim.state.onGround && WEAPONS[fired].airPush) bot.sim.applyImpulse(th.aim.clone().normalize().multiplyScalar(-WEAPONS[fired].airPush));
        this.combat.use(fired, bot.id, eye, th.aim, bot.sim.state.vel, bot.target.up.clone().negate());
        bot.shotsTotal++;
        if (fired === 'grenade') { bot.pick = null; bot.nadeT = 14; }
        if (++bot.shots >= bot.tune.burst) {
          bot.shots = 0;
          bot.pauseT = bot.tune.burstPause;
        }
      }
    }
  }

  /** Weapon for the moment: the one it picked (grenade, rocket), else by the distance; fists when out of ammo. */
  private arm(bot: Bot, d: number): WeaponId {
    const ws = bot.weapons;
    const ok = (w: WeaponId) => hasAmmo(ws, w);
    if (bot.pick && ok(bot.pick)) return bot.pick;
    // a drunk bum is not worth a bullet: fists and boots
    if (bot.enemy?.npc === 'bum') return 'fists';
    if (ok('shotgun') && (d < 8 || (ws.current === 'shotgun' && d < 11))) return 'shotgun';
    if (ok('rifle')) return 'rifle';
    if (ok('shotgun') && d < 16) return 'shotgun';
    if (ok('pistol')) return 'pistol';
    if (ok('shotgun')) return 'shotgun';
    return 'fists';
  }

  /** How far a weapon is worth using. */
  private range(bot: Bot, w: WeaponId) {
    if (w === 'fists') return WEAPONS.fists.reach;
    if (w === 'shotgun') return 22;
    if (w === 'grenade') return 24;
    return bot.tune.sightRange;
  }

  /** The first block between the near crystal stand and the crystal (what the rockets should clear). */
  private fortBlock(bot: Bot, loc: Ground, bed: Vector3) {
    const N = this.map.nav[loc.face];
    const [hx, hz] = N.hall!.c;
    const st = N.bedStands![bot.stand % N.bedStands!.length];
    const len = Math.hypot(st[0] - hx, st[1] - hz) || 1;
    const stand: XZ = [hx + ((st[0] - hx) / len) * BED_STAND, hz + ((st[1] - hz) / len) * BED_STAND];
    const eye = this.toWorld(loc, stand).addScaledVector(bot.target.up, EYE_OFFSET);
    const hit = this.match.firstHit(eye, bed.clone().addScaledVector(bot.target.up, BED_AIM), bot.sim.mover.collider);
    return hit ? this.blocks.byCollider(hit.collider.handle) ?? null : null;
  }

  private think(bot: Bot, dt: number): Thought {
    const sim = bot.sim;
    const s = sim.state;
    const ws = bot.weapons;
    const input = emptyInput();
    input.yaw = s.yaw;
    input.pitch = s.pitch;
    const up = upOf(s.frame, new Vector3());
    const eye = s.pos.clone().addScaledVector(up, EYE_OFFSET);
    const loc = this.locate(sim);

    // the plan: what to do now
    bot.taskT += dt;
    bot.planT -= dt;
    if (bot.planT <= 0 || bot.done) {
      bot.planT = 0.5;
      this.plan(bot, loc);
    }
    const raiding = bot.task.kind === 'raid';

    // perception
    bot.scanT -= dt;
    if (bot.scanT <= 0) {
      bot.scanT = 0.15;
      bot.enemy = this.findEnemy(bot, eye, raiding);
    }
    if (bot.enemy && !bot.enemy.alive) bot.enemy = null;
    const fresh = !!bot.enemy && bot.seenT === 0;
    bot.seenT = bot.enemy ? bot.seenT + dt : 0;
    bot.calmT = bot.enemy ? 0 : bot.calmT + dt;
    bot.pauseT = Math.max(0, bot.pauseT - dt);
    bot.pickT -= dt;
    if (bot.pickT <= 0) bot.pick = null;

    let aimAt: Vector3 | null = null;
    let wantFire = false;
    let reload = false;
    let label: string = TASK_LABEL[bot.task.kind];
    bot.fishing = false;
    let onLane = false;
    let atBed = false;
    let escape = false;
    /** Standing still on purpose (at the spot, waiting at a bridge end, shooting from the doorway). */
    let idle = false;
    let far = false;
    const wish = new Vector3();

    // lost: wedged on a ledge, or standing on something that is no known surface: hop, then give up and go home
    const lost = loc.kind === 'air' && (s.onGround || s.vel.lengthSq() < 0.36);
    bot.wedgeT = lost ? bot.wedgeT + dt : 0;
    if (bot.wedgeT > 0.5) bot.jumpT = 0.1;
    if (bot.wedgeT > 3) { bot.wedgeT = 0; this.placeAtSpawn(bot); }
    if (loc.kind === 'air') label = 'в полёте';
    else {
      const d = this.dest(bot);
      const r = this.route(bot, loc, d);
      if (r.key !== bot.routeKey) {
        bot.breach = null;
        bot.route = r;
        bot.routeKey = r.key;
        bot.routePts = r.pts.slice();
        bot.strictAt = r.strict;
        bot.wp = 0;
        bot.detour = null;
        bot.checkT = 0;
        bot.bestDist = Infinity;
        bot.progressT = 0;
        // a mistake: the wrong way at the first crossing (and back)
        if (r.wrong && this.rng.chance(bot.tune.mistakes * 0.35)) {
          bot.routePts.unshift(r.wrong);
          if (bot.strictAt !== undefined) bot.strictAt++;
        }
        // a mistake: opens fire at the crystal from the doorway, out of range
        if (r.key.startsWith('bed:') && this.rng.chance(bot.tune.mistakes)) bot.farT = this.rng.range(1.2, 2.6);
      }
      const pts = bot.routePts;
      const goalXZ = pts[Math.min(bot.wp, pts.length - 1)];
      // a long way to go on solid ground: run (the stamina rules are the player's)
      const endXZ = pts[pts.length - 1];
      far = r.lane === undefined && !loc.lane && Math.hypot(endXZ[0] - loc.x, endXZ[1] - loc.z) + (pts.length - 1 - bot.wp) * 10 > 14;
      const goal = this.toWorld(loc, goalXZ);
      const strictFrom = bot.strictAt;
      // on a lane: follow the line between its points (a point 2 m ahead on it), not a cut from where the bot stands
      // (a cut runs along the next face's wall, and touching that wall turns the gravity)
      let carrot: XZ | null = null;
      if (strictFrom !== undefined && bot.wp > strictFrom && bot.wp < pts.length) {
        const a = pts[bot.wp - 1], b = pts[bot.wp];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
        const k = Math.max(0, Math.min(1, ((loc.x - a[0]) * dx + (loc.z - a[1]) * dz) / (len * len) + 2 / len));
        carrot = [a[0] + dx * k, a[1] + dz * k];
      }
      const planar = (p: Vector3) => { _v.copy(p).sub(s.pos); return _v.addScaledVector(up, -_v.dot(up)); };
      const dist = planar(goal).length();
      const last = bot.wp >= pts.length - 1;
      const strict = strictFrom !== undefined && bot.wp >= strictFrom;
      onLane = strict || !!loc.lane;
      const advance = !last && dist < (strict ? 0.5 : 0.9);
      if (advance) bot.wp++;
      // reached the end of a 'go' route but nothing happened (the gravity did not turn): re-plan
      if (last && r.end === 'go' && dist < 0.6) bot.routeKey = '';
      const arrived = last && r.end !== 'go' && dist < (r.arrive ?? 0.6);
      atBed = arrived && r.end === 'bed';
      idle = arrived;

      // local planner: if the straight line is blocked, pick a detour point that sees both ends
      const push = !!r.push && last;
      bot.checkT -= dt;
      if (push || strict) bot.detour = null;
      else if (!arrived && bot.checkT <= 0) {
        bot.checkT = 0.5;
        if (bot.detour) {
          const dp = this.toWorld(loc, bot.detour);
          if (planar(dp).length() < 0.9 || this.clear(sim, s.pos, goal)) bot.detour = null;
        } else if (!this.clear(sim, s.pos, goal)) bot.detour = this.findDetour(bot, loc, goal);
      }
      const steerTo = bot.detour ? this.toWorld(loc, bot.detour) : carrot ? this.toWorld(loc, carrot) : goal;
      if (!arrived) wish.copy(planar(steerTo)).normalize();
      this.bridge(bot, r.lane, dt, steerTo);
      // out of wood on a bridge: stop at the edge, then go back for more (or try another way)
      let still = false;
      if (r.lane && bot.blocked) {
        wish.set(0, 0, 0);
        still = true;
        bot.strandT += dt;
        label = 'нет дерева';
        if (bot.strandT > 2) this.stranded(bot, loc);
      } else bot.strandT = 0;
      if (r.lane && !still && this.match.time - bot.builtAt < 1) label = 'строит мост';

      // the task's own business on the spot
      const a = this.act(bot, arrived, dt);
      if (a?.aim) { aimAt = a.aim; wantFire = !!a.fire; }
      if (a?.label) label = a.label;

      if (r.end === 'bed') {
        const bed = this.match.bed(this.raidGoal(bot));
        // a mistake: shooting the crystal from the doorway (out of range: wasted)
        if (bed.alive && !arrived && bot.farT > 0 && loc.hall) {
          bot.farT -= dt;
          if (!this.match.firstHit(eye, bed.pos, sim.mover.collider)) {
            aimAt = bed.pos.clone();
            wantFire = true;
            wish.set(0, 0, 0);
            still = true;
            label = 'стреляет по кристаллу издалека';
          }
        }
        if (bed.alive && arrived) {
          label = 'ломает кристалл';
          if (bot.rocketFort) {
            const blk = this.fortBlock(bot, loc, bed.pos);
            if (!blk || !hasAmmo(ws, 'rocket') || bot.target.hp < 30) bot.rocketFort = false;
            else {
              aimAt = blk.center.clone();
              wantFire = true;
              bot.pick = 'rocket';
              bot.pickT = 0.3;
              label = 'ракетой по укреплению';
            }
          } else {
            // a gun: at the top of the crystal over the fort; fists: anywhere
            const top = bed.pos.clone().addScaledVector(bed.up, this.armed(bot, 1) ? BED_AIM : 0);
            const hit = this.match.firstHit(eye, top, sim.mover.collider);
            if (!hit) {
              // shoot it from the stand (within the 5 m of the rule)
              aimAt = top;
              wantFire = true;
            } else {
              const block = this.blocks.byCollider(hit.collider.handle);
              const dir = top.clone().sub(eye).normalize();
              if (block && hasAmmo(ws, 'rocket') && bot.target.hp > 40) bot.rocketFort = true;
              else if (block) {
                aimAt = eye.clone().addScaledVector(dir, hit.timeOfImpact + 0.1);
                wantFire = true;
                label = 'ломает укрепление';
              } else {
                bot.standT += dt;
                if (bot.standT > 2) { bot.standT = 0; bot.stand++; }
              }
            }
          }
        }
      }

      if (still) idle = true;
      // stuck: jump, then give up the task (a spot it cannot reach) or, at worst, go home
      const d2 = planar(carrot && !bot.detour ? goal : steerTo).length();
      if (still || arrived) bot.progressT = 0;
      else if (d2 < bot.bestDist - 0.25) { bot.bestDist = d2; bot.progressT = 0; }
      else bot.progressT += dt;
      // a new point: progress is measured afresh (or the bot would think it is stuck and jump / skip points)
      if (advance) { bot.bestDist = Infinity; bot.progressT = 0; }
      if (bot.progressT > 1.2) {
        bot.jumpT = 0.25; bot.bestDist = d2; bot.progressT = 0; bot.stuckT += 1.2; bot.detour = null; bot.checkT = 0;
        // an intermediate point may sit inside something (a parked car): skip it
        if (!last && !strict && bot.stuckT > 2) { bot.wp++; bot.bestDist = Infinity; }
      }
      if (arrived || bot.progressT === 0) bot.stuckT = Math.max(0, bot.stuckT - dt * 0.5);
      if (d.kind === 'point' && bot.stuckT > 8) {
        bot.avoid.set(d.key, this.match.time + 60);
        bot.stuckT = 0;
        this.finish(bot);
      }
      if (bot.stuckT > bot.tune.giveUp) { bot.stuckT = 0; this.placeAtSpawn(bot); }
      // stuck behind blocks (someone's wall, a fort): shoot through them (fists only get through wood)
      if (!arrived && bot.stuckT > 3 && bot.breach === null) {
        bot.breach = this.blockInTheWay(sim, steerTo);
        bot.breachT = 0;
        const b = bot.breach !== null ? this.blocks.byCollider(bot.breach) : null;
        if (b && b.material !== 'wood' && !this.armed(bot, 1) && !hasAmmo(ws, 'rocket')) bot.breach = null;
      }
      if (bot.breach !== null) {
        const block = this.blocks.byCollider(bot.breach);
        bot.breachT += dt;
        if (!block) { bot.breach = null; bot.stuckT = 0; }
        else if (arrived || bot.breachT > 25) {
          // there after all, or the wall will not give: drop it (the stuck rules take over)
          bot.breach = null;
          if (!arrived) bot.stuckT = bot.tune.giveUp;
        } else {
          aimAt = block.center.clone();
          wantFire = true;
          if (hasAmmo(ws, 'rocket') && block.center.distanceTo(eye) > 4) { bot.pick = 'rocket'; bot.pickT = 0.3; }
          label = 'пробивает стену';
        }
      }

      if (r.end === 'hold' && arrived) {
        bot.patrolT += dt;
        if (bot.patrolT > 5) { bot.patrolT = 0; bot.patrol++; bot.stand++; }
      }
    }

    // fell into a pond basin (a pit): jump out towards the nearest side, steering in the air too
    const pf = this.faceOfUp(up);
    if (pf) {
      const l = _l.copy(s.pos).sub(pf.origin).applyQuaternion(pf.inv);
      const pit = l.y < 0.6 ? this.wet(pf.id, l.x, l.z, 0) : null;
      if (pit) {
        const ex = l.x - pit.c[0], ez = l.z - pit.c[1];
        const out = pit.h[0] - Math.abs(ex) < pit.h[1] - Math.abs(ez)
          ? new Vector3(pit.c[0] + Math.sign(ex || 1) * (pit.h[0] + 1.2), l.y, l.z) : new Vector3(l.x, l.y, pit.c[1] + Math.sign(ez || 1) * (pit.h[1] + 1.2));
        wish.copy(out.applyQuaternion(pf.q).add(pf.origin)).sub(s.pos);
        wish.addScaledVector(up, -wish.dot(up)).normalize();
        if (s.onGround) bot.jumpT = 0.45;
        escape = true;
        bot.progressT = 0;
        label = 'вылезает из пруда';
      }
    }

    // wedged (on top of a post, between props): no speed although it should be going somewhere. Hop off in a random
    // direction (steering in the air), then give up and go home
    // (measured along the ground: hopping up and down on the spot is no progress)
    _v.copy(s.pos).sub(bot.anchor);
    if (_v.addScaledVector(up, -_v.dot(up)).lengthSq() > 1 || idle || bot.hesitateT > 0 || (bot.enemy && bot.seenT > bot.tune.reaction)) {
      bot.anchor.copy(s.pos);
      bot.frozenT = 0;
    } else if (!escape) bot.frozenT += dt;
    if (bot.frozenT > 2 && bot.nudgeT <= -0.6) {
      const a = this.rng.range(0, Math.PI * 2);
      moveBasis(s.frame, a, _fwd, _right);
      bot.nudge.copy(_fwd);
      bot.nudgeT = 0.7;
      bot.jumpT = 0.12;
    }
    if (bot.frozenT > 7) { bot.frozenT = 0; this.placeAtSpawn(bot); }
    bot.nudgeT -= dt;
    if (bot.nudgeT > 0) {
      wish.copy(bot.nudge);
      escape = true;
    }

    // a mistake: stops for a moment and looks around
    bot.mistakeT -= dt;
    if (bot.mistakeT <= 0) {
      bot.mistakeT = this.rng.range(10, 25);
      if (!bot.enemy && !onLane && loc.kind === 'face' && this.rng.chance(bot.tune.mistakes)) bot.hesitateT = this.rng.range(0.7, 2);
    }
    if (bot.hesitateT > 0) {
      bot.hesitateT -= dt;
      bot.progressT = 0;
      if (!bot.enemy) {
        wish.set(0, 0, 0);
        input.yaw = s.yaw + dt * 1.8;
        label = 'замешкался';
      }
    }

    // combat overrides the view: shoot the enemy while still walking the route
    let kick: Vector3 | null = null;
    let aimDir: Vector3 | null = null;
    const e = bot.enemy;
    const ed = e ? eye.distanceTo(e.center) : Infinity;
    if (e && bot.seenT > bot.tune.reaction) {
      // a grenade now and then at a fighter at mid range; rockets at fighters in the open
      if (!e.npc && bot.nadeT <= 0 && ws.ammo.grenade > 0 && ed > 7 && ed < 20) {
        bot.nadeT = 5;
        if (this.rng.chance(0.4)) { bot.pick = 'grenade'; bot.pickT = 0.9; }
      }
      if (!e.npc && !bot.pick && bot.rocketT <= 0 && hasAmmo(ws, 'rocket') && ed > 6 && ed < 24) {
        bot.rocketT = 4;
        if (this.rng.chance(0.5)) { bot.pick = 'rocket'; bot.pickT = 1.2; }
      }
      const w = this.arm(bot, ed);
      if (ed < this.range(bot, w) + 0.3) {
        aimAt = e.center.clone().addScaledVector(e.up, 0.25);
        if (w === 'grenade') aimDir = lob(eye, aimAt, up, WEAPONS.grenade.speed, DEFAULT_MOVEMENT.gravity * WEAPONS.grenade.gravityScale);
        else {
          // slow bullets: aim ahead of a moving target by the flight time (as well as this bot can judge it)
          const speed = WEAPONS[w].speed;
          if (speed > 0 && e.vel) aimAt.addScaledVector(e.vel, (ed / speed) * bot.tune.lead);
        }
        wantFire = true;
        if (ed < KICK.reach + 0.3) kick = e.center.clone().sub(eye).normalize();
        // close-range weapons: go at them (not on a bridge, not at the crystal)
        if ((w === 'fists' || w === 'shotgun') && ed > 1.4 && ed < 14 && loc.kind === 'face' && !onLane && !atBed) {
          wish.copy(e.center).sub(s.pos);
          wish.addScaledVector(up, -wish.dot(up)).normalize();
        }
        label = e.npc ? 'дерётся с бандитом' : 'в бою';
      }
      // a mistake: reloads a half-full magazine as the fight starts
      if (fresh && isGun(ws.current) && ws.ammo[ws.current] < WEAPONS[ws.current].mag && this.rng.chance(bot.tune.mistakes * 0.5)) reload = true;
    } else if (bot.calmT > 2 && isGun(ws.current) && ws.ammo[ws.current] < WEAPONS[ws.current].mag * 0.6 && ws.reserve[ws.current] > 0) reload = true;

    let aim: Vector3 | null = null;
    if (aimAt) {
      const dir = aimDir ?? aimAt.sub(eye).normalize();
      [input.yaw, input.pitch] = this.look(sim, dir);
      aim = dir.clone().add(new Vector3(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)).multiplyScalar(bot.tune.spread)).normalize();
    } else if (wish.lengthSq() > 0.01) {
      [input.yaw] = this.look(sim, wish);
      input.pitch = 0;
    }
    // movement relative to the view; none in the air (air strafing would bend geyser / drop trajectories)
    moveBasis(s.frame, input.yaw, _fwd, _right);
    if (!s.onGround && !escape) { /* ballistic */ } else if (wish.lengthSq() > 0.01) {
      input.forward = wish.dot(_fwd);
      input.right = wish.dot(_right);
      input.sprint = far && !aimAt && input.forward > 0.7;
    } else if (bot.enemy && bot.seenT > bot.tune.reaction) {
      input.right = Math.sin(this.match.time * 2.3 + bot.id) > 0 ? 1 : -1; // strafe while holding a position
    }
    if (bot.jumpT > 0) { input.jump = true; bot.jumpT -= dt; }
    bot.status = label;
    return { input, fire: wantFire && bot.pauseT <= 0, aim, kick, reload, select: this.arm(bot, ed) };
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
        if (this.wet(loc.face, c[0], c[1], 0.8) || !this.standable(bot.sim, w) || !this.clear(bot.sim, s.pos, w)) continue;
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

function sameTask(a: Task, b: Task) {
  switch (a.kind) {
    case 'gather': return b.kind === a.kind && b.item === a.item;
    case 'fish': return b.kind === a.kind && b.pond === a.pond && b.stand === a.stand;
    case 'hunt': return b.kind === a.kind && b.target === a.target;
    case 'shop': return b.kind === a.kind && b.shop === a.shop;
    case 'crystals': return b.kind === a.kind && b.gen === a.gen;
    default: return b.kind === a.kind;
  }
}

/** Distance from (x, z) to a polyline. */
function polyDist(pts: XZ[], x: number, z: number) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, segDist(pts[i], pts[i + 1], x, z));
  return best;
}

function segDist(a: XZ, b: XZ, x: number, z: number) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const k = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - a[0] - dx * k, z - a[1] - dz * k);
}

/**
 * The rest of a polyline from the point nearest to (x, z) on: starts with the segment's start when near it, otherwise
 * with a point on the segment just ahead (back onto the line first, then along it).
 */
function rest(pts: XZ[], x: number, z: number): XZ[] {
  let seg = 0, best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = segDist(pts[i], pts[i + 1], x, z);
    if (d < best) { best = d; seg = i; }
  }
  const a = pts[seg], b = pts[seg + 1];
  const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
  const along = ((x - a[0]) * dx + (z - a[1]) * dz) / len;
  if (along < 1.5) return pts.slice(seg);
  if (along > len - 2.5) return pts.slice(seg + 1);
  const k = (along + 1.5) / len;
  return [[a[0] + dx * k, a[1] + dz * k], ...pts.slice(seg + 1)];
}

/** Throw direction for a lob from `from` to `to` (low arc) at `speed` under gravity `g` along -`up`. */
function lob(from: Vector3, to: Vector3, up: Vector3, speed: number, g: number): Vector3 {
  const d = to.clone().sub(from);
  const h = d.dot(up);
  const flat = d.addScaledVector(up, -h);
  const x = flat.length() || 1;
  flat.divideScalar(x);
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * x * x + 2 * h * v2);
  const th = disc > 0 ? Math.atan2(v2 - Math.sqrt(disc), g * x) : Math.PI / 4;
  return flat.multiplyScalar(Math.cos(th)).addScaledVector(up, Math.sin(th));
}
