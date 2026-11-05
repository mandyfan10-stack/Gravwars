import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { EYE_OFFSET, TICK_DT } from '../shared/constants';
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

  constructor(readonly sim: PlayerSim, private keys: Input) {
    this.snap();
    keys.yaw = sim.state.yaw;
    keys.pitch = sim.state.pitch;
  }

  snap() {
    this.prevPos.copy(this.sim.state.pos);
    this.renderFrame.copy(this.sim.state.frame);
    this.turnT = 1;
  }

  private sampleInput() {
    const k = this.keys;
    const i = this.input;
    i.forward = k.locked ? k.axis('KeyW', 'KeyS') : 0;
    i.right = k.locked ? k.axis('KeyD', 'KeyA') : 0;
    i.up = k.locked ? (k.down('Space') ? 1 : 0) - (k.down('ControlLeft') || k.down('KeyC') ? 1 : 0) : 0;
    i.jump = k.locked && k.jump();
    i.sprint = k.down('ShiftLeft');
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
      this.sim.tick(this.input, TICK_DT);
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
  }

  drainEvents() {
    for (const e of this.sim.events.splice(0)) {
      if (e.type === 'gravity') {
        this.turnFrom.copy(this.renderFrame);
        this.turnT = 0;
      } else if (e.type === 'teleport') {
        // seamless: carry the interpolation state through the portal
        this.prevPos.applyMatrix4(e.matrix);
        this.renderFrame.premultiply(e.quat);
        this.turnFrom.premultiply(e.quat);
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
    camera.position.copy(this.renderPos).addScaledVector(_up, EYE_OFFSET);
    viewQuat(this.renderFrame, this.keys.yaw, this.keys.pitch, _q);
    camera.quaternion.copy(_q);
    camera.updateMatrixWorld();
  }
}