import type { Vector3 } from 'three';
import type { TeamId } from './teams';
import { PENETRATION, WeaponId } from './weapons';

/**
 * Faction of a target: a team, or an NPC side. Projectiles and punches never hurt their own faction, so every bum
 * gets a faction of its own (they fight each other) while a gang shares one.
 */
export type Faction = TeamId | `bum:${number}` | `gang:${string}` | `car:${number}`;

/** Anything that can be shot: a capsule standing along `up`. */
export interface Target {
  id: number;
  team: Faction;
  /** NPCs (bums, gangs, cars): not part of any team, ignored by team bots unless they attack them. */
  npc?: 'bum' | 'gang' | 'car';
  /** Custom hit radius (e.g. for NPC cars); defaults to PLAYER_RADIUS. */
  radius?: number;
  /** True when the target is currently airborne (increases bullet knockback). */
  airborne?: () => boolean;
  /** NPC only: id of the target it is fighting right now. */
  aggro?: number | null;
  /** Velocity (footstep noise for NPC hearing / sight). */
  vel?: Vector3;
  /** Quiet walk (Shift) / crouch: no footsteps. */
  quiet?: boolean;
  /** Crouching: NPCs make it out more slowly. */
  crouched?: boolean;
  /** Took damage from `owner` (NPCs react to being hit). */
  onHit?: (owner: number, damage: number) => void;
  center: Vector3;
  up: Vector3;
  hp: number;
  alive: boolean;
  /** Seconds until an auto-respawn (dummies). < 0 = handled by the owner (players). */
  respawnIn: number;
  onImpulse?: (v: Vector3) => void;
  /** Spawn protection: no damage until it runs out, the owner fires or walks `SPAWN_GUARD.radius` away. */
  guard?: { from: Vector3; t: number } | null;
  /** Stunned (hit by a bottle): NPCs stand dazed and do nothing for this many seconds. */
  stun?: number;
  /** Fighters (players, bots) heal REGEN.rate HP/s once nobody has hurt them for REGEN.delay s. */
  regen?: boolean;
  /** Seconds since the last damage taken (regen). */
  calm?: number;
  /** True for human players (allows shooting ambient cars in multiplayer too). */
  isHuman?: boolean;
  /** Custom maximum HP when lobby playerHp multiplier is active. */
  maxHp?: number;
  /** Armor vest: prevents lethal damage once, breaks and restores 50 HP immediately. */
  armor?: boolean;
  /** Callback fired when the target's armor vest breaks upon saving them from death. */
  onArmorBreak?: () => void;
}

export interface Projectile {
  id: number;
  weapon: WeaponId;
  owner: number;
  /** No friendly fire: projectiles ignore the shooter's teammates (but grenades still hurt the shooter). */
  team: Faction | null;
  pos: Vector3;
  /** Where it was fired from (damage falls off with the distance). */
  origin: Vector3;
  vel: Vector3;
  /** Gravity direction of the shooter at fire time. */
  down: Vector3;
  age: number;
  /** Bullets: glanced off a surface already (only once). */
  ricochets: number;
  resting: boolean;
  alive: boolean;
  /** Optional custom projectile hit radius (m), damage, blockDamage, knockback and charge level (crossbow). */
  radius?: number;
  customDamage?: number;
  customBlockDamage?: number;
  customPush?: number;
  chargeLevel?: 0 | 1 | 2 | 3;
  hitTargets?: Set<number>;
  hitCrystals?: Set<string>;
}

/** What dealt a blow (death screen, kill feed). */
export type HitSource = WeaponId | 'kick' | 'car' | 'jetpack' | 'crystal';

/**
 * A team's crystal as combat sees it: a vertical capsule (CRYSTAL) around `pos` along `up`. Only shots and blows of
 * other teams hurt it, and only from within CRYSTAL.range (match.ts keeps its HP).
 */
