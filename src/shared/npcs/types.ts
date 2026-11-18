import { Quaternion, Vector3 } from 'three';
import type { Target } from '../combat';
import type { FaceNav, XZ } from '../map';
import type { PlayerSim } from '../sim';
import type { WeaponState } from '../weapons';

export type NpcKind = 'bum' | 'gang';

/** Tuning. Times in seconds, distances in metres, speeds as a share of the player's run speed. */
export const NPC = {
  bumsPerIsland: 5,
  gangSize: 3,
  carsPerIsland: 2,
  bum: {
    hp: 60,
    walk: 0.4,
    run: 0.85,
    sight: 11,
    /** Full view cone, degrees. */
    fov: 140,
    /** Seconds between drinks (random in range) and the drink itself. */
    drinkEvery: [16, 32] as [number, number],
    drinkTime: 5,
    /** Chance to go for a noticed stranger within `picky` m; otherwise leaves them alone for `grudge` s. */
    temper: 0.55,
    picky: 5,
    /** Chance that two bums meeting within 3 m start a fight. */
    brawl: 0.12,
    grudge: 30,
    /** Gives up the fight beyond this distance / after this long. */
    chase: 14,
    giveUp: 14,
    respawn: 35,
    bottleDrop: 0.4,
    /** Pocket change: 0–2 $ (often nothing). */
    cash: [0, 2] as [number, number],
  },
  gang: {
    hp: 75,
    walk: 0.42,
    run: 0.92,
    sight: 22,
    fov: 110,
    /** Delay between seeing the foe and the first shot. */
    reaction: 0.45,
    /**
     * Telegraphed bursts: the bandit stops and raises the gun for `windup` s (a click, a glint at the muzzle, a red
     * mark); the aim follows the foe until `lock` s before the burst, then freezes on that spot. Standing still you
     * are hit, a step aside and the burst goes past.
     */
    windup: 0.75,
    lock: 0.36,
    spread: 0.03,
    burst: 3,
    burstPause: 1.4,
    /** Grenades per life, thrown every `grenadeEvery` s at most, at a foe `grenadeRange` m away; `grenadeWindup` s
     * of a swing before the throw. Behind cover (not seen for a moment) the foe gets a high lob over it. */
    grenades: 2,
    grenadeEvery: [10, 16] as [number, number],
    grenadeRange: [7, 20] as [number, number],
    grenadeWindup: 0.65,
    /** A thrown grenade goes off this long after it lands (it is cooked for the rest of the fuse). */
    grenadeAfter: 1.0,
    /** Chance to pick a grenade instead of a burst when one is ready and the foe is in the open. */
    grenadeChance: 0.35,
    /** Will not follow further than this from home. */
    leash: 35,
    /** Without seeing the foe this long: search the last seen spot, then go home. */
    forget: 5,
    search: 6,
    respawn: 60,
    loot: [4, 9] as [number, number],
    /** Keep this distance in a fight (closer: stand and shoot, further: walk up). */
    range: 12,
    /** Bandit melee dash attack: spark windup (0.5 s) → frontal dash strike → 0.25 s recovery stand. */
    meleeChance: 0.4,
    meleeRange: 5.5,
    meleeWindup: 0.5,
    meleeRecover: 0.25,
    meleeRadius: 2.6,
    meleeDamage: 18,
    meleeKnockback: 9.5,
  },
  notice: {
    /** Suspicion per second at point blank, in the cone, target running. Hostile at 1. */
    rate: 1.4,
    decay: 0.22,
    /** Felt within this distance regardless of the view cone. */
    close: 2.2,
    /** Running footsteps are heard within this distance. */
    steps: 7,
    /** Visibility by how the target moves: running / quiet walk / standing. */
    run: 1,
    walk: 0.5,
    still: 0.35,
    /** Above this planar speed footsteps are loud (a quiet walk is ~3.4 m/s). */
    loud: 4.5,
    /** A crouched figure is harder to make out. */
    crouch: 0.6,
  },
  /** NPCs nobody is near are simulated this many times slower (bums still drink, bottles still drop). */
  idleStep: 8,
  /** "Near": a player or bot within this many metres. */
  liveRange: 40,
};

export type NpcState = 'wander' | 'drink' | 'fight' | 'patrol' | 'search' | 'combat' | 'dead';

