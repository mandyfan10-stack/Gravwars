import { Quaternion, Vector3 } from 'three';
import { MovementConfig, PLAYER_HALF_SEGMENT, PLAYER_RADIUS } from './constants';
import { upOf } from './math';
import type { PhysicsWorld, Rapier } from './physics';

/** Quiet walk speed, share of maxSpeed (Source / CS: ~0.52). */
export const WALK_SPEED = 0.45;
/** Crouched speed, share of maxSpeed (CS: 0.34). */
export const CROUCH_SPEED = 0.34;
/** Sprint (Shift) speed, share of maxSpeed. */
export const SPRINT_SPEED = 1.65;
/** Sprint stamina: seconds of sprinting when full; refills at REGEN per second after REGEN_DELAY s of rest. */
export const STAMINA = { max: 8, regen: 1.6, regenDelay: 1, /** an empty bar lets you sprint again from this much */ restart: 1.5 };
/** A jump still works this long after running off an edge, s. */
export const COYOTE_TIME = 0.1;
/**
 * Hold-to-extend jump: a tap jumps ~1.3 m; holding Space keeps gravity at `gravityMul` while rising for up to `time` s,
 * which lifts the feet ~3.2 m: enough to climb onto a piece one build level (3 m) higher.
 */
export const JUMP_HOLD = { time: 0.38, gravityMul: 0.2 };
/**
 * Wall slide: falling while pushing into a wall brakes the fall to `speed` m/s (the old "stuck in the wall" bug as a
 * mechanic): slide down a building instead of breaking your legs. `grip` = how fast the fall speed is braked, 1/s.
 */
export const WALL_SLIDE = { speed: 3, grip: 30 };

export interface PlayerState {
  pos: Vector3;
  vel: Vector3;
  /** Body frame: local +Y = up (opposite of the player's gravity). */
  frame: Quaternion;
  /** View angles, local to the body frame. */
  yaw: number;
  pitch: number;
  onGround: boolean;
  groundNormal: Vector3;
  jumpReleased: boolean;
  noclip: boolean;
  /** Time since the feet left the ground without a jump (coyote jump), s; -1 = jumped / not applicable. */
  airT: number;
  /** Crouching this tick (slower, quieter, steadier aim, lower eye). */
  crouched: boolean;
  /** Sprinting this tick (Shift, forward, on the ground or mid-jump). */
  sprinting: boolean;
  /** Sprint stamina left, s (STAMINA.max when full). */
  stamina: number;
  /** Ran dry: no sprint until the bar refills to STAMINA.restart. */
  exhausted: boolean;
  /** Time since the last sprint, s (regen starts after STAMINA.regenDelay). */
  restT: number;
  /** Jump extension left while Space stays held, s (JUMP_HOLD). */
  jumpHold: number;
  /** Airborne and pushing into a wall: the fall is braked (WALL_SLIDE). */
  wallSlide: boolean;
  /** Wall normal of the last wall touched in the air (world), for the slide check. */
  wallNormal: Vector3;
}

export interface MoveInput {
  forward: number;
  right: number;
  /** noclip only: +1 up, -1 down */
  up: number;
  jump: boolean;
  /** Sprint (Shift): faster forward running while there is stamina. */
  sprint: boolean;
  /** Quiet walk: slower on the ground and silent for NPCs (not bound for players at the moment). */
  walk: boolean;
  /** Crouch (Ctrl / C): slower still, silent, lower eye. */
  crouch: boolean;
  yaw: number;
  pitch: number;
}

export function createPlayerState(): PlayerState {
  return {
    pos: new Vector3(), vel: new Vector3(), frame: new Quaternion(), yaw: 0, pitch: 0,
    onGround: false, groundNormal: new Vector3(0, 1, 0), jumpReleased: true, noclip: false, airT: -1, crouched: false,
    sprinting: false, stamina: STAMINA.max, exhausted: false, restT: 0, jumpHold: 0, wallSlide: false, wallNormal: new Vector3(),
  };
}

export function emptyInput(): MoveInput {
  return { forward: 0, right: 0, up: 0, jump: false, sprint: false, walk: false, crouch: false, yaw: 0, pitch: 0 };
}

