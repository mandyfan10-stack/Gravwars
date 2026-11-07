import { Quaternion, Vector3 } from 'three';
import { DEFAULT_MOVEMENT, MovementConfig, PLAYER_HEIGHT } from './constants';
import { fieldFor, GravityField } from './gravity';
import type { MapData } from './map';
import { upOf } from './math';
import { createPlayerState, MoveInput, moveBasis, Mover, PlayerState } from './movement';
import type { PhysicsWorld, Rapier } from './physics';
import { getTeam, TeamDef, TeamId } from './teams';

export type RespawnReason = 'void' | 'manual' | 'spawn' | 'killed';

/**
 * Grappling hook: the claw flies out at `fly` m/s up to `range` m; if it bites into something it pulls its owner
 * there at up to `pull` m/s (gravity is held off meanwhile) until they arrive, stop moving, jump, or `maxPull` s pass.
 */
export const HOOK = { range: 30, fly: 110, pull: 24, grip: 7, arrive: 1.1, maxPull: 3, cooldown: 0.5 };

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
  | { type: 'land'; speed: number };

const _up = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
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

  constructor(private R: Rapier, world: PhysicsWorld, readonly map: MapData, teamId: TeamId,
    readonly cfg: MovementConfig = { ...DEFAULT_MOVEMENT }) {
    this.team = getTeam(teamId);
    this.mover = new Mover(R, world, cfg);
    this.gravity = fieldFor(map);
    this.respawn('spawn');
  }

  respawn(reason: RespawnReason = 'manual') {
    const sp = this.map.spawns[this.team.id];
    const s = this.state;
    s.pos.set(...sp.pos);
    s.vel.set(0, 0, 0);
    s.frame.set(...sp.quat);
    s.yaw = sp.yaw;
    s.pitch = 0;
    s.onGround = false;
    s.airT = -1;
    this.mover.place(s);
    this.hook = null;
    this.events.push({ type: 'respawn', reason });
  }

  /**
   * Throw the grappling hook from `eye` along `dir`. `filter`: colliders it may bite (default: anything but this
   * body). False while one is out or cooling down.
   */
  throwHook(eye: Vector3, dir: Vector3, filter?: (c: { handle: number }) => boolean): boolean {
    if (this.hook || this.hookCd > 0) return false;
    const d = dir.clone().normalize();
    const hit = this.mover.world.castRay(new this.R.Ray(eye, d), HOOK.range, true, undefined, undefined, this.mover.collider, undefined, filter);
    const dist = hit ? hit.timeOfImpact : HOOK.range;
    this.hook = {
      anchor: eye.clone().addScaledVector(d, dist), from: eye.clone(), dist, phase: 'fly', miss: !hit, t: 0, best: Infinity, still: 0,
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
    // there (or as close as the wall lets): keep a little of the speed, the rest is caught by the arms
    if (d < HOOK.arrive || h.still > 0.35 || h.t > HOOK.maxPull || (input.jump && h.t > 0.2)) {
      if (d < HOOK.arrive || h.still > 0.35) s.vel.multiplyScalar(0.35);
      this.releaseHook();
      return;
    }
    // ease into full speed, slow down over the last metres
    const speed = HOOK.pull * Math.min(1, 0.35 + h.t * 2.5) * Math.min(1, 0.35 + d / 4);
    to.divideScalar(d).multiplyScalar(speed);
    s.vel.lerp(to, Math.min(1, HOOK.grip * dt));
    // off the ground, and gravity is cancelled for this tick (the mover adds it back)
    s.vel.addScaledVector(up, this.cfg.gravity * dt);
    s.onGround = false;
    s.airT = -1;
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
    // turned onto a new surface: the rope has done its job
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
    return Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) > this.map.cube.half + this.map.voidMargin;
  }

  gravityDown(out = new Vector3()): Vector3 {
    return upOf(this.state.frame, out).negate();
  }

  tick(input: MoveInput, dt: number) {
    const s = this.state;
    const wasGround = s.onGround;
    this.hookTick(input, dt);
    // the rope lowers you: no fall damage at the end of a pull
    const roped = this.hook?.phase === 'pull';
    const fall = roped ? Math.min(-s.vel.dot(upOf(s.frame, _up)), 8) : -s.vel.dot(upOf(s.frame, _up));
    this.mover.step(s, input, dt);
    if (s.noclip) return;
    const up = upOf(s.frame, _up);
    if (s.onGround && !wasGround && fall > 3) this.events.push({ type: 'land', speed: fall });

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
