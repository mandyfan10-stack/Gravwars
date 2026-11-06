import { Vector3 } from 'three';
import { DEFAULT_MOVEMENT, PLAYER_HALF_SEGMENT, PLAYER_RADIUS } from './constants';
import type { MapData } from './map';
import type { PhysicsWorld, Rapier } from './physics';
import type { TeamId } from './teams';
import { energyLeft, PENETRATION, WeaponId, WEAPONS } from './weapons';
import { Wind } from './wind';

/**
 * Faction of a target: a team, or an NPC side. Projectiles and punches never hurt their own faction, so every bum
 * gets a faction of its own (they fight each other) while a gang shares one.
 */
export type Faction = TeamId | `bum:${number}` | `gang:${string}`;

/** Anything that can be shot: a capsule standing along `up`. */
export interface Target {
  id: number;
  team: Faction;
  /** NPCs (bums, gangs): not part of any team, ignored by team bots unless they attack them. */
  npc?: 'bum' | 'gang';
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
}

export type CombatEvent =
  | { type: 'fire'; weapon: WeaponId; owner: number; origin: Vector3; dir: Vector3; projectile: number }
  | { type: 'impact'; pos: Vector3; normal: Vector3; material?: BulletMaterial }
  /** A bullet glanced off a hard surface at a shallow angle and flies on. */
  | { type: 'ricochet'; pos: Vector3; normal: Vector3 }
  | { type: 'bounce'; pos: Vector3; speed: number }
  | { type: 'fizzle'; pos: Vector3 }
  | { type: 'explode'; pos: Vector3; radius: number }
  | { type: 'hit'; target: number; owner: number; damage: number; head: boolean; killed: boolean; pos: Vector3 }
  /** A punch: `pos` = what it landed on (null = swung at the air). */
  | { type: 'melee'; owner: number; pos: Vector3 | null; target: number | null }
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
/** Spawn protection: seconds, and how far from the spawn point it holds. */
export const SPAWN_GUARD = { time: 3, radius: 6 };
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

  fire(weapon: WeaponId, owner: number, origin: Vector3, dir: Vector3, ownerVel: Vector3, down: Vector3) {
    this.unguard(owner);
    const def = WEAPONS[weapon];
    const p: Projectile = {
      id: this.nextId++, weapon, owner, team: this.target(owner)?.team ?? null, pos: origin.clone(), origin: origin.clone(),
      vel: dir.clone().normalize().multiplyScalar(def.speed).addScaledVector(ownerVel, def.inherit),
      down: down.clone().normalize(), age: 0, ricochets: 0, resting: false, alive: true,
    };
    this.projectiles.push(p);
    if (weapon !== 'grenade') this.noises.push({ pos: origin.clone(), radius: NOISE.gun, owner });
    this.events.push({ type: 'fire', weapon, owner, origin: origin.clone(), dir: dir.clone(), projectile: p.id });
    return p;
  }

  /** Fire a gun / throw a grenade, or punch with the fists. */
  use(weapon: WeaponId, owner: number, eye: Vector3, dir: Vector3, ownerVel: Vector3, down: Vector3): Projectile | null {
    if (WEAPONS[weapon].speed === 0) {
      this.melee(weapon, owner, eye, dir);
      return null;
    }
    return this.fire(weapon, owner, eye, dir, ownerVel, down);
  }

  /** Instant short-range hit along the view: the first capsule or world surface within reach. Walls stop it. */
  melee(weapon: WeaponId, owner: number, eye: Vector3, dir: Vector3) {
    this.unguard(owner);
    const def = WEAPONS[weapon];
    const to = eye.clone().addScaledVector(dir.clone().normalize(), def.reach);
    const fake = { owner, team: this.target(owner)?.team ?? null } as Projectile;
    this.noises.push({ pos: eye.clone(), radius: NOISE.punch, owner });
    const wh = this.rayWorld(eye, to);
    const th = this.rayTargets(fake, eye, to);
    if (th && (!wh || th.t <= wh.t)) {
      const pos = eye.clone().lerp(to, th.t);
      this.events.push({ type: 'melee', owner, pos: pos.clone(), target: th.target.id });
      const push = to.clone().sub(eye).normalize().addScaledVector(th.target.up, 0.3).multiplyScalar(2.2);
      th.target.onImpulse?.(push);
      this.damage(th.target, Math.round(def.damage * (th.head ? def.headMul : 1)), owner, th.head, pos);
      return;
    }
    if (wh) {
      const pos = eye.clone().lerp(to, wh.t);
      this.onWorldDamage(wh.handle, Math.round(def.blockDamage * 0.5));
      this.events.push({ type: 'melee', owner, pos, target: null });
      return;
    }
    this.events.push({ type: 'melee', owner, pos: null, target: null });
  }

  private rayWorld(from: Vector3, to: Vector3) {
    const d = _seg.copy(to).sub(from);
    const len = d.length();
    if (len < 1e-6) return null;
    d.divideScalar(len);
    const ray = new this.R.Ray(from, d);
    const hit = this.world.castRayAndGetNormal(ray, len, true, undefined, undefined, undefined, undefined, this.notCharacter);
    if (!hit) return null;
    return { t: hit.timeOfImpact / len, normal: new Vector3(hit.normal.x, hit.normal.y, hit.normal.z), handle: hit.collider.handle };
  }

  private rayTargets(p: Pick<Projectile, 'owner' | 'team'>, from: Vector3, to: Vector3) {
    let best: { t: number; target: Target; head: boolean } | null = null;
    const st = { s: 0, t: 0 };
    for (const tg of this.targets) {
      if (!tg.alive || tg.id === p.owner || tg.team === p.team) continue;
      _c0.copy(tg.center).addScaledVector(tg.up, -PLAYER_HALF_SEGMENT);
      _c1.copy(tg.center).addScaledVector(tg.up, PLAYER_HALF_SEGMENT);
      const d2 = segSeg(from, to, _c0, _c1, st);
      const r = PLAYER_RADIUS + 0.04;
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

  damage(tg: Target, amount: number, owner: number, head: boolean, pos: Vector3) {
    if (!tg.alive) return;
    if (tg.guard) {
      this.events.push({ type: 'guarded', target: tg.id, pos: pos.clone() });
      return;
    }
    tg.hp = Math.max(0, tg.hp - amount);
    const killed = tg.hp <= 0;
    tg.onHit?.(owner, amount);
    if (killed) {
      tg.alive = false;
      if (tg.respawnIn >= 0) tg.respawnIn = DUMMY_RESPAWN;
    }
    this.events.push({ type: 'hit', target: tg.id, owner, damage: amount, head, killed, pos: pos.clone() });
  }

  private explode(p: Projectile) {
    const def = WEAPONS[p.weapon];
    p.alive = false;
    this.events.push({ type: 'explode', pos: p.pos.clone(), radius: def.radius });
    this.noises.push({ pos: p.pos.clone(), radius: NOISE.grenade, owner: p.owner });
    this.onExplosion(p.pos.clone(), def.radius, def.blockDamage);
    for (const tg of this.targets) {
      if (!tg.alive || tg.guard || (tg.team === p.team && tg.id !== p.owner)) continue;
      const d = tg.center.distanceTo(p.pos);
      if (d > def.radius + PLAYER_RADIUS) continue;
      // line of sight: walls protect
      const los = this.rayWorld(p.pos, tg.center);
      if (los && los.t * d < d - 0.6) continue;
      const k = Math.max(0, 1 - Math.max(0, d - PLAYER_RADIUS) / def.radius);
      const mul = tg.id === p.owner ? def.selfMul : 1;
      const dmg = Math.round(def.damage * (0.3 + 0.7 * k) * mul);
      if (tg.onImpulse) {
        const dir = tg.center.clone().sub(p.pos);
        if (dir.lengthSq() < 1e-4) dir.copy(tg.up);
        dir.normalize().addScaledVector(tg.up, 0.35).normalize();
        tg.onImpulse(dir.multiplyScalar(def.knockback * (0.35 + 0.65 * k)));
      }
      this.damage(tg, dmg, p.owner, false, tg.center);
    }
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
    const thick = material && material !== 'metal' ? this.thickness(handle, end, dir) : null;
    this.onWorldDamage(handle, Math.max(1, Math.round(def.blockDamage * energyLeft(def, speed))));
    this.events.push({ type: 'impact', pos: end.clone(), normal: normal.clone(), material: material ?? undefined });
    if (material !== 'wood' && cos < RICOCHET.cos && p.ricochets === 0) {
      p.ricochets++;
      p.vel.addScaledVector(normal, -2 * p.vel.dot(normal)).multiplyScalar(RICOCHET.keep);
      // a little scatter off the surface (deterministic per bullet)
      const j = Math.sin(p.id * 12.9898) * 43758.5453;
      p.vel.addScaledVector(normal, speed * RICOCHET.keep * 0.05 * (j - Math.floor(j)));
      p.pos.copy(end).addScaledVector(normal, 0.02);
      this.events.push({ type: 'ricochet', pos: end.clone(), normal: normal.clone() });
      return;
    }
    if (material && thick !== null) {
      const left = speed - thick * PENETRATION[material];
      if (left > PIERCE_MIN_SPEED) {
        p.vel.multiplyScalar(left / speed);
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
      if (p.weapon === 'grenade' && p.age >= def.fuse) {
        this.explode(p);
        continue;
      }
      if (p.age > def.life || p.pos.length() > this.map.killRadius) {
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
      const th = p.weapon !== 'grenade' ? this.rayTargets(p, _a, _b) : null;
      const tEnd = Math.min(wh ? wh.t : 1, th ? th.t : 1);
      const end = _a.clone().lerp(_b, tEnd);
      if (th && (!wh || th.t <= wh.t)) {
        p.alive = false;
        p.pos.copy(end);
        const energy = energyLeft(def, p.vel.length());
        this.damage(th.target, Math.max(1, Math.round(def.damage * energy * (th.head ? def.headMul : 1))), p.owner, th.head, end);
        continue;
      }
      if (wh) {
        if (p.weapon !== 'grenade') {
          this.bulletHitsWorld(p, end, wh.normal, wh.handle);
          continue;
        }
        // grenade bounce
        const n = wh.normal;
        const vn = p.vel.dot(n);
        p.pos.copy(end).addScaledVector(n, 0.06);
        if (vn < 0) {
          p.vel.addScaledVector(n, -(1 + def.bounce) * vn);
          p.vel.multiplyScalar(0.8);
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
