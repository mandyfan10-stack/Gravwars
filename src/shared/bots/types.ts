import { Quaternion, Vector3 } from 'three';
import { BlockMaterial, BlockSystem, PiecePlan } from '../blocks';
import { Combat, MAX_HP, Target } from '../combat';
import { Currency, Economy, Pickup, Pickups } from '../economy';
import { FISHING } from '../fishing';
import { FaceId, FaceNav, LaneDef, MapData } from '../map';
import { Match, RESPAWN_DELAY } from '../match';
import { Rng } from '../math';
import { MoveInput } from '../movement';
import type { PhysicsWorld, Rapier } from '../physics';
import { PlayerSim } from '../sim';
import { TeamId } from '../teams';
import { WeaponId, WeaponState } from '../weapons';

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
  respawnDelay: RESPAWN_DELAY,
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
    firstAttack: 40, attackStagger: 18, reattack: 15, targetPlayerChance: 0.7, respawnDelay: 7,
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

export type XZ = [number, number];
/**
 * Where a bot stands: on a face of the cube (`hall` = inside its team hall, `roof` = on the hall roof; `lane` = on
 * the bridge of one of this face's lanes, beyond its rim), or in the air (no steering then). x / z / h are in the
 * face's frame.
 */
export type Loc =
  | { kind: 'face'; face: FaceId; x: number; z: number; h: number; hall: boolean; roof: boolean; lane: LaneDef | null }
  | { kind: 'air' };
export type Ground = Exclude<Loc, { kind: 'air' }>;

export interface FaceInfo {
  id: FaceId;
  team: string | null;
  up: Vector3;
  q: Quaternion;
  inv: Quaternion;
  origin: Vector3;
  half: number;
  nav: FaceNav;
}

/**
 * A route on the current face: face-local XZ points and what to do at the end (`act` / `hold` / `bed`: stop there;
 * `go`: walk on, the gravity turns). `strict`: points from this index on are a bridge lane: never skipped when stuck,
 * no detours (a detour off a lane is a fall into the void). `arrive`: how close counts as there. `wrong`: a crossing
 * off the way (a wrong turn, when the bot makes that mistake).
 */
export interface Route {
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
export type Dest =
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
  /** Character: prefers the shotgun, revolver, earns with a rod, makes crystal runs. */
  likes: { shotgun: boolean; revolver?: boolean; fish: boolean; crystals: boolean };
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
  /** Skirmish timer for base hall wood regeneration (1 block / s). */
  woodRegenT: number;
  /** A weapon it means to use for a moment (a grenade throw, rockets at a fort) and for how long. */
  pick: WeaponId | null;
  pickT: number;
  /** Who hurt it last (target id) and when (match time). */
  hurtBy: number;
  hurtT: number;
  /** Last known position of a lost or teammate-spotted enemy and search timer (s). */
  searchPos: Vector3 | null;
  searchT: number;
  /** Spots it gave up on (pickups, ponds, generators): key → until match time. */
  avoid: Map<string, number>;
  /** Learned failure count per lane / face so the bot avoids dangerous routes it failed on before. */
  laneFailures: Map<string, number>;
  /** Whether this bot will hit the active reload green zone on its current reload. */
  tryActiveReload: boolean;
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

export interface ShopSpot { face: FaceId; team: string; xz: XZ; hall: boolean }
/** A pond: the water, the sides to fish from, and its sunken basin (face-local centre / half size, rim included). */
export interface PondSpot { face: FaceId; water: Vector3; stands: XZ[]; c: XZ; h: XZ }
export interface GenSpot { face: FaceId; xz: XZ }
export interface FortCell { pos: Vector3; material: BlockMaterial }
export interface Alarm { until: number; by: Target | null; serial: number }
export interface TeamIntel { target: Target; pos: Vector3; face: FaceId | null; time: number; by: number }
export interface Thought { input: MoveInput; fire: boolean; aim: Vector3 | null; kick: Vector3 | null; reload: boolean; select: WeaponId }

export const GUNS = ['rifle', 'crossbow', 'revolver', 'shotgun', 'pistol', 'rocket'] as const;
/**
 * Where a raider with a gun stands, m from the crystal axis: the line from its eye to the top of the crystal clears
 * the 3-block fort (top 3 m up, ring out to 2.5 m), and the eye is still within CRYSTAL.range of the axis.
 */
export const BED_STAND = 4.6;
/** It aims this far above the crystal's centre (over the fort). */
export const BED_AIM = 1;
/** Seconds of one fishing round: cast, wait for the bite, strike, pause. */
export const fishRound = (rng: Rng) => FISHING.castTime + rng.range(FISHING.waitMin, FISHING.waitMax) + FISHING.biteTime * 0.55 + FISHING.after;

/** Shared mutable world/bot state accessed across bot sub-modules. */
export interface BotCtx {
  readonly R: Rapier;
  readonly world: PhysicsWorld;
  readonly map: MapData;
  readonly combat: Combat;
  readonly match: Match;
  readonly blocks: BlockSystem;
  readonly playerTeam: TeamId;
  readonly rng: Rng;
  readonly faces: FaceInfo[];
  readonly lanePlans: Map<string, PiecePlan[]>;
  readonly teams: TeamId[];
  readonly bots: Bot[];
  readonly byId: Map<number, Bot>;
  readonly shops: ShopSpot[];
  readonly ponds: PondSpot[];
  readonly gens: GenSpot[];
  readonly forts: Map<TeamId, FortCell[]>;
  readonly alarms: Map<TeamId, Alarm>;
  readonly teamIntel: Map<TeamId, TeamIntel>;
  readonly keys: { version: number; set: Set<string> };
  readonly gaps: Map<TeamId, { t: number; cells: FortCell[] }>;
  loot: Pickups | null;
  placeAtSpawn: (bot: Bot) => void;
  reportTarget: (team: TeamId, target: Target, by?: number) => void;
}

/** Raider: goes for enemy crystals (attackers, a defender who joined a squad, everybody once the own crystal is gone). */
export function isRaider(bot: Bot, match: Match): boolean {
  return bot.role === 'attack' || bot.joined || !match.bed(bot.team).alive;
}

/** Has a gun with at least this many rounds (a shotgun / crossbow counts with fewer: 12). */
export function isArmed(bot: Bot, rounds: number): boolean {
  const ws = bot.weapons;
  return GUNS.some((w) => ws.owned[w] && ws.ammo[w] + ws.reserve[w] >= (w === 'shotgun' || w === 'crossbow' ? Math.min(rounds, 12) : rounds));
}

/** Material for a fort block: the one the cell had, else whatever it carries (null = nothing). */
export function pickMaterial(bot: Bot, want: BlockMaterial): BlockMaterial | null {
  for (const m of [want, 'stone', 'metal', 'wood'] as BlockMaterial[]) if (bot.kit[m] > 0) return m;
  return null;
}

export function sameTask(a: Task, b: Task): boolean {
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
export function polyDist(pts: XZ[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, segDist(pts[i], pts[i + 1], x, z));
  return best;
}

export function segDist(a: XZ, b: XZ, x: number, z: number): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const k = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x - a[0] - dx * k, z - a[1] - dz * k);
}

/**
 * The rest of a polyline from the point nearest to (x, z) on: starts with the segment's start when near it, otherwise
 * with a point on the segment just ahead (back onto the line first, then along it).
 */
export function rest(pts: XZ[], x: number, z: number): XZ[] {
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
export function lob(from: Vector3, to: Vector3, up: Vector3, speed: number, g: number): Vector3 {
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

export { MAX_HP };
