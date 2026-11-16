import { Quaternion, Vector3 } from 'three';
import { TICK_DT } from '../constants';
import { MoveInput } from '../movement';
import type { PlayerSim } from '../sim';
import type { QuatTuple, Vec3Tuple } from './protocol';

/** Button bitmask flags (GoldSrc/Source usercmd_t::buttons convention). */
export const IN_JUMP     = 1 << 0;
export const IN_DUCK     = 1 << 1;
export const IN_SPEED    = 1 << 2; // Sprint
export const IN_WALK     = 1 << 3;
export const IN_ATTACK   = 1 << 4;
export const IN_ATTACK2  = 1 << 5;
export const IN_RELOAD   = 1 << 6;
export const IN_USE      = 1 << 7;
export const IN_JETPACK  = 1 << 8;

const VALID_BUTTONS_MASK =
  IN_JUMP | IN_DUCK | IN_SPEED | IN_WALK | IN_ATTACK | IN_ATTACK2 | IN_RELOAD | IN_USE | IN_JETPACK;

/** Max camera pitch magnitude (rad) to prevent gimbal flip or malformed packets. */
const MAX_PITCH = Math.PI / 2 - 0.01;
/** Reconciliation error threshold (m): larger discrepancies trigger server reset + command replay. */
export const RECONCILE_EPSILON = 0.08;

/**
 * Network input command structure (`usercmd_t`):
 * excludes raw keyboard scancodes and encodes normalized movement wish vectors + viewangles + action bitmask.
 */
export interface UserCommand {
  /** Monotonic uint32 client simulation tick number. */
  tick: number;
  /** Normalized forward/backward movement intent [-1..1]. */
  forwardmove: number;
  /** Normalized strafe left/right movement intent [-1..1]. */
  sidemove: number;
  /** Normalized vertical movement intent (noclip/jetpack) [-1..1]. */
  upmove: number;
  /** Camera orientation [yaw, pitch] in radians. */
  viewangles: [number, number];
  /** Action bitmask (IN_* flags). */
  buttons: number;
}

/** Authoritative physical movement state returned by the server for a given `ackTick`. */
export interface PMoveServerState {
  ackTick: number;
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  frame: QuatTuple;
  yaw: number;
  pitch: number;
  onGround: boolean;
  crouched: boolean;
  stamina: number;
  exhausted: boolean;
  restT: number;
  airT: number;
  jumpHold: number;
  jumpReleased: boolean;
  jetpackHeat: number;
  jetpackOverheatCd: number;
}

/** Stored history slot inside the client's `CmdCircularBuffer`. */
export interface PredictedCmdEntry {
  tick: number;
  cmd: UserCommand;
  predictedPos: Vector3;
  predictedVel: Vector3;
  predictedFrame: Quaternion;
}

/** Create a zeroed `UserCommand`. */
export function emptyUserCommand(tick = 0): UserCommand {
  return {
    tick,
    forwardmove: 0,
    sidemove: 0,
    upmove: 0,
    viewangles: [0, 0],
    buttons: 0,
  };
}

/** Clone a `UserCommand` cleanly by value so buffered entries cannot alias live input. */
export function cloneUserCommand(c: UserCommand): UserCommand {
  return {
    tick: c.tick,
    forwardmove: c.forwardmove,
    sidemove: c.sidemove,
    upmove: c.upmove,
    viewangles: [c.viewangles[0], c.viewangles[1]],
    buttons: c.buttons,
  };
}

/**
 * Server-authoritative input sanitizer & anti-speedhack validator:
 * - clamps per-axis wishes to [-1, 1]
 * - normalizes planar movement vector magnitude <= 1.0 (rejecting diagonal/raw speedhack multipliers)
 * - clamps viewangles and strips invalid button bits.
 */
export function sanitizeUserCommand(raw: UserCommand): UserCommand {
  const tick = Number.isFinite(raw.tick) ? (Math.max(0, Math.floor(raw.tick)) >>> 0) : 0;
  let f = Number.isFinite(raw.forwardmove) ? Math.max(-1, Math.min(1, raw.forwardmove)) : 0;
  let s = Number.isFinite(raw.sidemove) ? Math.max(-1, Math.min(1, raw.sidemove)) : 0;
  const u = Number.isFinite(raw.upmove) ? Math.max(-1, Math.min(1, raw.upmove)) : 0;

  // Enforce ||(forwardmove, sidemove)|| <= 1.0 unless speedhack attempted (e.g. f=10, s=10 or f=1, s=1 exceeds 1 -> normalize)
  const magSq = f * f + s * s;
  if (magSq > 1) {
    const inv = 1 / Math.sqrt(magSq);
    f *= inv;
    s *= inv;
  }

  const rawYaw = raw.viewangles?.[0];
  const rawPitch = raw.viewangles?.[1];
  const yaw = Number.isFinite(rawYaw) ? rawYaw : 0;
  const pitch = Number.isFinite(rawPitch) ? Math.max(-MAX_PITCH, Math.min(MAX_PITCH, rawPitch)) : 0;
  const buttons = (Number.isFinite(raw.buttons) ? raw.buttons : 0) & VALID_BUTTONS_MASK;

  return { tick, forwardmove: f, sidemove: s, upmove: u, viewangles: [yaw, pitch], buttons };
}

