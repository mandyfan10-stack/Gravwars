import { Quaternion, Vector3 } from 'three';
import type { Block } from './blocks';
import type { MapData } from './map';

/**
 * Gravity towards the nearest walkable surface. Only "gravity plates" pull: the top of every island (base islands,
 * the central city), the bridge stubs on the bases and every floor piece players build (bridges). Walls, houses and
 * cars do not, so walking into a building does not stick you to it.
 *
 * A plate pulls a point that is above its walk face (within `range`) and over its rectangle; of all such plates the
 * closest wins, with a small bias for the one whose gravity you already have (no flicker at a corner). Off every
 * rectangle nothing pulls and the current gravity stays: stepping off an island edge is still a fall into the void.
 */
export interface GravityPlate {
  /** Centre of the walk face. */
  center: Vector3;
  /** Walk face normal (the gravity it gives is -up). */
  up: Vector3;
  /** In-plane axes and half extents. */
  u: Vector3;
  v: Vector3;
  hu: number;
  hv: number;
  /** Pulls from `minH` below the face up to `range` above it. */
  minH: number;
  range: number;
}

/** A different plate takes you only from this close (m, capsule centre above its face): you have to step onto it. */
const CAPTURE = 1.2;
/** ...and only if it is closer than the surface holding you now by this much (no flicker at a corner). */
const BIAS = 0.3;
/** Plates are grabbed this much beyond their rectangle (adjacent bridge pieces overlap, no gaps). */
const MARGIN = 0.35;
/** Floor pieces pull from this far above their face: standing on one (capsule centre ~0.9 m). */
const FLOOR_RANGE = 1.8;

const _d = new Vector3();
const _q = new Quaternion();
const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);

/** Plate of a built floor piece (cached per block: blocks never move). */
const floorPlates = new WeakMap<Block, GravityPlate>();
export function floorPlate(b: Block): GravityPlate {
  let p = floorPlates.get(b);
  if (!p) {
    _q.copy(b.quat);
    const up = Y.clone().applyQuaternion(_q);
    p = {
      center: b.center.clone().addScaledVector(up, b.half.y), up,
      u: X.clone().applyQuaternion(_q), v: Z.clone().applyQuaternion(_q), hu: b.half.x, hv: b.half.z,
      minH: -0.3, range: FLOOR_RANGE,
    };
    floorPlates.set(b, p);
  }
  return p;
}

export interface GravityPull { plate: GravityPlate; h: number }

export class GravityField {
  /** Built pieces (bridges); set by whoever owns the block system. */
  blocks: () => Iterable<Block> = () => [];

  constructor(readonly plates: GravityPlate[]) {}

  /** Height of `pos` above the plate's face if the plate pulls it, else null. */
  static pulls(p: GravityPlate, pos: Vector3): number | null {
    _d.copy(pos).sub(p.center);
    const h = _d.dot(p.up);
    if (h < p.minH || h > p.range) return null;
    if (Math.abs(_d.dot(p.u)) > p.hu + MARGIN || Math.abs(_d.dot(p.v)) > p.hv + MARGIN) return null;
    return h;
  }

  /**
   * The plate that takes over a body at `pos` whose up is `currentUp`, or null (the gravity stays). A plate of
   * another up captures only when the body is right at its face and closer to it than to anything level for it now:
   * walking into the bridge stub turns you onto it, jumping on a bridge or falling off one does not.
   */
  pull(pos: Vector3, currentUp: Vector3): GravityPull | null {
    let hold = Infinity;
    let best: GravityPull | null = null;
    const consider = (p: GravityPlate) => {
      const h = GravityField.pulls(p, pos);
      if (h === null) return;
      if (p.up.dot(currentUp) > 0.99) hold = Math.min(hold, Math.max(h, 0));
      else if (h <= CAPTURE && (!best || h < best.h)) best = { plate: p, h };
    };
    for (const p of this.plates) consider(p);
    for (const b of this.blocks()) if (b.kind === 'floor') consider(floorPlate(b));
    const found = best as GravityPull | null;
    return found && Math.max(found.h, 0) + BIAS < hold ? found : null;
  }

  /** Is there something level for `up` under `pos` (an island top within its range, a floor right below)? */
  holds(pos: Vector3, up: Vector3): boolean {
    for (const p of this.plates) if (p.up.dot(up) > 0.99 && GravityField.pulls(p, pos) !== null) return true;
    for (const b of this.blocks()) {
      if (b.kind !== 'floor') continue;
      const p = floorPlate(b);
      if (p.up.dot(up) > 0.99 && GravityField.pulls(p, pos) !== null) return true;
    }
    return false;
  }
}

/** One field per map, shared by every body; the block system plugs its pieces in (`blocks`). */
const fields = new WeakMap<MapData, GravityField>();
export function fieldFor(map: MapData): GravityField {
  let f = fields.get(map);
  if (!f) {
    const v = (a: number[]) => new Vector3(a[0], a[1], a[2]);
    f = new GravityField(map.plates.map((p) => ({
      center: v(p.center), up: v(p.up), u: v(p.u), v: v(p.v), hu: p.hu, hv: p.hv, minH: p.minH, range: p.range,
    })));
    fields.set(map, f);
  }
  return f;
}