export interface Npc {
  id: number;
  kind: NpcKind;
  /** Face id (map.faces). */
  island: string;
  /** Gang index on its island (bums: -1). */
  slot: number;
  sim: PlayerSim;
  target: Target;
  weapons: WeaponState;
  state: NpcState;
  stateT: number;
  /** Route along the road graph (island-local XZ) and progress. */
  route: XZ[];
  wp: number;
  /** Who it is fighting. */
  foe: Target | null;
  /** Suspicion (0..1+) per target id. */
  suspicion: Map<number, number>;
  /** Do not pick on these targets until the given time. */
  grudge: Map<number, number>;
  lastSeen: Vector3 | null;
  /** Time since the foe was last seen. */
  lostT: number;
  /** Time the foe has been in view (reaction). */
  seenT: number;
  /** Where to look / go when searching. */
  searchAt: Vector3 | null;
  /** Point to turn the head to (heard something), until `lookUntil`. */
  lookAt: Vector3 | null;
  lookUntil: number;
  drinkAt: number;
  respawnT: number;
  scanT: number;
  shots: number;
  shotsTotal: number;
  pauseT: number;
  /** Gang fire cycle: free (moving, choosing), windup (raising the gun), burst (firing at the locked spot), meleeWindup (0.5s spark), meleeRecover (0.25s pause). */
  fire: 'free' | 'windup' | 'burst' | 'meleeWindup' | 'meleeRecover';
  /** Windup time left (burst, grenade, or melee). */
  windT: number;
  /** Cooldown before next melee dash attack. */
  meleeT: number;
  /** Where the burst goes (followed, then locked) / where the grenade is thrown. */
  aimAt: Vector3;
  /** Winding up a grenade throw (instead of a burst); `lob`: the high arc over cover. */
  throwing: boolean;
  lob: boolean;
  grenades: number;
  grenadeT: number;
  throwsTotal: number;
  progressT: number;
  bestDist: number;
  /** Stuck events since the last reached waypoint. */
  stuckN: number;
  jumpT: number;
  patrol: number;
  prevPos: Vector3;
  status: string;
}

export interface Island {
  id: string;
  up: Vector3;
  q: Quaternion;
  /** Ground centre. */
  origin: Vector3;
  half: number;
  nav: FaceNav;
  /** Nodes where NPCs may stand (not at the hall / the square, not at the rim). */
  street: number[];
  /** Road nodes closest to the border of the island where NPC cars spawn. */
  borderNodes: number[];
  gangHome: number;
  gangPatrol: number[];
  /** Somebody (player / bot) is on the streets: full-rate simulation. */
  busy: boolean;
}

export interface NpcCar {
  id: number;
  island: string;
  pos: Vector3;
  prevPos: Vector3;
  vel: Vector3;
  up: Vector3;
  quat: Quaternion;
  yaw: number;
  scale: number;
  color: number;
  target: Target;
  state: 'drive' | 'crashing' | 'vanishing' | 'dead';
  currNode: number;
  nextNode: number;
  crashGoal: Vector3 | null;
  crashT: number;
  /** Magical vanish timer (counts down from 1.1 -> 0 before disappearing). */
  vanishT: number;
  respawnT: number;
  /** Player/bot chosen as ram/explosion target (either attacker or random nearby player). */
  attackerId: number | null;
  /** Remaining time the car flees at high speed after being attacked. */
  fleeT: number;
  /** Number of road segments left before the car magically vanishes at an island border node. */
  stepsLeft: number;
}

/** For the client: telegraphs (sound) and throws. */
export type NpcEvent =
  | { type: 'windup'; id: number; pos: Vector3; grenade: boolean }
  | { type: 'throw'; id: number; pos: Vector3 }
  | { type: 'meleeSpark'; id: number; pos: Vector3 }
  | { type: 'meleeStrike'; id: number; pos: Vector3; dir: Vector3 }
  | { type: 'carExplode'; id: number; pos: Vector3 }
  | { type: 'carAlarm'; id: number; pos: Vector3 }
  | { type: 'carVanish'; id: number; pos: Vector3 };

const _inv = new Quaternion();
const _local = new Vector3();

/** Island-local XZ at street level → world (capsule centre height). */
export function toWorld(isl: Island, p: XZ, out = new Vector3()) {
  return out.set(p[0], 0.95, p[1]).applyQuaternion(isl.q).add(isl.origin);
}

/** World → island-local (x, height, z). */
export function toLocal(isl: Island, p: Vector3, out = new Vector3()) {
  return out.copy(p).sub(isl.origin).applyQuaternion(_inv.copy(isl.q).invert());
}

/** Is a world point on this island's street level (not the roof, not another island)? */
export function onStreets(isl: Island, p: Vector3) {
  const l = toLocal(isl, p, _local);
  return l.y > -3 && l.y < 20 && Math.max(Math.abs(l.x), Math.abs(l.z)) < isl.half + 4;
}

/**
 * Launch direction to hit `to` from `from` at speed `v` under gravity `g` along -up (no drag): the low (fast) or the
 * high (lob) solution. Null if it is out of reach.
 */
export function lobDirection(from: Vector3, to: Vector3, up: Vector3, v: number, g: number, high: boolean): Vector3 | null {
  const rel = to.clone().sub(from);
  const y = rel.dot(up);
  const flat = rel.addScaledVector(up, -y);
  const x = flat.length();
  if (x < 0.5) return up.clone();
  const disc = v ** 4 - g * (g * x * x + 2 * y * v * v);
  if (disc < 0) return null;
  const tan = (v * v + (high ? 1 : -1) * Math.sqrt(disc)) / (g * x);
  const a = Math.atan(tan);
  return flat.divideScalar(x).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
}
