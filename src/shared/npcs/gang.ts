import { Vector3 } from 'three';
import type { Combat, Target } from '../combat';
import { DEFAULT_MOVEMENT } from '../constants';
import { Rng } from '../math';
import { moveBasis } from '../movement';
import type { PhysicsWorld, Rapier } from '../physics';
import { WeaponId, WEAPONS } from '../weapons';
import { lobDirection, NPC, Npc, NpcEvent } from './types';

const _v = new Vector3();
const _w = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();

export interface GangCombatDeps {
  R: Rapier;
  world: PhysicsWorld;
  combat: Combat;
  rng: Rng;
  events: NpcEvent[];
  getTime: () => number;
  emitShot: (npcId: number, weapon: WeaponId, origin: Vector3, dir: Vector3) => void;
}

/** Armed street-gang combat state machine: telegraphed bursts, melee dash strikes, and lobbed grenades. */
export class GangCombat {
  constructor(private deps: GangCombatDeps) {}

  /**
   * A bandit in a fight: walk up to `range`, then wind up and fire a burst at a locked spot, or wind up and throw a
   * grenade. Lost sight: chase the last seen spot; if the foe ducked behind cover close enough, lob a grenade there.
   */
  fight(n: Npc, foe: Target, eye: Vector3, up: Vector3, dt: number) {
    const G = NPC.gang;
    let goal: Vector3 | null = null, face: Vector3 | null = null, aim: Vector3 | null = null, fire = false;
    const seen = n.lostT === 0;
    const target = seen ? foe.center : n.lastSeen;
    const d = target ? eye.distanceTo(target) : Infinity;
    if (n.fire === 'meleeWindup') {
      n.windT -= dt;
      if (seen) n.aimAt.copy(foe.center);
      face = n.aimAt;
      n.status = 'искра рывка';
      if (n.windT <= 0) {
        this.performMeleeDash(n, up);
        n.fire = 'meleeRecover';
        n.windT = G.meleeRecover;
      }
    } else if (n.fire === 'meleeRecover') {
      n.windT -= dt;
      face = n.aimAt;
      n.status = 'после удара';
      if (n.windT <= 0) {
        n.fire = 'free';
        n.pauseT = 0.6;
        n.meleeT = 4.5;
      }
    } else if (n.fire === 'windup') {
      // standing, the gun up (or the arm back); the aim follows until the lock, then stays
      n.windT -= dt;
      if (n.throwing) face = n.aimAt;
      else {
        if (seen && n.windT > G.lock) n.aimAt.copy(foe.center).addScaledVector(foe.up, 0.2);
        face = n.aimAt;
      }
      if (n.windT <= 0) {
        if (n.throwing) { this.throwGrenade(n, eye, up); n.fire = 'free'; n.throwing = false; n.pauseT = G.burstPause; }
        else n.fire = 'burst';
      }
      n.status = n.throwing ? 'замах гранатой' : 'целится';
    } else if (n.fire === 'burst') {
      face = n.aimAt;
      fire = true;
      aim = n.aimAt.clone();
      n.status = 'стреляет';
    } else if (seen) {
      face = foe.center;
      const s = n.sim.state;
      if (d > G.range) goal = foe.center;
      else if (d < 2.6 && n.meleeT > 0) {
        // Backstep slightly when foe is right in our face so we never get wedged
        _v.copy(s.pos).sub(foe.center).addScaledVector(up, -_v.dot(up));
        if (_v.lengthSq() > 1e-4) _v.normalize();
        else moveBasis(s.frame, s.yaw, _v, _right);
        goal = s.pos.clone().addScaledVector(_v, 2.2);
      } else if (n.pauseT > 0.15 && n.shotsTotal >= 6) {
        // Tactical side-strafe in prolonged firefights to make bandits harder to hit
        moveBasis(s.frame, s.yaw, _fwd, _right);
        const side = Math.sin(this.deps.getTime() * 2.4 + n.id * 1.9) >= 0 ? 1 : -1;
        goal = s.pos.clone().addScaledVector(_right, side * 2.4);
      }
      n.status = 'в бою';
      if (n.seenT > G.reaction && n.pauseT <= 0) {
        if (d <= G.meleeRange && n.meleeT <= 0 && (d < 2.8 || this.deps.rng.chance(G.meleeChance))) {
          n.fire = 'meleeWindup';
          n.windT = G.meleeWindup;
          n.aimAt.copy(foe.center);
          this.deps.events.push({ type: 'meleeSpark', id: n.id, pos: eye.clone() });
        } else {
          const nade = this.canThrow(n, d) && this.deps.rng.chance(G.grenadeChance);
          this.windup(n, nade ? foe.center.clone().addScaledVector(foe.up, -0.7) : foe.center.clone().addScaledVector(foe.up, 0.2), nade, false);
        }
      }
    } else {
      goal = n.lastSeen;
      n.status = 'преследует';
      // ducked behind cover a moment ago, close enough: a grenade over it
      if (n.lastSeen && n.lostT > 0.4 && n.lostT < 3 && n.pauseT <= 0 && this.canThrow(n, d)) {
        this.windup(n, n.lastSeen.clone().addScaledVector(up, -0.7), true, true);
      }
    }
    if (n.fire !== 'free') goal = null; // nobody shoots or throws on the run
    return { goal, face, aim, fire };
  }