export interface Crystal { team: TeamId; pos: Vector3; up: Vector3; alive: boolean }
/** Crystal hit volume (radius, half length of its axis) and how close the attacker has to be to hurt it, m. */
export const CRYSTAL = { radius: 0.75, half: 1.3, range: 5 };

export type CombatEvent =
  | { type: 'fire'; weapon: WeaponId; owner: number; origin: Vector3; dir: Vector3; projectile: number }
  | { type: 'impact'; pos: Vector3; normal: Vector3; material?: BulletMaterial }
  /** A bullet glanced off a hard surface at a shallow angle and flies on. */
  | { type: 'ricochet'; pos: Vector3; normal: Vector3 }
  | { type: 'bounce'; pos: Vector3; speed: number }
  | { type: 'fizzle'; pos: Vector3 }
  | { type: 'explode'; pos: Vector3; radius: number }
  | { type: 'hit'; target: number; owner: number; damage: number; head: boolean; killed: boolean; pos: Vector3; cause?: DamageCause; weapon?: HitSource }
  | { type: 'armorBreak'; target: number; pos: Vector3 }
  /**
   * A punch or a kick: `pos` = what it landed on first (null = into the air), `target` = the first one hit, `hits` =
   * how many people / crates it got.
   */
  | { type: 'melee'; kind: 'punch' | 'kick'; owner: number; pos: Vector3 | null; target: number | null; hits: number }
  /** A shot / blow reached an enemy crystal: `far` = from too far away (no damage). */
  | { type: 'crystal'; team: TeamId; owner: number; pos: Vector3; damage: number; far: boolean }
  /** A hit on a target under spawn protection: no damage. */
  | { type: 'guarded'; target: number; pos: Vector3 };

/** Something loud happened: NPCs within `radius` hear it. */
export interface Noise { pos: Vector3; radius: number; owner: number }
/** Hearing radius of actions, m. */
export const NOISE = { gun: 38, grenade: 45, punch: 9, click: 22 };

/** What a bullet hits in the world: a placed block / piece of some material, or the map itself (null: concrete). */
export type BulletMaterial = keyof typeof PENETRATION;
/** Bullets hitting hard surfaces flatter than this (cos of the angle to the normal) glance off, keeping `keep` of the speed. */
export const RICOCHET = { cos: 0.26, keep: 0.6 };

export const MAX_HP = 100;
/** Every weapon, punch and explosion hurts living things this much of its listed damage (GravWars: fights last longer). */
export const DAMAGE_SCALE = 1 / 3;
/** Out of a fight for `delay` s → heal `rate` HP/s (players and bots, not city NPCs). */
export const REGEN = { delay: 3, rate: 2 };
/** Every hit shoves the victim away from the attacker: m/s per HP of damage taken, capped (-50% knockback). */
export const HIT_PUSH = { perHp: 0.275, min: 0.55, max: 4.25, lift: 0.28, airMul: 2.6, airLift: 0.42, maxAir: 8 };
/** Falls: landing faster than `safe` m/s hurts `perMs` HP for every m/s above it (not scaled by DAMAGE_SCALE). */
export const FALL = { safe: 18, perMs: 4.25, maxDmg: 25 };
export type DamageCause = 'fall' | 'car' | 'jetpack' | 'crystal';
export interface DamageOpts {
  /** Already final: no DAMAGE_SCALE. */
  raw?: boolean;
  /** No knockback (falls, explosions push by themselves). */
  noPush?: boolean;
  /** Where the blow came from, for the knockback (default: the attacker's centre, else the hit point). */
  from?: Vector3;
  /** Knockback × this (shotgun pellets). */
  pushMul?: number;
  cause?: DamageCause;
  weapon?: HitSource;
}
/** Spawn protection: seconds, and how far from the spawn point it holds. */
export const SPAWN_GUARD = { time: 3, radius: 6 };
/** Share of a grenade's sliding speed lost on each floor bounce. */
export const GRENADE_GRIP = 0.55;
