import { Vector3 } from 'three';
import { Rng } from './math';

export const WIND_PERIOD = 20;
const BLEND = 3;
export const WIND_MAX = 7;

/**
 * Worms-style wind: a deterministic world-space acceleration that changes every WIND_PERIOD seconds
 * (same on every client and the server for the same seed + time). Each projectile only feels the part
 * of the wind that is "horizontal" for its own gravity.
 */
export class Wind {
  constructor(readonly seed = 2024) {}

  private sample(k: number, out: Vector3) {
    const r = new Rng(this.seed + k * 7919);
    const u = r.range(-1, 1);
    const a = r.range(0, Math.PI * 2);
    const s = Math.sqrt(1 - u * u);
    const strength = r.range(1, WIND_MAX);
    return out.set(Math.cos(a) * s, u, Math.sin(a) * s).multiplyScalar(strength);
  }

  at(time: number, out = new Vector3()): Vector3 {
    const k = Math.floor(time / WIND_PERIOD);
    const into = time - k * WIND_PERIOD;
    this.sample(k, out);
    if (into > WIND_PERIOD - BLEND) {
      const t = (into - (WIND_PERIOD - BLEND)) / BLEND;
      const next = this.sample(k + 1, new Vector3());
      out.lerp(next, t * t * (3 - 2 * t));
    }
    return out;
  }

  /** Wind felt by something whose gravity points along `down`. */
  felt(time: number, down: Vector3, out = new Vector3()): Vector3 {
    this.at(time, out);
    return out.addScaledVector(down, -out.dot(down));
  }
}
