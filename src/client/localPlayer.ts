import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { CROUCH_EYE_DROP, EYE_OFFSET, TICK_DT } from '../shared/constants';
import { emptyInput, MoveInput, viewQuat } from '../shared/movement';
import type { PlayerSim, SimEvent } from '../shared/sim';
import type { Input } from './input';

const GRAVITY_TURN_TIME = 0.35;
const _up = new Vector3();
const _q = new Quaternion();

/**
 * Runs the shared simulation at a fixed tick (client prediction) and produces a smooth camera:
 * position interpolation between ticks + eased body rotation when gravity changes.
 */
export class LocalPlayer {
  private acc = 0;
  readonly prevPos = new Vector3();
  readonly renderPos = new Vector3();
  /** Body frame used for rendering (eased towards sim frame). */
  readonly renderFrame = new Quaternion();
  private turnFrom = new Quaternion();
  private turnT = 1;
  readonly input: MoveInput = emptyInput();
  onEvent: (e: SimEvent) => void = () => {};
  /** Runs right after every simulation tick (weapons / projectiles). */
  onTick: () => void = () => {};
  /** Eased crouch 0..1 (camera height). */
  crouchT = 0;
  /** Camera dip after a landing, m (springs back). */
  private landDip = 0;
  private landV = 0;
  /** Landed this frame with this falling speed, m/s (footsteps / thud). */
  landed = 0;
  /** Walked distance on the ground (footsteps), m. */
  stride = 0;
  /** No movement input (dead: the death screen). */
  frozen = false;

  constructor(readonly sim: PlayerSim, private keys: Input) {
    this.snap();
    keys.yaw = sim.state.yaw;
    keys.pitch = sim.state.pitch;
  }

  snap() {
    this.prevPos.copy(this.sim.state.pos);
    this.renderPos.copy(this.sim.state.pos);
    this.renderFrame.copy(this.sim.state.frame);
    this.turnT = 1;
  }

  private sampleInput() {
    const k = this.keys;
    const i = this.input;
    const on = k.locked && !this.frozen;
    i.forward = on ? k.axis('KeyW', 'KeyS') : 0;
    i.right = on ? k.axis('KeyD', 'KeyA') : 0;
    i.up = on ? (k.down('Space') ? 1 : 0) - (k.down('ControlLeft') || k.down('KeyC') ? 1 : 0) : 0;
    i.jump = on && k.jump();
    i.sprint = on && (k.down('ShiftLeft') || k.down('ShiftRight'));
    i.walk = false;
    i.crouch = on && !this.sim.state.noclip && (k.down('ControlLeft') || k.down('KeyC'));
    i.yaw = k.yaw;
    i.pitch = k.pitch;
  }

  /** Fraction of the next simulation tick already accumulated (render interpolation). */
  get alpha() {
    return this.acc / TICK_DT;
  }

  update(dt: number) {
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= TICK_DT) {
      this.acc -= TICK_DT;
      this.prevPos.copy(this.sim.state.pos);
      this.sampleInput();
      const s = this.sim.state;
      const wasGround = s.onGround;
      _up.set(0, 1, 0).applyQuaternion(s.frame);
      const fall = -s.vel.dot(_up);
      this.sim.tick(this.input, TICK_DT);
      if (s.onGround && !wasGround && fall > 3) {
        this.landed = Math.max(this.landed, fall);
        this.landV -= Math.min(fall, 20) * 0.045;
      }
      if (s.onGround) this.stride += Math.sqrt(Math.max(0, s.vel.lengthSq() - s.vel.dot(_up) ** 2)) * TICK_DT;
      this.onTick();
      this.drainEvents();
    }
    // keep mouse look responsive between ticks
    this.sim.state.yaw = this.keys.yaw;
    this.sim.state.pitch = this.keys.pitch;

    if (this.turnT < 1) {
      this.turnT = Math.min(1, this.turnT + dt / GRAVITY_TURN_TIME);
      const t = this.turnT * this.turnT * (3 - 2 * this.turnT);
      this.renderFrame.slerpQuaternions(this.turnFrom, this.sim.state.frame, t);
    } else {
      this.renderFrame.copy(this.sim.state.frame);
    }
    this.renderPos.lerpVectors(this.prevPos, this.sim.state.pos, this.acc / TICK_DT);
    // crouch eases the eye down; a landing dips the camera on a damped spring
    this.crouchT += ((this.sim.state.crouched ? 1 : 0) - this.crouchT) * Math.min(1, dt * 12);
    this.landV += (-this.landDip * 160 - this.landV * 18) * Math.min(dt, 0.05);
    this.landDip = Math.max(-0.3, Math.min(0.05, this.landDip + this.landV * Math.min(dt, 0.05)));
  }

  /** Eye height above the capsule centre right now (crouch + landing dip). */
  get eyeOffset() {
    return EYE_OFFSET - CROUCH_EYE_DROP * this.crouchT + this.landDip;
  }

  drainEvents() {
    for (const e of this.sim.events.splice(0)) {
      if (e.type === 'gravity') {
        this.turnFrom.copy(this.renderFrame);
        this.turnT = 0;
      } else if (e.type === 'respawn') {
        this.snap();
        this.keys.yaw = this.sim.state.yaw;
        this.keys.pitch = 0;
      }
      this.onEvent(e);
    }
  }

  applyCamera(camera: PerspectiveCamera) {
    _up.set(0, 1, 0).applyQuaternion(this.renderFrame);
    camera.position.copy(this.renderPos).addScaledVector(_up, this.eyeOffset);
    viewQuat(this.renderFrame, this.keys.yaw, this.keys.pitch, _q);
    camera.quaternion.copy(_q);
    camera.updateMatrixWorld();
  }
}