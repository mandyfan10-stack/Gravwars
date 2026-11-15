import { Vector3 } from 'three';
import { DEFAULT_MOVEMENT, PLAYER_HALF_SEGMENT, PLAYER_RADIUS } from './constants';
import type { MapData } from './map';
import type { PhysicsWorld, Rapier } from './physics';
import type { Props } from './props';
import type { TeamId } from './teams';
import { crossbowSpec, energyLeft, KICK, MELEE, PENETRATION, WeaponId, WEAPONS } from './weapons';
import { Wind } from './wind';

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
export type HitSource = WeaponId | 'kick';

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
export const NOISE = { gun: 38, grenade: 45, punch: 9 };

/** What a bullet hits in the world: a placed block / piece of some material, or the map itself (null: concrete). */
export type BulletMaterial = keyof typeof PENETRATION;
/** Bullets hitting hard surfaces flatter than this (cos of the angle to the normal) glance off, keeping `keep` of the speed. */
export const RICOCHET = { cos: 0.26, keep: 0.6 };
/** A bullet that comes out of a wall slower than this, m/s, stays in it. */
const PIERCE_MIN_SPEED = 120;
/** Thickest wall a bullet is tested against, m. */
const PIERCE_PROBE = 1.2;

export const MAX_HP = 100;
/** Every weapon, punch and explosion hurts living things this much of its listed damage (GravWars: fights last longer). */
export const DAMAGE_SCALE = 1 / 3;
/** Out of a fight for `delay` s → heal `rate` HP/s (players and bots, not city NPCs). */
export const REGEN = { delay: 3, rate: 2 };
/** Every hit shoves the victim away from the attacker: m/s per HP of damage taken, capped; much stronger in the air. */
export const HIT_PUSH = { perHp: 0.55, min: 1.1, max: 8.5, lift: 0.28, airMul: 2.6, airLift: 0.42, maxAir: 16 };
/** Falls: landing faster than `safe` m/s hurts `perMs` HP for every m/s above it (not scaled by DAMAGE_SCALE). */
export const FALL = { safe: 18, perMs: 4.25, maxDmg: 25 };
export type DamageCause = 'fall';
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
const DUMMY_RESPAWN = 3;

const _a = new Vector3();
const _b = new Vector3();
const _acc = new Vector3();
const _wind = new Vector3();
const _seg = new Vector3();
const _c0 = new Vector3();
const _c1 = new Vector3();
const _p = new Vector3();
const _q = new Vector3();
const _rel = new Vector3();
const _dir = new Vector3();
const _push = new Vector3();
const _push2 = new Vector3();

