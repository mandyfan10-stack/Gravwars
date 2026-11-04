import { Vector3 } from 'three';
import { DEFAULT_MOVEMENT, PLAYER_HALF_SEGMENT, PLAYER_RADIUS } from './constants';
import type { MapData } from './map';
import type { PhysicsWorld, Rapier } from './physics';
import { crossesPortal, PortalRuntime } from './portals';
import type { TeamId } from './teams';
import { WeaponId, WEAPONS } from './weapons';
import { Wind } from './wind';

/** Anything that can be shot: a capsule standing along `up`. */
export interface Target {
  id: number;
  team: TeamId;
  center: Vector3;
  up: Vector3;
  hp: number;
  alive: boolean;
  /** Seconds until an auto-respawn (dummies). < 0 = handled by the owner (players). */
  respawnIn: number;
  onImpulse?: (v: Vector3) => void;
}

export interface Projectile {
  id: number;
  weapon: WeaponId;
  owner: number;
  /** No friendly fire: projectiles ignore the shooter's teammates (but grenades still hurt the shooter). */
  team: TeamId | null;
  pos: Vector3;
  vel: Vector3;
  /** Gravity direction of the shooter at fire time. */
  down: Vector3;
  age: number;
  resting: boolean;
  alive: boolean;
}

export type CombatEvent =
  | { type: 'fire'; weapon: WeaponId; owner: number; origin: Vector3; dir: Vector3; projectile: number }
  | { type: 'impact'; pos: Vector3; normal: Vector3 }
  | { type: 'bounce'; pos: Vector3; speed: number }
  | { type: 'fizzle'; pos: Vector3 }
  | { type: 'explode'; pos: Vector3; radius: number }
  | { type: 'hit'; target: number; owner: number; damage: number; head: boolean; killed: boolean; pos: Vector3 };

export const MAX_HP = 100;
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
  time = 0;
  /** Global wind multiplier (0 = calm; debug / tests). */
  windMul = 1;
  private nextId = 1;
  onWorldDamage: (handle: number, damage: number) => void = () => {};
  onExplosion: (pos: Vector3, radius: number, damage: number) => void = () => {};

  constructor(private R: Rapier, private world: PhysicsWorld, private map: MapData, private portals: PortalRuntime[],
    /** Character-controller colliders to ignore (projectiles test player capsules analytically). */
    private ignore: unknown[] = [], windSeed = 2024) {
    this.wind = new Wind(windSeed);
  }

  target(id: number) {
    return this.targets.find((t) => t.id === id);
  }

  fire(weapon: WeaponId, owner: number, origin: Vector3, dir: Vector3, ownerVel: Vector3, down: Vector3) {
    const def = WEAPONS[weapon];
    const p: Projectile = {
      id: this.nextId++, weapon, owner, team: this.target(owner)?.team ?? null, pos: origin.clone(),
      vel: dir.clone().normalize().multiplyScalar(def.speed).addScaledVector(ownerVel, def.inherit),
      down: down.clone().normalize(), age: 0, resting: false, alive: true,
    };
    this.projectiles.push(p);
    this.events.push({ type: 'fire', weapon, owner, origin: origin.clone(), dir: dir.clone(), projectile: p.id });
    return p;
  }

  private rayWorld(from: Vector3, to: Vector3) {
    const d = _seg.copy(to).sub(from);
    const len = d.length();
    if (len < 1e-6) return null;
    d.divideScalar(len);
    const ray = new this.R.Ray(from, d);
    const ex = this.ignore[0] as Parameters<PhysicsWorld['castRayAndGetNormal']>[5];
    const hit = this.world.castRayAndGetNormal(ray, len, true, undefined, undefined, ex);
    if (!hit) return null;
    return { t: hit.timeOfImpact / len, normal: new Vector3(hit.normal.x, hit.normal.y, hit.normal.z), handle: hit.collider.handle };
  }

  private rayTargets(p: Projectile, from: Vector3, to: Vector3) {
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
    tg.hp = Math.max(0, tg.hp - amount);
    const killed = tg.hp <= 0;
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
    this.onExplosion(p.pos.clone(), def.radius, def.damage);
    for (const tg of this.targets) {
      if (!tg.alive || (tg.team === p.team && tg.id !== p.owner)) continue;
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

  tick(dt: number) {
    this.time += dt;
    for (const tg of this.targets) {
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
      _acc.add(this.wind.felt(this.time, p.down, _wind).multiplyScalar(def.windScale * this.windMul));
      p.vel.addScaledVector(_acc, dt);
      _a.copy(p.pos);
      _b.copy(p.pos).addScaledVector(p.vel, dt);

      const wh = this.rayWorld(_a, _b);
      const th = p.weapon === 'rifle' ? this.rayTargets(p, _a, _b) : null;
      const tEnd = Math.min(wh ? wh.t : 1, th ? th.t : 1);
      const end = _a.clone().lerp(_b, tEnd);
      // v1: portals swallow projectiles
      if (this.portals.some((pt) => crossesPortal(pt, _a, end))) {
        p.alive = false;
        this.events.push({ type: 'fizzle', pos: end });
        continue;
      }
      if (th && (!wh || th.t <= wh.t)) {
        p.alive = false;
        p.pos.copy(end);
        this.damage(th.target, Math.round(def.damage * (th.head ? def.headMul : 1)), p.owner, th.head, end);
        continue;
      }
      if (wh) {
        if (p.weapon === 'rifle') {
          p.alive = false;
          p.pos.copy(end);
          this.onWorldDamage(wh.handle, def.damage);
          this.events.push({ type: 'impact', pos: end, normal: wh.normal });
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
    // forget dead projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) if (!this.projectiles[i].alive) this.projectiles.splice(i, 1);
  }
}
