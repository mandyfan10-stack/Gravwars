import { Quaternion, Vector3 } from 'three';
import { DEFAULT_MOVEMENT, MovementConfig, PLAYER_HEIGHT } from './constants';
import { fieldFor, GravityField } from './gravity';
import type { MapData } from './map';
import { upOf } from './math';
import { createPlayerState, MoveInput, moveBasis, Mover, PlayerState, viewQuat } from './movement';
import type { PhysicsWorld, Rapier } from './physics';
import { getTeam, TeamDef, TeamId } from './teams';

export type RespawnReason = 'void' | 'manual' | 'spawn' | 'killed';

/**
 * Grappling hook: the claw flies out at `fly` m/s up to `range` m (35 m), magnetizing to surfaces within `magnet` m (0.25 m);
 * when it attaches it gives an immediate pull impulse and pulls its owner there at up to `pull` m/s.
 */
export const HOOK = { range: 35, magnet: 0.25, fly: 110, pull: 24, grip: 7, arrive: 1.1, maxPull: 3, cooldown: 0.5 };

/**
 * Jetpack: holding Space while airborne flies toward camera look direction + a share of movement velocity.
 * After `maxFlight` (12 s) of continuous flight it overheats and explodes (self: 50% max HP, others: 50 HP),
 * but is not destroyed. Uses ammo as fuel (1 round every `fuelInterval` s).
 */
export const JETPACK = {
  maxFlight: 12,
  coolRate: 1.8,
  speed: 15.5,
  accel: 10,
  lookWeight: 0.82,
  moveWeight: 0.35,
  fuelInterval: 0.25,
  explodeRadius: 5.5,
  explodeDamageOther: 50,
  explodeSelfFrac: 0.5,
  overheatCooldown: 3.5,
};

export interface HookState {
  /** Where the claw bit (or where it gives up, for a miss). */
  anchor: Vector3;
  /** Where it was thrown from (the rope's other end while it flies). */
  from: Vector3;
  dist: number;
  /** fly → pull (bit) or back (missed: it comes back empty). */
  phase: 'fly' | 'pull' | 'back';
  miss: boolean;
  t: number;
  /** Pull progress check: best distance so far and time since it got better. */
  best: number;
  still: number;
}

export type SimEvent =
  | { type: 'gravity' }
  /** Grappling hook: the claw bit / found nothing / the pull ended. */
  | { type: 'hook'; what: 'attach' | 'miss' | 'release' }
  | { type: 'respawn'; reason: RespawnReason }
  | { type: 'launch' }
  /** Touched the ground after falling at `speed` m/s (fall damage, landing thud). */
  | { type: 'land'; speed: number }
  /** Landed in water (pond / river / fountain): splash effect and zero fall damage. */
  | { type: 'splash'; pos: Vector3; speed: number }
  /** Jetpack consumed 1 unit of ammo fuel. */
  | { type: 'jetpackFuel' }
  /** Jetpack overheated after 12 s of flight and exploded. */
  | { type: 'jetpackExplode'; pos: Vector3 };

const _up = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _look = new Vector3();
const _wish = new Vector3();
const _q = new Quaternion();
const _n = new Vector3();
/** After a switch the body is put this far above the new surface (capsule half height + a short drop). */
const SWITCH_CLEARANCE = PLAYER_HEIGHT / 2 + 0.2;
const _to = new Vector3();

/**
 * Authoritative player simulation (movement + world rules). Runs on the client for prediction
 * and will run unchanged on the server.
 */
export class PlayerSim {
  readonly state: PlayerState = createPlayerState();
  readonly mover: Mover;
  readonly events: SimEvent[] = [];
  readonly gravity: GravityField;
  team: TeamDef;
  /** Gravity follows the surface you step onto (gravity.ts). NPCs stay in the gravity they were made in. */
  surfaces = true;
  /** Grappling hook in flight / pulling, and the time until it can be thrown again. */
  hook: HookState | null = null;
  hookCd = 0;

  /** Jetpack ownership & fuel flags (updated by the owner each tick). */
  hasJetpack = false;
  hasJetpackFuel = false;
  /** True while the jetpack thrusters are firing this tick. */
  jetpackActive = false;
  /** Seconds of continuous flight accumulated (0..JETPACK.maxFlight). */
  jetpackHeat = 0;
  /** Cooldown remaining after an overheat explosion, s. */
  jetpackOverheatCd = 0;
  private jetpackFuelT = 0;
  /** Rotating spawn angle so team members spawn in a circle around their crystal. */
  spawnSlot = 0;
  private spawnCount = 0;

