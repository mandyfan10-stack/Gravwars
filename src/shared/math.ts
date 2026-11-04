import { Quaternion, Vector3 } from 'three';

export const AXIS_Y = new Vector3(0, 1, 0);

/** Body frame: local +Y maps to `up`. Deterministic for axis-aligned ups. */
export function frameForUp(up: Vector3, out = new Quaternion()): Quaternion {
  return out.setFromUnitVectors(AXIS_Y, up);
}

export function upOf(frame: Quaternion, out = new Vector3()): Vector3 {
  return out.set(0, 1, 0).applyQuaternion(frame);
}

/** Small deterministic PRNG (mulberry32) so client and server generate the same map. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}