const AY = new Vector3(0, 1, 0);
const AX = new Vector3(1, 0, 0);
const _yawQ = new Quaternion();
const _pitchQ = new Quaternion();

/** Forward / right on the movement plane (no pitch), world space. */
export function moveBasis(frame: Quaternion, yaw: number, fwd: Vector3, right: Vector3) {
  _yawQ.setFromAxisAngle(AY, yaw);
  fwd.set(0, 0, -1).applyQuaternion(_yawQ).applyQuaternion(frame);
  right.set(1, 0, 0).applyQuaternion(_yawQ).applyQuaternion(frame);
}

/** Full view rotation (frame · yaw · pitch). */
export function viewQuat(frame: Quaternion, yaw: number, pitch: number, out = new Quaternion()) {
  _yawQ.setFromAxisAngle(AY, yaw);
  _pitchQ.setFromAxisAngle(AX, pitch);
  return out.copy(frame).multiply(_yawQ).multiply(_pitchQ);
}

// --- Source movement primitives -------------------------------------------------------------

function friction(vel: Vector3, cfg: MovementConfig, dt: number) {
  const speed = vel.length();
  if (speed < 0.01) {
    vel.set(0, 0, 0);
    return;
  }
  const control = Math.max(speed, cfg.stopSpeed);
  const drop = control * cfg.friction * dt;
  vel.multiplyScalar(Math.max(speed - drop, 0) / speed);
}

function accelerate(vel: Vector3, wishDir: Vector3, wishSpeed: number, accel: number, dt: number) {
  if (wishSpeed <= 0) return;
  const add = wishSpeed - vel.dot(wishDir);
  if (add <= 0) return;
  vel.addScaledVector(wishDir, Math.min(accel * dt * wishSpeed, add));
}

function airAccelerate(vel: Vector3, wishDir: Vector3, wishSpeed: number, accel: number, cap: number, dt: number) {
  if (wishSpeed <= 0) return;
  const add = Math.min(wishSpeed, cap) - vel.dot(wishDir);
  if (add <= 0) return;
  vel.addScaledVector(wishDir, Math.min(accel * wishSpeed * dt, add));
}

const _up = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _wish = new Vector3();
const _delta = new Vector3();
const _moved = new Vector3();
const _step = new Vector3();
const _p1 = new Vector3();
const _n = new Vector3();
const _view = new Quaternion();

/**
 * Source-style player movement with an arbitrary (axis-aligned) gravity.
 * All math happens in the player's body frame: up = -gravity.
 * Collision / sliding / stepping is delegated to Rapier's kinematic character controller.
 */
export class Mover {
  readonly collider;
  readonly kcc;
  /** The last move touched something walkable. */
  private floorHit = false;