  constructor(private R: Rapier, world: PhysicsWorld, readonly map: MapData, teamId: TeamId,
    readonly cfg: MovementConfig = { ...DEFAULT_MOVEMENT }) {
    this.team = getTeam(teamId);
    this.mover = new Mover(R, world, cfg);
    this.gravity = fieldFor(map);
    this.respawn('spawn');
  }

  /** Spawn on a ring around the team's crystal inside the base hall. */
  respawn(reason: RespawnReason = 'manual', angleOverride?: number) {
    const sp = this.map.spawns[this.team.id] ?? Object.values(this.map.spawns)[0];
    const statue = this.map.statues.find((st) => st.team === this.team.id);
    const s = this.state;
    s.frame.set(...sp.quat);
    if (statue) {
      // Spawn in a ring of radius 3.4 m around the crystal at floor height
      const angle = angleOverride !== undefined
        ? angleOverride
        : (this.spawnSlot * 1.2566 + this.spawnCount * 2.39996) % (Math.PI * 2);
      this.spawnCount++;
      const radius = 3.4;
      const bedPos = new Vector3(...statue.bed);
      const spPos = new Vector3(...sp.pos);
      const up = upOf(s.frame, _up);
      // Keep the exact spawn height above floor from sp.pos, centered around bedPos horizontally
      const hDiff = spPos.clone().sub(bedPos).dot(up);
      const offset = new Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius).applyQuaternion(s.frame);
      s.pos.copy(bedPos).addScaledVector(up, hDiff).add(offset);
      s.yaw = sp.yaw;
    } else {
      s.pos.set(...sp.pos);
      s.yaw = sp.yaw;
    }
    s.vel.set(0, 0, 0);
    s.pitch = 0;
    s.onGround = false;
    s.airT = -1;
    this.mover.place(s);
    this.hook = null;
    this.jetpackActive = false;
    this.jetpackHeat = 0;
    this.jetpackOverheatCd = 0;
    this.events.push({ type: 'respawn', reason });
  }

  /** Is `pos` inside any pond / river / fountain water volume? */
  inWater(pos = this.state.pos): boolean {
    for (const p of this.map.ponds) {
      const rel = _to.copy(pos).sub(new Vector3(...p.pos)).applyQuaternion(_q.set(...p.quat).invert());
      if (Math.abs(rel.x) <= p.half[0] + 0.25 && Math.abs(rel.z) <= p.half[1] + 0.25 && Math.abs(rel.y) <= 2.1) {
        return true;
      }
    }
    return false;
  }

  /**
   * Throw the grappling hook from `eye` along `dir`. `filter`: colliders it may bite (default: anything but this
   * body). False while one is out or cooling down.
   */
  throwHook(eye: Vector3, dir: Vector3, filter?: (c: { handle: number }) => boolean): boolean {
    if (this.hook || this.hookCd > 0) return false;
    const d = dir.clone().normalize();
    let hit = this.mover.world.castRay(new this.R.Ray(eye, d), HOOK.range, true, undefined, undefined, this.mover.collider, undefined, filter);
    let anchorPos: Vector3 | null = hit ? eye.clone().addScaledVector(d, hit.timeOfImpact) : null;
    let dist = hit ? hit.timeOfImpact : HOOK.range;
    // 0.25 m surface magnetism around the hook path when the direct line misses a nearby edge/surface
    if (!hit) {
      const u = new Vector3(Math.abs(d.y) < 0.9 ? 0 : 1, Math.abs(d.y) < 0.9 ? 1 : 0, 0).cross(d).normalize();
      const v = new Vector3().crossVectors(d, u);
      let bestToi = Infinity;
      for (const r of [HOOK.magnet * 0.5, HOOK.magnet]) {
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const orig = eye.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r);
          const h = this.mover.world.castRay(new this.R.Ray(orig, d), HOOK.range, true, undefined, undefined, this.mover.collider, undefined, filter);
          if (h && h.timeOfImpact > 0.4 && h.timeOfImpact < bestToi) {
            bestToi = h.timeOfImpact;
            hit = h;
            anchorPos = orig.addScaledVector(d, h.timeOfImpact);
            dist = bestToi;
          }
        }
        if (hit) break;
      }
    }
    this.hook = {
      anchor: anchorPos ?? eye.clone().addScaledVector(d, dist), from: eye.clone(), dist, phase: 'fly', miss: !hit, t: 0, best: Infinity, still: 0,
    };
    this.hookCd = HOOK.cooldown;
    return true;
  }

  /** Let go of the rope (LMB again, a jump, arrived). */
  releaseHook() {
    if (this.hook?.phase !== 'pull') return;
    this.hook = null;
    this.events.push({ type: 'hook', what: 'release' });
  }

  /** The hook's part of a tick, before the movement: the claw flies, or the rope pulls (velocity steered to it). */
  private hookTick(input: MoveInput, dt: number) {
    const h = this.hook;
    this.hookCd = Math.max(0, this.hookCd - dt);
    if (!h) return;
    h.t += dt;
    if (h.phase === 'fly') {
      if (h.t * HOOK.fly < h.dist) return;
      h.phase = h.miss ? 'back' : 'pull';
      h.t = 0;
      this.events.push({ type: 'hook', what: h.miss ? 'miss' : 'attach' });
      if (!h.miss) {
        const s = this.state;
        const up = upOf(s.frame, _up);
        const pullDir = _to.copy(h.anchor).sub(s.pos);
        if (pullDir.lengthSq() > 1e-4) {
          pullDir.normalize();
          const boost = Math.max(s.vel.dot(pullDir), HOOK.pull * 0.72);
          s.vel.addScaledVector(pullDir, boost - s.vel.dot(pullDir));
          if (s.onGround) {
            s.vel.addScaledVector(up, 2.2);
            s.onGround = false;
            s.airT = -1;
          }
        }
      }
      return;
    }
    if (h.phase === 'back') {
      if (h.t * HOOK.fly * 1.5 >= h.dist) this.hook = null;
      return;
    }
    const s = this.state;
    const up = upOf(s.frame, _up);
    const to = _to.copy(h.anchor).sub(s.pos);
    const d = to.length();
    if (d < h.best - 0.3) { h.best = d; h.still = 0; } else h.still += dt;
    if (d < HOOK.arrive || h.still > 0.35 || h.t > HOOK.maxPull || (input.jump && h.t > 0.2)) {
      if (d < HOOK.arrive || h.still > 0.35) s.vel.multiplyScalar(0.35);
      this.releaseHook();
      return;
    }
    const speed = HOOK.pull * Math.min(1, 0.35 + h.t * 2.5) * Math.min(1, 0.35 + d / 4);
    to.divideScalar(d).multiplyScalar(speed);
    s.vel.lerp(to, Math.min(1, HOOK.grip * dt));
    s.vel.addScaledVector(up, this.cfg.gravity * dt);
    s.onGround = false;
    s.airT = -1;
  }

  /** Jetpack flight logic when holding Space in the air. */
  private jetpackTick(input: MoveInput, dt: number) {
    const s = this.state;
    this.jetpackOverheatCd = Math.max(0, this.jetpackOverheatCd - dt);
    const canFly = this.hasJetpack
      && this.hasJetpackFuel
      && this.jetpackOverheatCd <= 0
      && !s.onGround
      && !s.noclip
      && this.hook?.phase !== 'pull'
      && input.jump
      && s.jumpHold <= 0.12;

    if (canFly) {
      this.jetpackActive = true;
      const up = upOf(s.frame, _up);
      viewQuat(s.frame, input.yaw, input.pitch, _q);
      _look.set(0, 0, -1).applyQuaternion(_q);
      moveBasis(s.frame, input.yaw, _fwd, _right);
      _wish.set(0, 0, 0).addScaledVector(_fwd, input.forward).addScaledVector(_right, input.right);
      if (_wish.lengthSq() > 1e-4) _wish.normalize();

      // Combine camera look direction + a share of movement direction + slight upward lift
      const flyDir = _to.copy(_look).multiplyScalar(JETPACK.lookWeight)
        .addScaledVector(_wish, JETPACK.moveWeight)
        .addScaledVector(up, 0.22);
      if (flyDir.lengthSq() > 1e-4) flyDir.normalize();
      const targetVel = flyDir.multiplyScalar(JETPACK.speed);
      s.vel.lerp(targetVel, Math.min(1, JETPACK.accel * dt));
      // Counteract gravity while jetpack thrusters are active
      s.vel.addScaledVector(up, this.cfg.gravity * dt);
      s.jumpHold = 0;

      // Consume fuel (ammo)
      this.jetpackFuelT += dt;
      if (this.jetpackFuelT >= JETPACK.fuelInterval) {
        this.jetpackFuelT -= JETPACK.fuelInterval;
        this.events.push({ type: 'jetpackFuel' });
      }

      // Accumulate heat; explode after 12 seconds of flight
      this.jetpackHeat += dt;
      if (this.jetpackHeat >= JETPACK.maxFlight) {
        this.jetpackHeat = 0;
        this.jetpackActive = false;
        this.jetpackOverheatCd = JETPACK.overheatCooldown;
        this.events.push({ type: 'jetpackExplode', pos: s.pos.clone() });
      }
    } else {
      this.jetpackActive = false;
      this.jetpackFuelT = 0;
      if (this.jetpackHeat > 0) {
        this.jetpackHeat = Math.max(0, this.jetpackHeat - JETPACK.coolRate * dt);
      }
    }
  }

  /** Rotate the body so that its up becomes -down. 180° flips roll around the view direction. */
  setGravity(down: Vector3) {
    const s = this.state;
    const oldUp = upOf(s.frame, _up);
    const newUp = down.clone().negate().normalize();
    const d = oldUp.dot(newUp);
    if (d > 0.999) return;
    if (d < -0.999) {
      moveBasis(s.frame, s.yaw, _fwd, _right);
      _q.setFromAxisAngle(_fwd, Math.PI);
    } else {
      _q.setFromUnitVectors(oldUp, newUp);
    }
    s.frame.premultiply(_q).normalize();
    s.onGround = false;
    this.mover.place(s);
    if (this.hook?.phase === 'pull') this.releaseHook();
    this.events.push({ type: 'gravity' });
  }

  /** Explosion knockback etc. Leaves the ground so the push is not eaten by friction. */
  applyImpulse(v: Vector3) {
    const s = this.state;
    if (s.noclip) return;
    s.vel.add(v);
    s.onGround = false;
  }

  /** Fallen out of the cube: further than the void margin outside it on some axis. */
  outside(p = this.state.pos) {
    const hx = this.map.cube.half + this.map.voidMargin;
    const hy = (this.map.cube.halfY ?? this.map.cube.half) + this.map.voidMargin;
    return Math.abs(p.x) > hx || Math.abs(p.z) > hx || Math.abs(p.y) > hy;
  }

  gravityDown(out = new Vector3()): Vector3 {
    return upOf(this.state.frame, out).negate();
  }

  tick(input: MoveInput, dt: number) {
    const s = this.state;
    const wasGround = s.onGround;
    this.hookTick(input, dt);
    this.jetpackTick(input, dt);
    // the rope or jetpack lowers you: no fall damage at the end of a pull
    const roped = this.hook?.phase === 'pull' || this.jetpackActive;
    const fall = roped ? Math.min(-s.vel.dot(upOf(s.frame, _up)), 8) : -s.vel.dot(upOf(s.frame, _up));
    this.mover.step(s, input, dt);
    if (s.noclip) return;
    const up = upOf(s.frame, _up);
    if (s.onGround && !wasGround && fall > 3) {
      if (this.inWater(s.pos)) {
        this.events.push({ type: 'splash', pos: s.pos.clone(), speed: fall });
      } else {
        this.events.push({ type: 'land', speed: fall });
      }
    }

    // walked onto a surface of another gravity (bridge stub, built floor): turn onto it
    if (this.surfaces) {
      const pull = this.gravity.pull(s.pos, up);
      if (pull) {
        const n = _n.copy(pull.plate.up);
        if (pull.h < SWITCH_CLEARANCE) s.pos.addScaledVector(n, SWITCH_CLEARANCE - pull.h);
        const into = s.vel.dot(n);
        if (into < 0) s.vel.addScaledVector(n, -into);
        this.setGravity(n.negate());
        s.airT = -1;
        return;
      }
    }

    // the void: out through a gap at a cube edge (or off the rim and down past the face)
    if (this.outside()) this.respawn('void');
  }
}
