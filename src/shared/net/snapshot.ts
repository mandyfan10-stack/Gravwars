/**
 * Pure snapshot quantization and relevancy/rate scheduling helpers for P2P world snapshots.
 * Zero DOM / Three.js scene dependencies so every optimization is verified by headless tests.
 */
import type { QuatTuple, Vec3Tuple } from './protocol';

/** Authoritative world snapshot cadence (25 Hz). */
export const SNAPSHOT_INTERVAL = 0.04;
/** Periodic pickup list resync cadence (ticks at 25 Hz = 1.0 s). */
export const PICKUP_RESYNC_TICKS = 25;
/** Distance (m) from any remote human observer within which NPCs and cars update at the near cadence. */
export const ENTITY_NEAR_DIST = 65;
/** Snapshot stride for nearby living NPCs / cars (25 Hz / 2 = 12.5 Hz). */
export const ENTITY_NEAR_STRIDE = 2;
/** Snapshot stride for distant living NPCs / cars (25 Hz / 6 ≈ 4.2 Hz). */
export const ENTITY_FAR_STRIDE = 6;
/** Periodic full resync interval (ticks at 25 Hz = 1.0 s) so dropped unreliable packets self-heal. */
export const ENTITY_FULL_RESYNC_TICKS = 25;

/** Quantize coordinate / velocity / angle to 1e-3 (1 mm / ~0.06°). */
export function q3(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

/** Quantize unit quaternion component to 1e-4. */
export function q4(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}

/** Quantize HP / short timers to 0.1. */
export function q1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

export function qVec3(x: number, y: number, z: number): Vec3Tuple {
  return [q3(x), q3(y), q3(z)];
}

export function qQuat(x: number, y: number, z: number, w: number): QuatTuple {
  return [q4(x), q4(y), q4(z), q4(w)];
}

function minDistSqToObservers(pos: Vec3Tuple, observers: readonly Vec3Tuple[]): number {
  if (!observers.length) return 0;
  let best = Infinity;
  const px = pos[0], py = pos[1], pz = pos[2];
  for (let i = 0; i < observers.length; i++) {
    const o = observers[i];
    const dx = px - o[0], dy = py - o[1], dz = pz - o[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) best = d2;
  }
  return best;
}

/**
 * Per-entity snapshot scheduler:
 * - Always sends alive <-> dead transitions immediately and suppresses already-dead entities between resyncs.
 * - Sends urgent entities (firing NPCs, crashing cars) at full 25 Hz.
 * - Staggers nearby living entities at 12.5 Hz and far entities at ~4.2 Hz by entity ID to avoid burst spikes.
 * - Performs a full resync every `ENTITY_FULL_RESYNC_TICKS` ticks so lost unreliable snapshots recover cleanly.
 */
export class SnapshotScheduler {
  private readonly npcAlive = new Map<number, boolean>();
  private readonly carAlive = new Map<number, boolean>();
  private readonly nearDistSq = ENTITY_NEAR_DIST * ENTITY_NEAR_DIST;

  shouldSend(
    kind: 'npc' | 'car',
    id: number,
    alive: boolean,
    urgent: boolean,
    pos: Vec3Tuple,
    observers: readonly Vec3Tuple[],
    snapTick: number,
  ): boolean {
    const map = kind === 'npc' ? this.npcAlive : this.carAlive;
    const prev = map.get(id);
    map.set(id, alive);

    if (snapTick <= 1 || snapTick % ENTITY_FULL_RESYNC_TICKS === 0) return true;
    if (prev !== undefined && prev !== alive) return true;
    if (!alive) return false;
    if (urgent) return true;

    const stride = minDistSqToObservers(pos, observers) <= this.nearDistSq
      ? ENTITY_NEAR_STRIDE
      : ENTITY_FAR_STRIDE;
    return (snapTick + id) % stride === 0;
  }

  reset() {
    this.npcAlive.clear();
    this.carAlive.clear();
  }
}