/** Closest points between segments p0p1 and q0q1. Returns squared distance, s/t written to out. */
function segSeg(p0: Vector3, p1: Vector3, q0: Vector3, q1: Vector3, out: { s: number; t: number }): number {
  const d1 = _p.copy(p1).sub(p0);
  const d2 = _q.copy(q1).sub(q0);
  const r = new Vector3().copy(p0).sub(q0);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s = 0;
  let t = 0;
  if (a <= 1e-9 && e <= 1e-9) {
    s = t = 0;
  } else if (a <= 1e-9) {
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1.dot(r);
    if (e <= 1e-9) {
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1.dot(d2);
      const den = a * e - b * b;
      s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  out.s = s;
  out.t = t;
  const cp = p0.clone().addScaledVector(d1, s);
  const cq = q0.clone().addScaledVector(d2, t);
  return cp.distanceToSquared(cq);
}

/**
 * Projectiles, wind, damage. Deterministic given the same inputs, so it can run as client prediction
 * and on the authoritative server.
 */
export class Combat {
  readonly wind: Wind;
  readonly projectiles: Projectile[] = [];
  readonly targets: Target[] = [];
  readonly events: CombatEvent[] = [];
  /** Shots, explosions and punches since the NPC manager last looked (it clears the list). */
  readonly noises: Noise[] = [];
  time = 0;
  /** Global wind multiplier (0 = calm; debug / tests). */
  windMul = 1;
  private nextId = 1;
  onWorldDamage: (handle: number, damage: number) => void = () => {};
  onExplosion: (pos: Vector3, radius: number, damage: number) => void = () => {};
  /** Material of a world collider for bullets (placed blocks); null = map geometry, not penetrable. */
  materialOf: (handle: number) => BulletMaterial | null = () => null;
  /** Loose crates and barrels: shots and blasts push them, a kick sends them flying. */
  props: Props | null = null;
  /** Team crystals (match beds) and what to do when one is hurt (`damage` already final). */
  crystals: Crystal[] = [];
  onCrystal: (c: Crystal, damage: number, owner: number) => void = () => {};
  /** Somebody was killed by `owner` (bots get their reward here). */
  onKill: (victim: Target, owner: number) => void = () => {};
  /** Every projectile of the last shot (a shotgun fires several). */
  readonly volley: Projectile[] = [];
  /** Handles of character-controller colliders: rays pass through them (capsules are tested analytically). */
  private readonly characters = new Set<number>();
  /** Ray filter that skips every character capsule. */
  readonly notCharacter = (c: { handle: number }) => !this.characters.has(c.handle);

  constructor(private R: Rapier, private world: PhysicsWorld, private map: MapData,
    /** Character-controller colliders to ignore (projectiles test player capsules analytically). */
    characters: { handle: number }[] = [], windSeed = 2024) {
    this.wind = new Wind(windSeed);
    for (const c of characters) this.addCharacter(c);
  }

  addCharacter(collider: { handle: number }) {
    this.characters.add(collider.handle);
  }

  /** Clear line between two points (character capsules do not block). */
  lineOfSight(from: Vector3, to: Vector3, margin = 0.3) {
    const d = _seg.copy(to).sub(from);
    const len = d.length();
    if (len < 1e-6) return true;
    const hit = this.world.castRay(new this.R.Ray(from, d.divideScalar(len)), Math.max(0, len - margin), true,
      undefined, undefined, undefined, undefined, this.notCharacter);
    return !hit;
  }

  target(id: number) {
    return this.targets.find((t) => t.id === id);
  }

  /** Give a freshly spawned target its spawn protection. */
  guard(tg: Target) {
    tg.guard = { from: tg.center.clone(), t: SPAWN_GUARD.time };
  }

  /** Shooting / punching / throwing ends your own spawn protection. */
  private unguard(owner: number) {
    const t = this.target(owner);
    if (t) t.guard = null;
  }

  /**
   * Fire a gun / throw a grenade. Several pellets (shotgun) go out in a fixed pattern over the cone: one in the
   * middle, the rest on a ring turned a little differently every shot (deterministic per shot). Returns the first.
   */
  fire(weapon: WeaponId, owner: number, origin: Vector3, dir: Vector3, ownerVel: Vector3, down: Vector3, chargeT = 0) {
    this.unguard(owner);
    const def = WEAPONS[weapon];
    const xbow = weapon === 'crossbow' ? crossbowSpec(chargeT) : null;
    const speed = xbow ? xbow.speed : def.speed;
    const d = dir.clone().normalize();
    const u = new Vector3(), v = new Vector3();
    if (def.pellets > 1) {
      u.set(Math.abs(d.y) < 0.9 ? 0 : 1, Math.abs(d.y) < 0.9 ? 1 : 0, 0).cross(d).normalize();
      v.crossVectors(d, u);
    }
    const turn = Math.sin(this.nextId * 78.233) * 43758.5453;
    this.volley.length = 0;
    for (let k = 0; k < def.pellets; k++) {
      const pd = d.clone();
      if (k > 0) {
        const a = ((k - 1) / (def.pellets - 1)) * Math.PI * 2 + (turn - Math.floor(turn)) * Math.PI * 2;
        const r = Math.tan(def.cone * (k % 2 ? 1 : 0.6));
        pd.addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r).normalize();
      }
      const p: Projectile = {
        id: this.nextId++, weapon, owner, team: this.target(owner)?.team ?? null, pos: origin.clone(), origin: origin.clone(),
        vel: pd.multiplyScalar(speed).addScaledVector(ownerVel, def.inherit),
        down: down.clone().normalize(), age: 0, ricochets: 0, resting: false, alive: true,
        ...(xbow ? {
          radius: xbow.width / 2,
          customDamage: xbow.damage,
          customBlockDamage: xbow.blockDamage,
          customPush: xbow.push,
          chargeLevel: xbow.level,
        } : {}),
      };
      this.projectiles.push(p);
      this.volley.push(p);
    }
    const p = this.volley[0];
    if (weapon !== 'grenade') this.noises.push({ pos: origin.clone(), radius: NOISE.gun, owner });
    this.events.push({ type: 'fire', weapon, owner, origin: origin.clone(), dir: d, projectile: p.id });
    return p;
  }

  /** Fire a gun / throw a grenade, or punch with the fists. */
  use(weapon: WeaponId, owner: number, eye: Vector3, dir: Vector3, ownerVel: Vector3, down: Vector3, chargeT = 0): Projectile | null {
    if (WEAPONS[weapon].speed === 0) {
      this.melee(weapon, owner, eye, dir);
      return null;
    }
    return this.fire(weapon, owner, eye, dir, ownerVel, down, chargeT);
  }

  /**
   * Targets within `reach` of `from` (to the capsule surface) inside the cone around `dir` (cos of the half-angle),
   * not behind a wall, nearest first. One right on the line counts whatever the cone.
   */
  inReach(owner: number, from: Vector3, dir: Vector3, reach: number, cos: number): { target: Target; pos: Vector3; dist: number }[] {
    const team = this.target(owner)?.team ?? null;
    const out: { target: Target; pos: Vector3; dist: number }[] = [];
    const tip = _a.copy(from).addScaledVector(dir, reach);
    const line = this.rayTargets({ owner, team }, from, tip);
    for (const tg of this.targets) {
      if (!tg.alive || tg.id === owner || tg.team === team) continue;
      // nearest point of the capsule's axis to the attacker
      _c0.copy(tg.center).addScaledVector(tg.up, -PLAYER_HALF_SEGMENT);
      const k = Math.max(-1, Math.min(1, _seg.copy(from).sub(tg.center).dot(tg.up) / PLAYER_HALF_SEGMENT));
      const q = tg.center.clone().addScaledVector(tg.up, k * PLAYER_HALF_SEGMENT);
      const v = _rel.copy(q).sub(from);
      const len = v.length();
      const r = tg.radius ?? PLAYER_RADIUS;
      const dist = Math.max(0, len - r);
      if (dist > reach) continue;
      const onLine = line?.target === tg;
      if (!onLine && len > 1e-4 && v.dot(dir) / len < cos) continue;
      // a wall in between stops the blow
      const wall = len > 1e-4 ? this.rayWorld(from, q) : null;
      if (wall && wall.t * len < len - r - 0.05) continue;
      const pos = len > 1e-4 ? from.clone().addScaledVector(v, Math.max(0, len - r) / len) : q;
      out.push({ target: tg, pos, dist });
    }
    return out.sort((x, y) => x.dist - y.dist);
  }

  /** Shove a target away from the attacker along its own ground (`speed` m/s) and a little up. */
  private shove(tg: Target, from: Vector3, speed: number, lift: number) {
    if (!tg.onImpulse) return;
    const d = _push.copy(tg.center).sub(from);
    d.addScaledVector(tg.up, -d.dot(tg.up));
    if (d.lengthSq() < 1e-6) return;
    tg.onImpulse(d.normalize().multiplyScalar(speed).addScaledVector(tg.up, speed * lift));
  }

  /**
   * Punch: lands on everyone within reach in front (splash), each one shoved back. Nobody there: the first wall /
   * crate along the view takes it.
   */
  melee(weapon: WeaponId, owner: number, eye: Vector3, dir: Vector3) {
    this.unguard(owner);
    const def = WEAPONS[weapon];
    const d = dir.clone().normalize();
    this.noises.push({ pos: eye.clone(), radius: NOISE.punch, owner });
    const hits = this.inReach(owner, eye, d, def.reach, MELEE.cos);
    const to = eye.clone().addScaledVector(d, def.reach);
    const line = this.rayTargets({ owner, team: this.target(owner)?.team ?? null }, eye, to);
    for (const h of hits) {
      const head = line?.target === h.target && line.head;
      this.shove(h.target, eye, MELEE.push, MELEE.lift);
      this.damage(h.target, Math.round(def.damage * (head ? def.headMul : 1)), owner, head, h.pos, { noPush: true, weapon });
    }
    const crystal = this.crystalInReach(owner, eye, d, def.reach);
    if (crystal) this.hurtCrystal(crystal.c, def.damage * DAMAGE_SCALE, owner, eye, crystal.pos);
    if (hits.length || crystal) {
      this.events.push({ type: 'melee', kind: 'punch', owner, pos: (hits[0]?.pos ?? crystal!.pos).clone(), target: hits[0]?.target.id ?? null, hits: hits.length });
      return;
    }
    const wh = this.rayWorld(eye, to);
    if (wh) {
      const pos = eye.clone().lerp(to, wh.t);
      const prop = this.props?.of(wh.handle) ?? -1;
      if (prop >= 0) {
        if (!this.props!.damage(prop, 16)) this.props!.push(prop, d.clone().multiplyScalar(2.5), pos);
      } else this.onWorldDamage(wh.handle, Math.round(def.blockDamage * 0.5));
      this.events.push({ type: 'melee', kind: 'punch', owner, pos, target: null, hits: prop >= 0 ? 1 : 0 });
      return;
    }
    this.events.push({ type: 'melee', kind: 'punch', owner, pos: null, target: null, hits: 0 });
  }

  /**
   * Kick (V): from the hip, along the ground the attacker stands on, a wide cone. Everyone in it takes KICK.damage HP
   * and flies back; crates and barrels fly off. Returns how many living targets it got (the caller sets the cooldown).
   */
  kick(owner: number, eye: Vector3, dir: Vector3, up: Vector3): number {
    this.unguard(owner);
    const hip = eye.clone().addScaledVector(up, -0.85);
    // aim along the ground, but a look down / up still tilts it a little (a crate on a step)
    const d = dir.clone().addScaledVector(up, -dir.dot(up) * 0.7);
    if (d.lengthSq() < 1e-4) d.copy(dir);
    d.normalize();
    this.noises.push({ pos: eye.clone(), radius: NOISE.punch, owner });
    let first: Vector3 | null = null;
    let target: number | null = null;
    let wallHit = false;
    const hits = [...this.inReach(owner, hip, d, KICK.reach, KICK.cos), ...this.inReach(owner, eye, d, KICK.reach * 0.8, KICK.cos)]
      .filter((h, i, all) => all.findIndex((o) => o.target === h.target) === i);
    for (const h of hits) {
      first ??= h.pos;
      if (h.target.npc !== 'car') target ??= h.target.id;
      this.shove(h.target, hip, KICK.push, KICK.lift);
      this.damage(h.target, KICK.damage, owner, false, h.pos, { raw: true, noPush: true, weapon: 'kick' });
    }
    let n = hits.length;
    if (this.props) {
      for (const i of this.props.inCone(hip, d, KICK.reach, KICK.cos)) {
        const at = this.props.pos(i);
        // into the crate a bit above its middle: it tumbles away (and breaks after a few kicks)
        if (!this.props.damage(i, 10)) {
          const push = d.clone().multiplyScalar(KICK.propSpeed).addScaledVector(up, KICK.propSpeed * 0.3);
          this.props.push(i, push, at.clone().addScaledVector(up, 0.15).addScaledVector(d, -0.2));
        }
        first ??= at;
        n++;
      }
    }
    if (!n) {
      const wh = this.rayWorld(hip, hip.clone().addScaledVector(d, KICK.reach))
        ?? this.rayWorld(eye, eye.clone().addScaledVector(dir, KICK.reach));
      if (wh) {
        first = hip.clone().addScaledVector(d, KICK.reach * wh.t);
        this.onWorldDamage(wh.handle, Math.round(WEAPONS.fists.blockDamage));
        wallHit = true;
        n++;
      }
    }
    if (first) {
      const kicker = this.target(owner);
      if (kicker?.onImpulse) {
        const back = _push.copy(dir).negate();
        back.addScaledVector(up, -back.dot(up) * 0.5).normalize();
        const pushSpeed = wallHit ? KICK.wallRecoilPush : KICK.recoilPush;
        const liftSpeed = wallHit ? 3.4 : 2.2;
        kicker.onImpulse(back.multiplyScalar(pushSpeed).addScaledVector(up, liftSpeed));
      }
    }
    this.events.push({ type: 'melee', kind: 'kick', owner, pos: first?.clone() ?? null, target, hits: n });
    return n;
  }

  rayWorld(from: Vector3, to: Vector3) {
    const d = _seg.copy(to).sub(from);
    const len = d.length();
    if (len < 1e-6) return null;
    d.divideScalar(len);
    const ray = new this.R.Ray(from, d);
    const hit = this.world.castRayAndGetNormal(ray, len, true, undefined, undefined, undefined, undefined, this.notCharacter);
    if (!hit) return null;
    return { t: hit.timeOfImpact / len, normal: new Vector3(hit.normal.x, hit.normal.y, hit.normal.z), handle: hit.collider.handle };
  }

  rayTargets(p: Pick<Projectile, 'owner' | 'team'> & { radius?: number; skipCars?: boolean; hitTargets?: Set<number> }, from: Vector3, to: Vector3) {
    let best: { t: number; target: Target; head: boolean } | null = null;
    const st = { s: 0, t: 0 };
    const pr = p.radius ?? 0.04;
    for (const tg of this.targets) {
      if (!tg.alive || tg.id === p.owner || tg.team === p.team || p.hitTargets?.has(tg.id) || (tg.npc === 'car' && (p.skipCars || p.owner !== 0))) continue;
      _c0.copy(tg.center).addScaledVector(tg.up, -PLAYER_HALF_SEGMENT);
      _c1.copy(tg.center).addScaledVector(tg.up, PLAYER_HALF_SEGMENT);
      const d2 = segSeg(from, to, _c0, _c1, st);
      const r = (tg.radius ?? PLAYER_RADIUS) + pr;
      if (d2 > r * r) continue;
      // back off to the capsule surface (approximately)
      const len = from.distanceTo(to);
      const back = Math.sqrt(Math.max(r * r - d2, 0)) / Math.max(len, 1e-6);
      const t = Math.max(0, st.s - back);
      if (best && best.t <= t) continue;
      const hitPos = from.clone().lerp(to, t);
      const head = hitPos.sub(tg.center).dot(tg.up) > PLAYER_HALF_SEGMENT - 0.05;
      best = { t, target: tg, head };
    }
    return best;
  }

  /** Nearest point of a crystal's axis to `p`. */
  private crystalAxis(c: Crystal, p: Vector3, out = new Vector3()) {
    const k = Math.max(-CRYSTAL.half, Math.min(CRYSTAL.half, _q.copy(p).sub(c.pos).dot(c.up)));
    return out.copy(c.pos).addScaledVector(c.up, k);
  }

  /** How far `p` is from a crystal (its axis): the 5 m rule. */
  crystalDistance(c: Crystal, p: Vector3) {
    return this.crystalAxis(c, p, _p).distanceTo(p);
  }

  /** Enemy crystal a segment from → to passes through (as a fraction of it), for projectiles of `team`. */
  private rayCrystals(team: Faction | null, from: Vector3, to: Vector3, skip?: Set<string>): { t: number; c: Crystal } | null {
    let best: { t: number; c: Crystal } | null = null;
    const st = { s: 0, t: 0 };
    for (const c of this.crystals) {
      if (!c.alive || c.team === team || !team || team.includes(':') || skip?.has(c.team)) continue;
      _c0.copy(c.pos).addScaledVector(c.up, -CRYSTAL.half);
      _c1.copy(c.pos).addScaledVector(c.up, CRYSTAL.half);
      const d2 = segSeg(from, to, _c0, _c1, st);
      if (d2 > CRYSTAL.radius ** 2) continue;
      const len = from.distanceTo(to);
      const t = Math.max(0, st.s - Math.sqrt(CRYSTAL.radius ** 2 - d2) / Math.max(len, 1e-6));
      if (!best || t < best.t) best = { t, c };
    }
    return best;
  }

  /** An enemy crystal within a blow's reach in front of `eye`. */
  private crystalInReach(owner: number, eye: Vector3, dir: Vector3, reach: number): { c: Crystal; pos: Vector3 } | null {
    const hit = this.rayCrystals(this.target(owner)?.team ?? null, eye, _b.copy(eye).addScaledVector(dir, reach + CRYSTAL.radius));
    return hit ? { c: hit.c, pos: eye.clone().lerp(_b, hit.t) } : null;
  }

  /**
   * A shot / blow reaches an enemy crystal: it hurts only if the attacker (`from`: where the shot left, where the
   * fist is) is within CRYSTAL.range of it.
   */
  private hurtCrystal(c: Crystal, damage: number, owner: number, from: Vector3, pos: Vector3) {
    const far = this.crystalDistance(c, from) > CRYSTAL.range;
    const dmg = far ? 0 : Math.round(damage * 10) / 10;
    this.events.push({ type: 'crystal', team: c.team, owner, pos: pos.clone(), damage: dmg, far });
    if (dmg > 0) this.onCrystal(c, dmg, owner);
  }

  /**
   * Hurt a target. `amount` is the listed damage (scaled by DAMAGE_SCALE unless `opts.raw`); the hit also shoves the
   * target away from the attacker (HIT_PUSH).
   */
  damage(tg: Target, amount: number, owner: number, head: boolean, pos: Vector3, opts: DamageOpts = {}) {
    if (!tg.alive) return;
    if (tg.guard) {
      this.events.push({ type: 'guarded', target: tg.id, pos: pos.clone() });
      return;
    }
    const dmg = opts.raw ? amount : Math.round(amount * DAMAGE_SCALE * 10) / 10;
    tg.hp = Math.max(0, tg.hp - dmg);
    tg.calm = 0;
    const killed = tg.hp <= 0.05;
    if (killed) tg.hp = 0;
    tg.onHit?.(owner, dmg);
    if (!opts.noPush && owner !== tg.id && tg.onImpulse) {
      const from = opts.from ?? this.target(owner)?.center ?? pos;
      const dir = _push.copy(tg.center).sub(from);
      dir.addScaledVector(tg.up, -dir.dot(tg.up));
      if (dir.lengthSq() < 1e-6) dir.copy(tg.center).sub(pos).addScaledVector(tg.up, -_push.dot(tg.up));
      if (dir.lengthSq() > 1e-6) {
        const inAir = tg.airborne ? tg.airborne() : false;
        const airMul = inAir ? HIT_PUSH.airMul : 1;
        const cap = inAir ? HIT_PUSH.maxAir : HIT_PUSH.max;
        const lift = inAir ? HIT_PUSH.airLift : HIT_PUSH.lift;
        const v = Math.min(cap, Math.max(HIT_PUSH.min, dmg * HIT_PUSH.perHp) * (opts.pushMul ?? 1) * airMul);
        tg.onImpulse(dir.normalize().addScaledVector(tg.up, lift).multiplyScalar(v));
      }
    }
    if (killed) {
      tg.alive = false;
      if (tg.respawnIn >= 0) tg.respawnIn = DUMMY_RESPAWN;
      this.onKill(tg, owner);
    }
    this.events.push({ type: 'hit', target: tg.id, owner, damage: dmg, head, killed, pos: pos.clone(), cause: opts.cause, weapon: opts.weapon });
  }

  /** Fall damage for a landing at `speed` m/s (FALL); returns the damage dealt. */
  fall(tg: Target, speed: number): number {
    const raw = Math.round((speed - FALL.safe) * FALL.perMs);
    const dmg = Math.min(FALL.maxDmg, raw);
    if (dmg <= 0 || !tg.alive || tg.guard) return 0;
    this.damage(tg, dmg, tg.id, false, tg.center, { raw: true, noPush: true, cause: 'fall' });
    return dmg;
  }

  /** Trigger an explosion at `pos` with the given radius, damage, knockback and blockDamage. */
  triggerExplosion(
    pos: Vector3, owner: number, team: Faction | null, radius: number, damage: number,
    knockback: number, blockDamage: number, selfMul = 0.4, raw = false, weapon: HitSource = 'rocket', origin = pos,
  ) {
    this.events.push({ type: 'explode', pos: pos.clone(), radius });
    this.noises.push({ pos: pos.clone(), radius: NOISE.grenade, owner });
    this.onExplosion(pos.clone(), radius, blockDamage);
    this.props?.explosion(pos, radius * 1.6, knockback * 0.8, damage);
    // an enemy crystal in the blast: hurt if the thrower / shooter stands close to it now
    for (const c of this.crystals) {
      if (!c.alive || c.team === team || !team || team.includes(':')) continue;
      const d = this.crystalDistance(c, pos) - CRYSTAL.radius;
      if (d > radius) continue;
      const k = Math.max(0, 1 - Math.max(0, d) / radius);
      const from = this.target(owner)?.center ?? origin;
      const crystalMul = weapon === 'rocket' ? 0.5 : 1;
      this.hurtCrystal(c, damage * (0.3 + 0.7 * k) * (raw ? 1 : DAMAGE_SCALE) * crystalMul, owner, from, this.crystalAxis(c, pos));
    }
    for (const tg of this.targets) {
      if (!tg.alive || tg.guard || (tg.team === team && tg.id !== owner)) continue;
      const r = tg.radius ?? PLAYER_RADIUS;
      const d = tg.center.distanceTo(pos);
      if (d > radius + r) continue;
      // line of sight: walls protect
      const los = this.rayWorld(pos, tg.center);
      if (los && los.t * d < d - 0.6) continue;
      const k = Math.max(0, 1 - Math.max(0, d - r) / radius);
      const mul = tg.id === owner ? selfMul : 1;
      const dmg = Math.round(damage * (0.3 + 0.7 * k) * mul);
      if (tg.onImpulse) {
        const dir = tg.center.clone().sub(pos);
        if (dir.lengthSq() < 1e-4) dir.copy(tg.up);
        dir.normalize().addScaledVector(tg.up, 0.35).normalize();
        tg.onImpulse(dir.multiplyScalar(knockback * (0.35 + 0.65 * k)));
      }
      this.damage(tg, dmg, owner, false, tg.center, { noPush: true, raw, weapon });
    }
  }

  private explode(p: Projectile) {
    const def = WEAPONS[p.weapon];
    p.alive = false;
    this.triggerExplosion(p.pos, p.owner, p.team, def.radius, def.damage, def.knockback, def.blockDamage, def.selfMul, def.raw, p.weapon, p.origin);
  }

  /**
   * A bullet reaches a world surface: it damages what it hit, then glances off (shallow angle, hard surface),
   * goes through (a wall thin and soft enough for its speed, it slows down) or stays there.
   */
  private bulletHitsWorld(p: Projectile, end: Vector3, normal: Vector3, handle: number) {
    const def = WEAPONS[p.weapon];
    const speed = p.vel.length();
    const dir = _dir.copy(p.vel).divideScalar(speed);
    const material = this.materialOf(handle);
    const cos = -dir.dot(normal);
    // measure the wall before the damage can remove it
    const thick = material && material !== 'metal' && def.power ? this.thickness(handle, end, dir) : null;
    const prop = this.props?.of(handle) ?? -1;
    const baseDmg = p.customDamage ?? def.damage;
    const baseBlockDmg = p.customBlockDamage ?? def.blockDamage;
    if (prop >= 0) {
      if (!this.props!.damage(prop, Math.max(2, Math.round(baseDmg * 1.4)))) {
        this.props!.push(prop, _rel.copy(dir).multiplyScalar(def.pellets > 1 ? 0.35 : 0.8), end);
      }
    } else this.onWorldDamage(handle, Math.max(1, Math.round(baseBlockDmg * energyLeft(def, speed))));
    this.events.push({ type: 'impact', pos: end.clone(), normal: normal.clone(), material: material ?? (prop >= 0 ? 'wood' : undefined) });
    if (p.weapon !== 'crossbow' && material !== 'wood' && cos < RICOCHET.cos && p.ricochets === 0) {
      p.ricochets++;
      p.vel.addScaledVector(normal, -2 * p.vel.dot(normal)).multiplyScalar(RICOCHET.keep);
      // a little scatter off the surface (deterministic per bullet)
      const j = Math.sin(p.id * 12.9898) * 43758.5453;
      p.vel.addScaledVector(normal, speed * RICOCHET.keep * 0.05 * (j - Math.floor(j)));
      p.pos.copy(end).addScaledVector(normal, 0.02);
      this.events.push({ type: 'ricochet', pos: end.clone(), normal: normal.clone() });
      return;
    }
    if (p.weapon !== 'crossbow' && material && thick !== null) {
      // reckoned in real bullet speed: `power` at the muzzle, slowed down as the tracer is
      const power = speed * def.power / def.speed;
      const left = power - thick * PENETRATION[material];
      if (left > PIERCE_MIN_SPEED) {
        p.vel.multiplyScalar(left / power);
        p.pos.copy(end).addScaledVector(dir, thick + 0.02);
        this.events.push({ type: 'impact', pos: p.pos.clone(), normal: dir.clone(), material });
        return;
      }
    }
    p.alive = false;
    p.pos.copy(end);
  }

  /** How far a ray entering collider `handle` at `entry` along `dir` travels inside it (null: thicker than the probe). */
  private thickness(handle: number, entry: Vector3, dir: Vector3): number | null {
    const from = _p.copy(entry).addScaledVector(dir, PIERCE_PROBE);
    const hit = this.world.castRay(new this.R.Ray(from, _q.copy(dir).negate()), PIERCE_PROBE, true,
      undefined, undefined, undefined, undefined, (c) => c.handle === handle);
    if (!hit || hit.timeOfImpact < 1e-4) return null;
    return PIERCE_PROBE - hit.timeOfImpact;
  }

  tick(dt: number) {
    this.time += dt;
    for (const tg of this.targets) {
      if (tg.stun) tg.stun = tg.alive ? Math.max(0, tg.stun - dt) : 0;
      if (tg.regen && tg.alive) {
        tg.calm = (tg.calm ?? REGEN.delay) + dt;
        if (tg.calm >= REGEN.delay && tg.hp < MAX_HP) tg.hp = Math.min(MAX_HP, tg.hp + REGEN.rate * dt);
      }
      if (tg.guard && ((tg.guard.t -= dt) <= 0 || !tg.alive || tg.center.distanceTo(tg.guard.from) > SPAWN_GUARD.radius)) tg.guard = null;
      if (!tg.alive && tg.respawnIn > 0) {
        tg.respawnIn -= dt;
        if (tg.respawnIn <= 0) {
          tg.respawnIn = 0;
          tg.alive = true;
          tg.hp = MAX_HP;
        }
      }
    }
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      const def = WEAPONS[p.weapon];
      p.age += dt;
      const isWallOnlyCrossbow = p.weapon === 'crossbow' && (p.chargeLevel ?? 0) >= 2;
      if (def.fuse && p.age >= def.fuse) {
        this.explode(p);
        continue;
      }
      if ((!isWallOnlyCrossbow && p.age > def.life) || p.pos.length() > this.map.killRadius * 1.5 || (isWallOnlyCrossbow && p.age > 300)) {
        p.alive = false;
        continue;
      }
      if (p.resting) continue;
      _acc.copy(p.down).multiplyScalar(DEFAULT_MOVEMENT.gravity * def.gravityScale);
      this.wind.felt(this.time, p.down, _wind).multiplyScalar(def.windScale * this.windMul);
      if (def.drag) {
        // bullets: quadratic air drag against the moving air (the wind is the air's velocity here, m/s)
        _rel.copy(p.vel).sub(_wind);
        _acc.addScaledVector(_rel, -def.drag * _rel.length());
      } else _acc.add(_wind); // grenades: the wind pushes them along (Worms style)
      p.vel.addScaledVector(_acc, dt);
      _a.copy(p.pos);
      _b.copy(p.pos).addScaledVector(p.vel, dt);

      const wh = this.rayWorld(_a, _b);
      const grenade = !!def.fuse;

      if (isWallOnlyCrossbow) {
        // Pierces all targets and crystals along the path up to the wall (if any)
        const maxT = wh ? wh.t : 1;
        const targetEnd = _a.clone().lerp(_b, maxT);
        let targetLoops = 0;
        while (targetLoops++ < 32) {
          const th = this.rayTargets(p, _a, targetEnd);
          if (!th || th.t > 1) break;
          p.hitTargets ??= new Set<number>();
          p.hitTargets.add(th.target.id);
          const hitPos = _a.clone().lerp(targetEnd, th.t);
          const energy = energyLeft(def, p.vel.length());
          const baseDmg = p.customDamage ?? def.damage;
          const pushMul = p.customPush ?? def.push;
          this.damage(th.target, Math.max(1, Math.round(baseDmg * energy * (th.head ? def.headMul : 1))), p.owner, th.head, hitPos,
            { raw: def.raw, from: _push2.copy(hitPos).addScaledVector(p.vel, -1 / Math.max(1, p.vel.length())), pushMul, weapon: p.weapon });
        }
        let crystalLoops = 0;
        while (crystalLoops++ < 8) {
          const ch = this.rayCrystals(p.team, _a, targetEnd, p.hitCrystals);
          if (!ch || ch.t > 1) break;
          p.hitCrystals ??= new Set<string>();
          p.hitCrystals.add(ch.c.team);
          const hitPos = _a.clone().lerp(targetEnd, ch.t);
          const energy = energyLeft(def, p.vel.length());
          const baseDmg = p.customDamage ?? def.damage;
          this.hurtCrystal(ch.c, baseDmg * energy * (def.raw ? 1 : DAMAGE_SCALE), p.owner, p.origin, hitPos);
        }
        if (wh) {
          const end = _a.clone().lerp(_b, wh.t);
          this.bulletHitsWorld(p, end, wh.normal, wh.handle);
          continue;
        }
        p.pos.copy(_b);
        continue;
      }

      const th = !grenade ? this.rayTargets(p, _a, _b) : null;
      const ch = !grenade ? this.rayCrystals(p.team, _a, _b) : null;
      const tEnd = Math.min(wh ? wh.t : 1, th ? th.t : 1, ch ? ch.t : 1);
      const end = _a.clone().lerp(_b, tEnd);
      if (def.explodeOnHit && (wh || th || ch)) {
        p.pos.copy(end);
        if (wh && tEnd === wh.t) p.pos.addScaledVector(wh.normal, 0.15);
        this.explode(p);
        continue;
      }
      if (ch && tEnd === ch.t) {
        p.alive = false;
        p.pos.copy(end);
        const energy = energyLeft(def, p.vel.length());
        const baseDmg = p.customDamage ?? def.damage;
        const crystalMul = p.weapon === 'rocket' ? 0.5 : 1;
        this.hurtCrystal(ch.c, baseDmg * energy * (def.raw ? 1 : DAMAGE_SCALE) * crystalMul, p.owner, p.origin, end);
        continue;
      }
      if (th && (!wh || th.t <= wh.t)) {
        p.alive = false;
        p.pos.copy(end);
        const energy = energyLeft(def, p.vel.length());
        const baseDmg = p.customDamage ?? def.damage;
        const pushMul = p.customPush ?? def.push;
        this.damage(th.target, Math.max(1, Math.round(baseDmg * energy * (th.head ? def.headMul : 1))), p.owner, th.head, end,
          { raw: def.raw, from: _push2.copy(end).addScaledVector(p.vel, -1 / Math.max(1, p.vel.length())), pushMul, weapon: p.weapon });
        continue;
      }
      if (wh) {
        if (!grenade) {
          this.bulletHitsWorld(p, end, wh.normal, wh.handle);
          continue;
        }
        // grenade bounce
        const n = wh.normal;
        const vn = p.vel.dot(n);
        p.pos.copy(end).addScaledVector(n, 0.06);
        if (vn < 0) {
          p.vel.addScaledVector(n, -(1 + def.bounce) * vn);
          // a floor grips: most of the sliding speed is lost (a grenade does not roll on for metres); walls just damp
          if (n.dot(p.down) < -0.7) p.vel.addScaledVector(_rel.copy(p.vel).addScaledVector(n, -p.vel.dot(n)), -GRENADE_GRIP);
          else p.vel.multiplyScalar(0.8);
          if (-vn > 1.5) this.events.push({ type: 'bounce', pos: p.pos.clone(), speed: -vn });
          if (n.dot(p.down) < -0.7 && p.vel.length() < 1.2) {
            p.resting = true;
            p.vel.set(0, 0, 0);
          }
        }
        continue;
      }
      p.pos.copy(_b);
    }
    // nobody listening (no NPCs): do not let the list grow
    if (this.noises.length > 64) this.noises.splice(0, this.noises.length - 64);
    // forget dead projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) if (!this.projectiles[i].alive) this.projectiles.splice(i, 1);
  }
}
