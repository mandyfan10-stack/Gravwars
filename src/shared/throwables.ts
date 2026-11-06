import { Vector3 } from 'three';
import type { Combat, Faction } from './combat';
import { DEFAULT_MOVEMENT } from './constants';
import type { ItemId, Pickups } from './economy';

export const THROW = {
  /** Release speed, m/s, plus this share of the thrower's own velocity. */
  speed: 15,
  inherit: 0.6,
  /** A bottle breaks on whatever it hits: a little damage, and an NPC stands dazed for `stun` s. */
  bottleDamage: 4,
  stun: 2,
  /** Anything else just bumps a person (no harm, but they notice). */
  bumpDamage: 0,
  /** Gone if it flies longer than this (off the island into the void). */
  life: 6,
  /** Seconds between two throws. */
  interval: 0.45,
};

export interface Thrown {
  id: number;
  kind: ItemId;
  owner: number;
  team: Faction | null;
  pos: Vector3;
  vel: Vector3;
  /** Gravity of the thrower when it left the hand. */
  down: Vector3;
  age: number;
  /** Spin for the view, rad/s. */
  spin: number;
  alive: boolean;
}

export type ThrowEvent =
  | { type: 'throw'; kind: ItemId; owner: number }
  /** A bottle broke (`target`: who it hit, null = a wall / the ground). */
  | { type: 'shatter'; pos: Vector3; target: number | null; stunned: boolean }
  /** Landed and lies there as a pickup (or bounced off something). */
  | { type: 'land'; kind: ItemId; pos: Vector3 }
  | { type: 'bump'; pos: Vector3; target: number };

const _a = new Vector3();
const _b = new Vector3();

/**
 * Items thrown by hand (G, or LMB with a bottle): they fly on the thrower's gravity, a bottle breaks on impact
 * (and stuns an NPC), everything else lands and can be picked up again.
 */
export class Throws {
  readonly items: Thrown[] = [];
  readonly events: ThrowEvent[] = [];
  private nextId = 1;

  constructor(private combat: Combat, private pickups: Pickups) {}

  throw(kind: ItemId, owner: number, eye: Vector3, dir: Vector3, ownerVel: Vector3, down: Vector3): Thrown {
    const up = down.clone().negate();
    // aim a touch above the crosshair: a lob, not a laser
    const v = dir.clone().normalize().addScaledVector(up, 0.12).normalize().multiplyScalar(THROW.speed).addScaledVector(ownerVel, THROW.inherit);
    const t: Thrown = {
      id: this.nextId++, kind, owner, team: this.combat.target(owner)?.team ?? null, pos: eye.clone().addScaledVector(dir, 0.4), vel: v,
      down: down.clone().normalize(), age: 0, spin: 8 + Math.random() * 6, alive: true,
    };
    this.items.push(t);
    this.events.push({ type: 'throw', kind, owner });
    return t;
  }

  tick(dt: number) {
    for (const t of this.items) {
      if (!t.alive) continue;
      t.age += dt;
      if (t.age > THROW.life) { t.alive = false; continue; }
      t.vel.addScaledVector(t.down, DEFAULT_MOVEMENT.gravity * dt);
      _a.copy(t.pos);
      _b.copy(t.pos).addScaledVector(t.vel, dt);
      const wh = this.combat.rayWorld(_a, _b);
      const th = this.combat.rayTargets(t, _a, _b);
      if (th && (!wh || th.t <= wh.t)) {
        const pos = _a.clone().lerp(_b, th.t);
        const tg = th.target;
        if (t.kind === 'bottle') {
          t.alive = false;
          const stunned = !!tg.npc && !tg.guard;
          if (stunned) tg.stun = THROW.stun;
          this.combat.damage(tg, THROW.bottleDamage, t.owner, th.head, pos);
          this.events.push({ type: 'shatter', pos, target: tg.id, stunned });
          continue;
        }
        // soft things bounce off a person and fall down
        if (THROW.bumpDamage) this.combat.damage(tg, THROW.bumpDamage, t.owner, false, pos);
        else tg.onHit?.(t.owner, 0);
        this.events.push({ type: 'bump', pos, target: tg.id });
        t.pos.copy(pos);
        t.vel.multiplyScalar(-0.25);
        t.owner = -1; // can fall on the thrower now
        t.team = null;
        continue;
      }
      if (wh) {
        const pos = _a.clone().lerp(_b, wh.t);
        if (t.kind === 'bottle') {
          t.alive = false;
          this.events.push({ type: 'shatter', pos, target: null, stunned: false });
          continue;
        }
        const n = wh.normal;
        // a floor for its gravity: it stays there as a pickup
        if (n.dot(t.down) < -0.6) {
          t.alive = false;
          const up = t.down.clone().negate();
          const it = this.pickups.drop(t.kind, pos.clone().addScaledVector(up, 0.3), up, 1);
          if (it) this.events.push({ type: 'land', kind: t.kind, pos: it.pos.clone() });
          continue;
        }
        // a wall: bounce back, slower
        const vn = t.vel.dot(n);
        t.pos.copy(pos).addScaledVector(n, 0.05);
        if (vn < 0) t.vel.addScaledVector(n, -1.4 * vn).multiplyScalar(0.6);
        continue;
      }
      t.pos.copy(_b);
    }
    for (let i = this.items.length - 1; i >= 0; i--) if (!this.items[i].alive) this.items.splice(i, 1);
  }
}
