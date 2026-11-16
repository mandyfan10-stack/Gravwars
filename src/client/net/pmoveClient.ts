import { Quaternion, Vector3 } from 'three';
import { TICK_DT } from '../../shared/constants';
import {
  CmdCircularBuffer, type PMoveServerState, RECONCILE_EPSILON, restorePMoveState, sanitizeUserCommand,
  SimulateMovement, type UserCommand,
} from '../../shared/net/pmove';
import type { PlayerSim } from '../../shared/sim';

const _serverPos = new Vector3();
const _serverFrame = new Quaternion();

export interface ReconcileResult {
  corrected: boolean;
  errorDist: number;
  replayedCount: number;
}

/**
 * GoldSrc/Source Client-Side Prediction & Server Reconciliation controller.
 * - Immediately simulates local `UserCommand`s through deterministic `SimulateMovement` and logs them in `CmdCircularBuffer`.
 * - On `ServerState`, compares authoritative pos at `ackTick` against historical prediction; if error exceeds
 *   `RECONCILE_EPSILON`, snaps back to `ServerState` and synchronously replays all queued commands up to current tick.
 */
export class PMoveClient {
  clientTick = 0;
  readonly history = new CmdCircularBuffer(256);
  /** Smoothed visual offset decayed toward zero after minor reconciliation corrections. */
  readonly smoothError = new Vector3();
  lastReconciledTick = 0;
  lastErrorDist = 0;
  replaysTotal = 0;

  clear() {
    this.history.clear();
    this.smoothError.set(0, 0, 0);
  }

  /** Build & immediately simulate one fixed client prediction step, recording it in the circular buffer. */
  predictStep(sim: PlayerSim, rawCmd: Omit<UserCommand, 'tick'>, dt = TICK_DT): UserCommand {
    const tick = ++this.clientTick;
    const cmd = sanitizeUserCommand({ ...rawCmd, tick });
    SimulateMovement(sim, cmd, dt);
    this.history.push(cmd, sim);
    return cmd;
  }

  /**
   * Reconcile against authoritative `ServerState` from host:
   * resets to server snapshot when error > `RECONCILE_EPSILON` and replays all buffered future commands in 1 frame.
   */
  reconcile(sim: PlayerSim, server: PMoveServerState, dt = TICK_DT): ReconcileResult {
    if (server.ackTick <= this.lastReconciledTick) {
      return { corrected: false, errorDist: 0, replayedCount: 0 };
    }
    this.lastReconciledTick = server.ackTick;

    const entry = this.history.get(server.ackTick);
    _serverPos.set(...server.pos);
    _serverFrame.set(...server.frame);

    const refPos = entry ? entry.predictedPos : sim.state.pos;
    const errorDist = _serverPos.distanceTo(refPos);
    const frameDrift = entry ? Math.abs(_serverFrame.dot(entry.predictedFrame)) < 0.999 : false;
    this.lastErrorDist = errorDist;

    if (errorDist <= RECONCILE_EPSILON && !frameDrift) {
      return { corrected: false, errorDist, replayedCount: 0 };
    }

    const beforePos = sim.state.pos.clone();

    // 1. Force-reset player physics to authoritative ServerState for ackTick
    restorePMoveState(sim, server);
    if (entry) {
      entry.predictedPos.copy(sim.state.pos);
      entry.predictedVel.copy(sim.state.vel);
      entry.predictedFrame.copy(sim.state.frame);
    }

    // 2. Synchronously replay all subsequent unacknowledged commands in the circular buffer up to clientTick
    const pending = this.history.collectAfter(server.ackTick, this.clientTick);
    for (const next of pending) {
      SimulateMovement(sim, next.cmd, dt);
      next.predictedPos.copy(sim.state.pos);
      next.predictedVel.copy(sim.state.vel);
      next.predictedFrame.copy(sim.state.frame);
    }
    // Discard side-effect events emitted during speculative replay so audio/UI don't double-fire
    sim.events.length = 0;

    // 3. Preserve camera continuity by smoothing small deltas (< 4 m); larger teleports snap cleanly
    const visualDelta = beforePos.sub(sim.state.pos);
    if (visualDelta.lengthSq() < 16) {
      this.smoothError.add(visualDelta);
    } else {
      this.smoothError.set(0, 0, 0);
    }

    this.replaysTotal++;
    return { corrected: true, errorDist, replayedCount: pending.length };
  }

  /** Decay visual smoothing error each render frame. */
  decayError(dt: number) {
    if (this.smoothError.lengthSq() < 1e-6) {
      this.smoothError.set(0, 0, 0);
      return;
    }
    const factor = Math.max(0, 1 - dt * 16);
    this.smoothError.multiplyScalar(factor);
  }
}
