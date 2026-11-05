import { Quaternion, Vector3 } from 'three';
import type { PondDef } from './map';
import { Rng } from './math';

export const FISHING = {
  /** Max distance from the eye to where the bobber lands, m. */
  reach: 9,
  /** Walking further than this from the bobber reels the line in. */
  leash: 11,
  /** Flight time of the bobber. */
  castTime: 0.45,
  /** Waiting for a bite, s. */
  waitMin: 2.5,
  waitMax: 6,
  /** The strike bar: one sweep of the marker, s. */
  biteTime: 1.3,
  /** Width of the green zone on the 0..1 bar. */
  zone: 0.24,
  /** Pause after a catch / miss before the next cast. */
  after: 0.6,
};

export type FishPhase = 'idle' | 'cast' | 'wait' | 'bite' | 'after';
export type FishEvent =
  | { type: 'cast' }
  | { type: 'splash' }
  | { type: 'bite' }
  | { type: 'catch' }
  | { type: 'miss'; reason: 'early' | 'late' | 'zone' | 'away' }
  | { type: 'noWater' };

const _q = new Quaternion();
const _l = new Vector3();

/**
 * Fishing with the rod, only in park ponds: cast (LMB at the water) → wait a few seconds → a bite starts the strike
 * bar: a marker sweeps across once, press LMB while it is inside the zone → a fish.
 */
export class Fishing {
  phase: FishPhase = 'idle';
  /** Time in the current phase. */
  t = 0;
  /** Phase length (wait / bite / after). */
  dur = 0;
  readonly bobber = new Vector3();
  readonly bobberUp = new Vector3(0, 1, 0);
  pond: PondDef | null = null;
  /** Strike zone start on the 0..1 bar. */
  zoneAt = 0.5;
  readonly events: FishEvent[] = [];
  private readonly rng: Rng;

  constructor(private ponds: PondDef[], seed = 77) {
    this.rng = new Rng(seed);
  }

  get busy() {
    return this.phase !== 'idle';
  }

  /** Marker position on the strike bar (0..1) during a bite. */
  get marker() {
    return Math.min(1, this.t / FISHING.biteTime);
  }

  /** Where the view ray meets pond water within reach (null = no water there). */
  aimWater(eye: Vector3, dir: Vector3): { pond: PondDef; point: Vector3 } | null {
    let best: { pond: PondDef; point: Vector3 } | null = null;
    let bestT = FISHING.reach;
    for (const p of this.ponds) {
      const up = _l.set(...p.up);
      const denom = dir.dot(up);
      if (denom > -0.05) continue; // must look down at the surface
      const t = (new Vector3(...p.pos).sub(eye)).dot(up) / denom;
      if (t <= 0 || t > bestT) continue;
      const hit = eye.clone().addScaledVector(dir, t);
      const local = hit.clone().sub(new Vector3(...p.pos)).applyQuaternion(_q.set(...p.quat).invert());
      if (Math.abs(local.x) > p.half[0] - 0.3 || Math.abs(local.z) > p.half[1] - 0.3) continue;
      best = { pond: p, point: hit };
      bestT = t;
    }
    return best;
  }

  /** LMB with the rod: cast, or strike while a fish bites. */
  use(eye: Vector3, dir: Vector3) {
    if (this.phase === 'idle') {
      const w = this.aimWater(eye, dir);
      if (!w) { this.events.push({ type: 'noWater' }); return; }
      this.pond = w.pond;
      this.bobber.copy(w.point);
      this.bobberUp.set(...w.pond.up);
      this.enter('cast', FISHING.castTime);
      this.events.push({ type: 'cast' });
    } else if (this.phase === 'wait' || this.phase === 'cast') {
      this.miss('early');
    } else if (this.phase === 'bite') {
      const m = this.marker;
      if (m >= this.zoneAt && m <= this.zoneAt + FISHING.zone) {
        this.events.push({ type: 'catch' });
        this.enter('after', FISHING.after);
      } else this.miss('zone');
    }
  }

  /** Put the rod away / walked off: reel in without a fish. */
  cancel() {
    if (this.phase === 'cast' || this.phase === 'wait' || this.phase === 'bite') this.miss('away');
    this.phase = 'idle';
  }

  private miss(reason: 'early' | 'late' | 'zone' | 'away') {
    this.events.push({ type: 'miss', reason });
    this.enter('after', FISHING.after);
  }

  private enter(phase: FishPhase, dur: number) {
    this.phase = phase;
    this.t = 0;
    this.dur = dur;
  }

  tick(dt: number, playerPos: Vector3) {
    if (this.phase === 'idle') return;
    this.t += dt;
    if ((this.phase === 'wait' || this.phase === 'bite') && playerPos.distanceTo(this.bobber) > FISHING.leash) {
      this.miss('away');
      return;
    }
    if (this.t < this.dur) return;
    if (this.phase === 'cast') {
      this.events.push({ type: 'splash' });
      this.enter('wait', this.rng.range(FISHING.waitMin, FISHING.waitMax));
    } else if (this.phase === 'wait') {
      // the zone never starts at the very beginning: there is always a moment to react
      this.zoneAt = this.rng.range(0.3, 1 - FISHING.zone - 0.04);
      this.events.push({ type: 'bite' });
      this.enter('bite', FISHING.biteTime + 0.1);
    } else if (this.phase === 'bite') this.miss('late');
    else this.phase = 'idle';
  }
}
