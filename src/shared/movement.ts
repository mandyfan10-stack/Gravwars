import { Quaternion, Vector3 } from 'three';
import { MovementConfig, PLAYER_HALF_SEGMENT, PLAYER_RADIUS } from './constants';
import { upOf } from './math';
import type { PhysicsWorld, Rapier } from './physics';

/** Quiet walk speed, share of maxSpeed (Source / CS: ~0.52). */
export const WALK_SPEED = 0.45;

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
}

export interface MoveInput {
  forward: number;
  right: number;
  /** noclip only: +1 up, -1 down */
  up: number;
  jump: boolean;
  sprint: boolean;
  /** Quiet walk (Shift): slower on the ground and silent for NPCs. */
  walk: boolean;
  yaw: number;
  pitch: number;
}

export function createPlayerState(): PlayerState {
  return {
    pos: new Vector3(), vel: new Vector3(), frame: new Quaternion(), yaw: 0, pitch: 0,
    onGround: false, groundNormal: new Vector3(0, 1, 0), jumpReleased: true, noclip: false,
  };
}

export function emptyInput(): MoveInput {
  return { forward: 0, right: 0, up: 0, jump: false, sprint: false, walk: false, yaw: 0, pitch: 0 };
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
    const wishSpeed = Math.min(_wish.length(), 1) * cfg.maxSpeed * (input.walk ? WALK_SPEED : 1);
    if (_wish.lengthSq() > 1e-8) _wish.normalize();

    // jump (before friction → frame-perfect bhop keeps all speed)
    if (!input.jump) s.jumpReleased = true;
    let onGround = s.onGround;
    if (onGround && input.jump && (cfg.autoBhop || s.jumpReleased)) {
      s.vel.addScaledVector(up, cfg.jumpSpeed - s.vel.dot(up));
      onGround = false;
      s.jumpReleased = false;
    }

    if (onGround) {
      s.vel.addScaledVector(up, -s.vel.dot(up));
      friction(s.vel, cfg, dt);
      accelerate(s.vel, _wish, wishSpeed, cfg.accelerate, dt);
    } else {
      airAccelerate(s.vel, _wish, wishSpeed, cfg.airAccelerate, cfg.airSpeedCap, dt);
      s.vel.addScaledVector(up, -cfg.gravity * dt);
    }
    if (s.vel.length() > cfg.maxVelocity) s.vel.setLength(cfg.maxVelocity);

    // move with collide & slide
    this.sync(s);
    this.kcc.setUp(up);
    if (onGround) this.kcc.enableSnapToGround(0.3);
    else this.kcc.disableSnapToGround();
    _delta.copy(s.vel).multiplyScalar(dt);
    if (onGround) {
      // walk along the ground plane: lift / lower the planar step so it lies on the slope, keeping planar speed
      // (otherwise every tick the move bumps into the ramp and the clip below eats the speed)
      const nUp = s.groundNormal.dot(up);
      if (nUp > 0.05 && nUp < 0.9999) _delta.addScaledVector(up, -_delta.dot(s.groundNormal) / nUp);
    }
    this.kcc.computeColliderMovement(this.collider, _delta);
    const mv = this.kcc.computedMovement();
    _moved.set(mv.x, mv.y, mv.z);
    s.pos.add(_moved);

    // clip velocity against everything we hit (ClipVelocity, overbounce 1)
    const planarWanted = _delta.clone().addScaledVector(up, -_delta.dot(up)).length();
    const planarMoved = _moved.clone().addScaledVector(up, -_moved.dot(up)).length();
    const stepped = onGround && planarMoved >= planarWanted * 0.9;
    const n = this.kcc.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const c = this.kcc.computedCollision(i);
      if (!c) continue;
      _n.set(c.normal1.x, c.normal1.y, c.normal1.z);
      if (stepped && Math.abs(_n.dot(up)) < 0.3) continue; // went up a stair, keep speed
      if (onGround && _n.dot(up) >= this.cfg.groundCos) continue; // walkable ground is not a wall
      const d = s.vel.dot(_n);
      if (d < 0) s.vel.addScaledVector(_n, -d);
    }

    this.sync(s);
    this.categorize(s, up);
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