/** Map a validated `UserCommand` into `PlayerSim`'s normalized movement input struct. */
export function commandToMoveInput(cmd: UserCommand, out?: MoveInput): MoveInput {
  const safe = sanitizeUserCommand(cmd);
  const dst: MoveInput = out ?? {
    forward: 0, right: 0, up: 0, jump: false, sprint: false, walk: false, crouch: false, yaw: 0, pitch: 0,
  };
  dst.forward = safe.forwardmove;
  dst.right = safe.sidemove;
  dst.up = safe.upmove;
  dst.jump = (safe.buttons & IN_JUMP) !== 0;
  dst.sprint = (safe.buttons & IN_SPEED) !== 0;
  dst.walk = (safe.buttons & IN_WALK) !== 0;
  dst.crouch = (safe.buttons & IN_DUCK) !== 0;
  dst.yaw = safe.viewangles[0];
  dst.pitch = safe.viewangles[1];
  return dst;
}

const _moveTmp: MoveInput = {
  forward: 0, right: 0, up: 0, jump: false, sprint: false, walk: false, crouch: false, yaw: 0, pitch: 0,
};

/**
 * Unified deterministic movement step (`PMove`):
 * runs identically on Client (Prediction + Replay) and Server/Host (Authoritative Physics),
 * driven strictly by `UserCommand` and `deltaTime` with zero dependency on frame rate.
 */
export function SimulateMovement(sim: PlayerSim, cmd: UserCommand, deltaTime = TICK_DT) {
  const safe = sanitizeUserCommand(cmd);
  commandToMoveInput(safe, _moveTmp);
  sim.tick(_moveTmp, deltaTime);
}

/** Snapshot current physical PMove state out of `PlayerSim`. */
export function capturePMoveState(sim: PlayerSim, ackTick: number): PMoveServerState {
  const s = sim.state;
  return {
    ackTick,
    pos: [s.pos.x, s.pos.y, s.pos.z],
    vel: [s.vel.x, s.vel.y, s.vel.z],
    frame: [s.frame.x, s.frame.y, s.frame.z, s.frame.w],
    yaw: s.yaw,
    pitch: s.pitch,
    onGround: s.onGround,
    crouched: s.crouched,
    stamina: s.stamina,
    exhausted: s.exhausted,
    restT: s.restT,
    airT: s.airT,
    jumpHold: s.jumpHold,
    jumpReleased: s.jumpReleased,
    jetpackHeat: sim.jetpackHeat,
    jetpackOverheatCd: sim.jetpackOverheatCd,
  };
}

/** Hard-reset `PlayerSim` to an authoritative `PMoveServerState` and sync collider position. */
export function restorePMoveState(sim: PlayerSim, server: PMoveServerState) {
  const s = sim.state;
  s.pos.set(...server.pos);
  s.vel.set(...server.vel);
  s.frame.set(...server.frame);
  s.onGround = server.onGround;
  s.crouched = server.crouched;
  s.stamina = server.stamina;
  s.exhausted = server.exhausted;
  s.restT = server.restT;
  s.airT = server.airT;
  s.jumpHold = server.jumpHold;
  s.jumpReleased = server.jumpReleased;
  sim.jetpackHeat = server.jetpackHeat;
  sim.jetpackOverheatCd = server.jetpackOverheatCd;
  sim.mover.place(s);
}

/**
 * Fixed-capacity circular history buffer indexed by `tick % capacity` for Client-Side Prediction & Replay.
 */
export class CmdCircularBuffer {
  private readonly slots: (PredictedCmdEntry | null)[];

  constructor(readonly capacity = 256) {
    this.slots = new Array<PredictedCmdEntry | null>(capacity).fill(null);
  }

  clear() {
    this.slots.fill(null);
  }

  push(cmd: UserCommand, sim: PlayerSim) {
    const idx = cmd.tick % this.capacity;
    this.slots[idx] = {
      tick: cmd.tick,
      cmd: cloneUserCommand(cmd),
      predictedPos: sim.state.pos.clone(),
      predictedVel: sim.state.vel.clone(),
      predictedFrame: sim.state.frame.clone(),
    };
  }

  get(tick: number): PredictedCmdEntry | null {
    if (tick < 0) return null;
    const entry = this.slots[tick % this.capacity];
    return entry && entry.tick === tick ? entry : null;
  }

  /** Collect unacknowledged commands `(ackTick, maxTick]` in ascending tick order for replay. */
  collectAfter(ackTick: number, maxTick: number): PredictedCmdEntry[] {
    const out: PredictedCmdEntry[] = [];
    const span = Math.min(this.capacity, Math.max(0, maxTick - ackTick));
    for (let t = ackTick + 1; t <= ackTick + span; t++) {
      const entry = this.get(t);
      if (entry) out.push(entry);
    }
    return out;
  }
}