  constructor(R: Rapier, readonly world: PhysicsWorld, public cfg: MovementConfig) {
    this.collider = world.createCollider(R.ColliderDesc.capsule(PLAYER_HALF_SEGMENT, PLAYER_RADIUS));
    this.kcc = world.createCharacterController(0.02);
    this.kcc.setSlideEnabled(true);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
    this.kcc.setMaxSlopeClimbAngle((89 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle(Math.PI / 2);
    this.applyConfig();
  }

  applyConfig() {
    this.kcc.enableAutostep(this.cfg.stepHeight, 0.15, false);
  }

  private sync(s: PlayerState) {
    this.collider.setTranslation(s.pos);
    this.collider.setRotation(s.frame);
  }

  step(s: PlayerState, input: MoveInput, dt: number) {
    const cfg = this.cfg;
    s.yaw = input.yaw;
    s.pitch = input.pitch;
    const up = upOf(s.frame, _up);

    if (s.noclip) {
      viewQuat(s.frame, s.yaw, s.pitch, _view);
      _fwd.set(0, 0, -1).applyQuaternion(_view);
      _right.set(1, 0, 0).applyQuaternion(_view);
      const sp = cfg.noclipSpeed * (input.sprint ? 3 : 1);
      s.vel.set(0, 0, 0).addScaledVector(_fwd, input.forward * sp).addScaledVector(_right, input.right * sp)
        .addScaledVector(up, input.up * sp);
      s.pos.addScaledVector(s.vel, dt);
      s.onGround = false;
      this.sync(s);
      return;
    }

    moveBasis(s.frame, s.yaw, _fwd, _right);
    _wish.set(0, 0, 0).addScaledVector(_fwd, input.forward).addScaledVector(_right, input.right);
    s.crouched = input.crouch;
    // sprint: forward only, not crouched; drains stamina while moving, refills after a short rest
    if (s.exhausted && s.stamina >= STAMINA.restart) s.exhausted = false;
    s.sprinting = input.sprint && input.forward > 0 && !input.crouch && !s.exhausted && s.stamina > 0;
    if (s.sprinting) {
      s.stamina = Math.max(0, s.stamina - dt);
      if (s.stamina === 0) s.exhausted = true;
      s.restT = 0;
    } else {
      s.restT += dt;
      if (s.restT >= STAMINA.regenDelay) s.stamina = Math.min(STAMINA.max, s.stamina + STAMINA.regen * dt);
    }
    const slow = input.crouch ? CROUCH_SPEED : input.walk ? WALK_SPEED : s.sprinting ? SPRINT_SPEED : 1;
    const wishSpeed = Math.min(_wish.length(), 1) * cfg.maxSpeed * slow;
    if (_wish.lengthSq() > 1e-8) _wish.normalize();

    // jump (before friction → frame-perfect bhop keeps all speed)
    if (!input.jump) s.jumpReleased = true;
    let onGround = s.onGround;
    // coyote time: walked off an edge a moment ago and not falling fast yet → still allowed to jump
    const coyote = !onGround && s.airT >= 0 && s.airT < COYOTE_TIME && s.vel.dot(up) <= 0;
    if ((onGround || coyote) && input.jump && (cfg.autoBhop || s.jumpReleased)) {
      s.vel.addScaledVector(up, cfg.jumpSpeed - s.vel.dot(up));
      onGround = false;
      s.jumpReleased = false;
      s.airT = -1;
      s.jumpHold = JUMP_HOLD.time;
    }
    // let go of Space or started falling: the extension is over
    if (!input.jump || s.vel.dot(up) <= 0) s.jumpHold = 0;

    if (onGround) {
      s.vel.addScaledVector(up, -s.vel.dot(up));
      friction(s.vel, cfg, dt);
      accelerate(s.vel, _wish, wishSpeed, cfg.accelerate, dt);
    } else {
      airAccelerate(s.vel, _wish, wishSpeed, cfg.airAccelerate, cfg.airSpeedCap, dt);
      const g = s.jumpHold > 0 ? JUMP_HOLD.gravityMul : 1;
      s.jumpHold = Math.max(0, s.jumpHold - dt);
      s.vel.addScaledVector(up, -cfg.gravity * g * dt);
      // wall slide: touching a wall last tick, still pushing into it and falling → brake the fall
      s.wallSlide = s.wallNormal.lengthSq() > 0 && _wish.lengthSq() > 0 && _wish.dot(s.wallNormal) < -0.35 && s.vel.dot(up) < 0;
      if (s.wallSlide) {
        const v = s.vel.dot(up);
        if (v < -WALL_SLIDE.speed) s.vel.addScaledVector(up, (-WALL_SLIDE.speed - v) * Math.min(1, WALL_SLIDE.grip * dt));
      }
    }
    if (onGround) s.wallSlide = false;
    if (s.vel.length() > cfg.maxVelocity) s.vel.setLength(cfg.maxVelocity);

    // move with collide & slide
    this.sync(s);
    this.kcc.setUp(up);
    if (onGround) this.kcc.enableSnapToGround(0.3);
    else this.kcc.disableSnapToGround();
    _delta.copy(s.vel).multiplyScalar(dt);
    if (onGround) {
      // walk along the ground plane: lift / lower the step so it lies on the slope (otherwise every tick the move
      // bumps into the ramp and the clip below eats the speed), at the same speed as on flat ground: a ramp is
      // neither faster nor slower to walk
      const nUp = s.groundNormal.dot(up);
      if (nUp > 0.05 && nUp < 0.9999) {
        const len = _delta.length();
        _delta.addScaledVector(up, -_delta.dot(s.groundNormal) / nUp).setLength(len);
      }
    }
    _moved.set(0, 0, 0);
    s.wallNormal.set(0, 0, 0);
    const vert = _delta.dot(up);
    this.pass(s, _delta, up, onGround, true);
    // Falling into a wall: Rapier's slope handling may treat the wall as an unclimbable slope and cancel the fall
    // too (you hung in the wall). Nothing under the feet and most of the fall eaten → finish the fall on its own.
    const fell = _moved.dot(up);
    if (!onGround && vert < 0 && fell > vert * 0.5 && !this.floorHit) {
      _delta.copy(up).multiplyScalar(vert - fell);
      this.pass(s, _delta, up, onGround, false);
    }

    this.sync(s);
    const wasGround = onGround;
    this.categorize(s, up);
    if (s.onGround) s.airT = 0;
    else if (wasGround && s.airT === 0) s.airT = dt; // just walked off
    else if (s.airT > 0) s.airT += dt;
  }

  /** One collide-and-slide move; clips the velocity against what it hit (ClipVelocity, overbounce 1). */
  private pass(s: PlayerState, delta: Vector3, up: Vector3, onGround: boolean, stepCheck: boolean) {
    // on the ground even a zero move runs: it snaps the capsule down onto the ground
    if (!onGround && delta.lengthSq() < 1e-12) return;
    this.sync(s);
    this.kcc.computeColliderMovement(this.collider, delta);
    const mv = this.kcc.computedMovement();
    _step.set(mv.x, mv.y, mv.z);
    s.pos.add(_step);
    _moved.add(_step);
    const planarWanted = _p1.copy(delta).addScaledVector(up, -delta.dot(up)).length();
    const planarMoved = _p1.copy(_step).addScaledVector(up, -_step.dot(up)).length();
    const stepped = stepCheck && onGround && planarMoved >= planarWanted * 0.9;
    const n = this.kcc.numComputedCollisions();
    this.floorHit = false;
    for (let i = 0; i < n; i++) {
      const c = this.kcc.computedCollision(i);
      if (!c) continue;
      _n.set(c.normal1.x, c.normal1.y, c.normal1.z);
      if (_n.dot(up) >= this.cfg.groundCos) this.floorHit = true;
      if (stepped && Math.abs(_n.dot(up)) < 0.3) continue; // went up a stair, keep speed
      if (onGround && _n.dot(up) >= this.cfg.groundCos) continue; // walkable ground is not a wall
      if (!onGround && Math.abs(_n.dot(up)) < 0.3) s.wallNormal.copy(_n).addScaledVector(up, -_n.dot(up)).normalize();
      const d = s.vel.dot(_n);
      if (d < 0) s.vel.addScaledVector(_n, -d);
    }
  }

  /** Ground check: short probe along gravity. */
  categorize(s: PlayerState, up: Vector3) {
    s.onGround = false;
    if (s.noclip || s.vel.dot(up) > this.cfg.nonJumpVelocity) return;
    this.kcc.disableSnapToGround();
    this.kcc.setUp(up);
    _delta.copy(up).multiplyScalar(-0.08);
    this.kcc.computeColliderMovement(this.collider, _delta);
    const n = this.kcc.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const c = this.kcc.computedCollision(i);
      if (!c) continue;
      _n.set(c.normal1.x, c.normal1.y, c.normal1.z);
      if (_n.dot(up) >= this.cfg.groundCos) {
        s.onGround = true;
        s.groundNormal.copy(_n);
      }
    }
    if (s.onGround) {
      // landed: drop the falling part only (clipping against a slope would also cut the planar speed)
      const d = s.vel.dot(up);
      if (d < 0) s.vel.addScaledVector(up, -d);
    }
  }

  /** Remove the capsule and controller from the world. */
  dispose() {
    this.world.removeCharacterController(this.kcc);
    this.world.removeCollider(this.collider, false);
  }

  /** Re-sync the collider after an external teleport / rotation. */
  place(s: PlayerState) {
    this.sync(s);
  }
}