  private performMeleeDash(n: Npc, up: Vector3) {
    const G = NPC.gang;
    const s = n.sim.state;
    const startPos = s.pos.clone();
    const dir = _v.copy(n.aimAt).sub(s.pos);
    dir.addScaledVector(up, -dir.dot(up));
    const dist = dir.length();
    if (dist > 1e-4) dir.divideScalar(dist);
    else moveBasis(s.frame, s.yaw, dir, _right);
    const dashDist = Math.min(4.0, Math.max(1.2, dist - 0.8));
    // Raycast against world/props (ignoring character capsules so point-blank targets do not block the dash)
    const wallHit = this.deps.world.castRay(
      new this.deps.R.Ray(s.pos, dir),
      dashDist,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      this.deps.combat.notCharacter,
    );
    const actualDash = wallHit ? Math.max(0, wallHit.timeOfImpact - 0.55) : dashDist;
    if (actualDash > 0.1) {
      s.pos.addScaledVector(dir, actualDash);
      n.sim.mover.place(s);
    }
    s.vel.set(0, 0, 0);
    const strikeCenter = s.pos.clone().addScaledVector(dir, 1.35);
    const knock = dir.clone().multiplyScalar(G.meleeKnockback).addScaledVector(up, G.meleeKnockback * 0.3);
    for (const tg of this.deps.combat.targets) {
      if (!tg.alive || tg.id === n.id || tg.team === n.target.team) continue;
      const r = G.meleeRadius + (tg.radius ?? 0);
      const inStrike = tg.center.distanceTo(strikeCenter) <= r
        || (tg.center.distanceTo(startPos) <= 2.2 && _w.copy(tg.center).sub(startPos).dot(dir) > -0.4);
      if (inStrike) {
        if (tg.onImpulse) tg.onImpulse(knock);
        this.deps.combat.damage(tg, G.meleeDamage, n.id, false, tg.center, { noPush: true, weapon: 'fists' });
      }
    }
    this.deps.events.push({ type: 'meleeStrike', id: n.id, pos: strikeCenter, dir: dir.clone() });
  }

  private canThrow(n: Npc, d: number) {
    const [lo, hi] = NPC.gang.grenadeRange;
    return n.grenades > 0 && n.grenadeT <= 0 && d >= lo && d <= hi;
  }

  private windup(n: Npc, at: Vector3, grenade: boolean, lob: boolean) {
    n.fire = 'windup';
    n.throwing = grenade;
    n.lob = lob;
    n.windT = grenade ? NPC.gang.grenadeWindup : NPC.gang.windup;
    n.aimAt.copy(at);
    n.shots = 0;
    this.deps.events.push({ type: 'windup', id: n.id, pos: n.sim.state.pos.clone(), grenade });
  }

  /**
   * Throw a grenade at `n.aimAt`: an underhand lob at ~45° with just enough speed in the open (it lands soft and
   * does not roll far), a high arc at full speed over cover. Cooked so that it goes off soon after landing.
   */
  private throwGrenade(n: Npc, eye: Vector3, up: Vector3) {
    const g = DEFAULT_MOVEMENT.gravity;
    const rel = _v.copy(n.aimAt).sub(eye);
    const y = rel.dot(up);
    const x = Math.max(0.5, rel.addScaledVector(up, -y).length());
    const v = n.lob ? WEAPONS.grenade.speed : Math.min(WEAPONS.grenade.speed, Math.sqrt(g * (y + Math.hypot(x, y))) * 1.02);
    const dir = lobDirection(eye, n.aimAt, up, v, g, n.lob);
    if (!dir) return;
    n.grenades--;
    n.grenadeT = this.deps.rng.range(...NPC.gang.grenadeEvery);
    n.throwsTotal++;
    const p = this.deps.combat.use('grenade', n.id, eye, dir, n.sim.state.vel, up.clone().negate());
    this.deps.emitShot(n.id, 'grenade', eye, dir);
    if (p) {
      p.vel.copy(dir).multiplyScalar(v).addScaledVector(n.sim.state.vel, WEAPONS.grenade.inherit);
      const flight = x / Math.max(1, v * Math.sqrt(Math.max(0, 1 - dir.dot(up) ** 2)));
      p.age = Math.max(0, Math.min(WEAPONS.grenade.fuse - 0.8, WEAPONS.grenade.fuse - flight - NPC.gang.grenadeAfter));
    }
    this.deps.events.push({ type: 'throw', id: n.id, pos: n.sim.state.pos.clone() });
  }
}
