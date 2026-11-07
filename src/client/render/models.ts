import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CubicBezierCurve3, CylinderGeometry, ExtrudeGeometry,
  IcosahedronGeometry, Shape, TubeGeometry, Vector3,
} from 'three';
import { CAR_SHAPES } from '../../shared/mapgen/props';
import type { DecorKind } from '../../shared/map';

/**
 * Procedural low-poly models of the city (cars, the bus, street lamps, trees). Bodies are extruded side profiles
 * (bonnet, windscreen, roof, wheel arches) rather than stacks of boxes; every triangle gets a colour by where it
 * is and which way it faces (paint, glass, bumper, underside). Each model comes as two geometries in its local
 * frame (ground at y = 0, front = -Z): `paint` (white: takes the instance colour) and `detail` (fixed vertex
 * colours: glass, tyres, chrome).
 */
export interface DecorModel { paint: BufferGeometry | null; detail: BufferGeometry }

const GLASS = 0x26343f;
const TYRE = 0x1a1b1e;
const HUB = 0x9a9ea5;
const BUMPER = 0x2c2e33;
const UNDER = 0x141517;
const _c = new Color();
const _n = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _m = new Vector3();

type Colour = number | 'paint';
type Classify = (centre: Vector3, normal: Vector3) => Colour;

/** Collects triangles of several geometries into a paint set and a coloured detail set. */
class Parts {
  private readonly paint: number[] = [];
  private readonly detail: { pos: number[]; col: number[] } = { pos: [], col: [] };

  /** Add every triangle of `g` (any geometry; indexed is fine), coloured by `cls` or one colour for all. */
  add(g: BufferGeometry, cls: Classify | Colour) {
    const geo = g.index ? g.toNonIndexed() : g;
    const p = geo.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) {
      const v0 = new Vector3().fromBufferAttribute(p, i), v1 = new Vector3().fromBufferAttribute(p, i + 1), v2 = new Vector3().fromBufferAttribute(p, i + 2);
      _a.subVectors(v1, v0);
      _b.subVectors(v2, v0);
      _n.crossVectors(_a, _b);
      if (_n.lengthSq() < 1e-12) continue;
      _n.normalize();
      _m.copy(v0).add(v1).add(v2).divideScalar(3);
      const c = typeof cls === 'function' ? cls(_m, _n) : cls;
      if (c === 'paint') this.paint.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
      else {
        _c.setHex(c);
        this.detail.pos.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
        for (let k = 0; k < 3; k++) this.detail.col.push(_c.r, _c.g, _c.b);
      }
    }
  }

  build(): DecorModel {
    const make = (pos: number[], col?: number[]) => {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
      if (col) g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
      g.computeVertexNormals(); // non-indexed: flat per triangle
      return g;
    };
    return {
      paint: this.paint.length ? make(this.paint) : null,
      detail: make(this.detail.pos, this.detail.col),
    };
  }
}

/**
 * A side profile [z, y] extruded across the car (x from -w/2 to w/2) with chamfered edges (inside the outline:
 * the body keeps the profile's size). The profile is drawn in the z/y plane and stays there (front = -Z).
 */
function profile(pts: [number, number][], width: number, bevel = 0.04): BufferGeometry {
  const s = new Shape();
  // shape x = -z, so that after the turn below z comes out right way round
  s.moveTo(-pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(-pts[i][0], pts[i][1]);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: width - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1, curveSegments: 1 });
  g.rotateY(Math.PI / 2);
  g.translate(-(width / 2 - bevel), 0, 0);
  return g;
}

/** Points of a wheel arch over a wheel at z = c (from z = c + r round the top to c - r, or reverse). */
function arch(c: number, y: number, r: number, reverse: boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k <= 6; k++) {
    const a = ((reverse ? 6 - k : k) / 6) * Math.PI;
    out.push([c + Math.cos(a) * r, y + Math.sin(a) * r]);
  }
  return out;
}

/** A box (centre, size) for the parts list. */
const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => new BoxGeometry(sx, sy, sz).translate(x, y, z);

/** Four wheels: tyre + hub cap on the outside. */
function wheels(parts: Parts, x: number, r: number, w: number, axles: number[]) {
  for (const z of axles) for (const s of [-1, 1]) {
    parts.add(new CylinderGeometry(r, r, w, 10).rotateZ(Math.PI / 2).translate(s * x, r, z), TYRE);
    parts.add(new CylinderGeometry(r * 0.55, r * 0.55, 0.02, 8).rotateZ(Math.PI / 2).translate(s * (x + w / 2), r, z), HUB);
  }
}

/** Lower body colours: bumpers (front / back, low), underside, the inside of the wheel arches. */
function lowerBody(half: number, axles: number[], archR: number): Classify {
  return (c, n) => {
    if (n.y < -0.5) return UNDER;
    for (const z of axles) if (Math.hypot(c.z - z, c.y - 0.3) < archR + 0.03 && Math.abs(n.x) < 0.5) return UNDER;
    if (Math.abs(n.z) > 0.6 && c.y < 0.6 && Math.abs(c.z) > half - 0.25) return BUMPER;
    return 'paint';
  };
}

/** The glasshouse: side windows and wind screens are glass, the roof is paint. */
const glasshouse: Classify = (_c2, n) => (n.y > 0.85 ? 'paint' : GLASS);

function carModel(kind: 'sedan' | 'hatch' | 'van'): DecorModel {
  const s = CAR_SHAPES[kind];
  const parts = new Parts();
  const H = s.half, W = 1.9;
  const ax = kind === 'hatch' ? 1.25 : kind === 'van' ? 1.45 : 1.35;
  const r = kind === 'van' ? 0.36 : 0.33, archR = r + 0.1, y0 = 0.3;
  const axles = [-ax, ax];
  // lower body: bumper, bonnet up to the windscreen, belt line, boot / tailgate, rear bumper, sills with arches
  const nose: [number, number][] = kind === 'van'
    ? [[-H, y0], [-H - 0.03, 0.6], [-H + 0.05, 0.95], [-H + 0.45, s.belt - 0.02], [s.cabin[0], s.belt]]
    : [[-H, y0], [-H - 0.03, 0.55], [-H + 0.05, 0.8], [-H + 0.4, s.belt - 0.06], [s.cabin[0], s.belt]];
  const tail: [number, number][] = kind === 'van'
    ? [[H, s.belt], [H + 0.02, 0.6], [H - 0.02, y0]]
    : [[s.cabin[1], s.belt], [H - 0.1, s.belt - (kind === 'hatch' ? 0 : 0.02)], [H + 0.02, 0.8], [H + 0.03, 0.55], [H - 0.03, y0]];
  const lower: [number, number][] = [...nose, ...tail, ...arch(ax, y0, archR, false), ...arch(-ax, y0, archR, false)];
  parts.add(profile(lower, W), lowerBody(H, axles, archR));
  if (kind === 'van') {
    // cab with its windows, then the cargo box (all paint)
    const front: [number, number][] = [[s.cabin[0], s.belt], [-H + 1.15, s.roof - 0.05], [-H + 1.5, s.roof], [-H + 1.5, s.belt]];
    parts.add(profile(front, 1.86), glasshouse);
    parts.add(profile([[-H + 1.5, s.belt], [-H + 1.5, s.roof], [H, s.roof], [H, s.belt]], 1.86), 'paint');
  } else {
    const [a, b] = s.cabin;
    const roofA = kind === 'hatch' ? a + 0.55 : a + 0.5, roofB = kind === 'hatch' ? b - 0.3 : b - 0.62;
    parts.add(profile([[a, s.belt], [roofA, s.roof], [roofB, s.roof], [b, s.belt]], 1.72), glasshouse);
    // B pillars
    const mid = (roofA + roofB) / 2 + 0.1;
    for (const x of [-1, 1]) parts.add(box(x * 0.865, (s.belt + s.roof) / 2, mid, 0.02, s.roof - s.belt, 0.1), 'paint');
  }
  // grille, mirrors, door handles
  parts.add(box(0, kind === 'van' ? 0.72 : 0.62, -H - 0.025, 0.85, 0.12, 0.02), BUMPER);
  for (const x of [-1, 1]) parts.add(box(x * 1.0, s.belt + 0.08, s.cabin[0] + 0.15, 0.12, 0.08, 0.07), 'paint');
  wheels(parts, 0.8, r, 0.24, axles);
  return parts.build();
}

function busModel(): DecorModel {
  const parts = new Parts();
  const H = 5.8, W = 2.5, top = 3.12, y0 = 0.3, ax = [-3.9, 3.6], archR = 0.62;
  const body: [number, number][] = [
    [-H, y0], [-H - 0.06, 0.5], [-H - 0.06, top - 0.25], [-H + 0.08, top], [H - 0.12, top], [H + 0.02, top - 0.2], [H + 0.02, 0.5], [H - 0.02, y0],
    ...arch(ax[1], y0, archR, false), ...arch(ax[0], y0, archR, false),
  ];
  const lowerB = lowerBody(H, ax, archR);
  // a dark skirt along the bottom of the walls
  parts.add(profile(body, W, 0.05), (c, n) => (n.y > -0.5 && c.y < 0.55 && Math.abs(n.y) < 0.5 && Math.abs(n.x) < 0.5 ? BUMPER : lowerB(c, n)));
  // window band with pillars, the doors on the kerb side (+X), wind screen and rear window
  for (const x of [-1, 1]) {
    parts.add(box(x * 1.252, 2.1, 0.1, 0.01, 1.3, 10.6), GLASS);
    for (let z = -4.8; z <= 5.3; z += 1.45) parts.add(box(x * 1.257, 2.1, z, 0.01, 1.3, 0.12), 'paint');
  }
  for (const z of [-4.75, 0.35]) parts.add(box(1.262, 1.55, z, 0.01, 2.3, 1.1), 0x2f3d48);
  parts.add(box(0, 1.85, -H - 0.07, 2.25, 1.7, 0.01), GLASS);
  parts.add(box(0, 2.3, H + 0.03, 1.9, 0.8, 0.01), GLASS);
  // roof unit
  parts.add(box(0, top + 0.12, 1.2, 1.4, 0.24, 2.4), 0xd9d8d0);
  wheels(parts, 1.08, 0.5, 0.3, ax);
  return parts.build();
}

function lampModel(): DecorModel {
  const parts = new Parts();
  const POLE = 0x2f3a33, HEAD = 0x262b28;
  parts.add(new CylinderGeometry(0.15, 0.17, 0.45, 8).translate(0, 0.225, 0), POLE);
  parts.add(new CylinderGeometry(0.055, 0.085, 4.6, 8).translate(0, 2.75, 0), POLE);
  const arm = new CubicBezierCurve3(new Vector3(0, 4.9, 0), new Vector3(0, 5.25, 0.1), new Vector3(0, 5.2, 0.85), new Vector3(0, 5.0, 1.15));
  parts.add(new TubeGeometry(arm, 8, 0.035, 5), POLE);
  // a shade like a flat pyramid over the light
  parts.add(new CylinderGeometry(0.1, 0.24, 0.16, 4).rotateY(Math.PI / 4).scale(1, 1, 0.7).translate(0, 4.93, 1.22), HEAD);
  return parts.build();
}

let cache: Partial<Record<DecorKind, DecorModel>> | null = null;
/** The model of a decor kind (built once). */
export function decorModel(kind: DecorKind): DecorModel {
  cache ??= {};
  return (cache[kind] ??= kind === 'bus' ? busModel() : kind === 'lamp' ? lampModel() : carModel(kind));
}

// --- trees -----------------------------------------------------------------------------------------

/**
 * Canopy blob: a low-poly ball with three bands of shade baked into the vertex colours (lit top, shaded
 * underside) — reads as foliage in the pixel look even where the sun does not reach. Multiplied by the
 * instance colour.
 */
export function canopyGeometry(): BufferGeometry {
  const g = new IcosahedronGeometry(1, 1).toNonIndexed();
  return bandShade(g, [0.62, 0.86, 1.08]);
}

/** Pine tier: an open-bottomed cone with a shaded lower rim. */
export function pineGeometry(): BufferGeometry {
  const g = new ConeGeometry(1, 1, 7, 2, false).translate(0, 0.5, 0).toNonIndexed();
  return bandShade(g, [0.6, 0.82, 1.0]);
}

/** Per triangle: a shade picked by its height in the geometry's bounds (bands, no smooth ramp). */
function bandShade(g: BufferGeometry, bands: number[]): BufferGeometry {
  g.computeBoundingBox();
  const lo = g.boundingBox!.min.y, hi = g.boundingBox!.max.y;
  const p = g.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i += 3) {
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const k = bands[Math.min(bands.length - 1, Math.floor(((y - lo) / (hi - lo)) * bands.length))];
    for (let j = 0; j < 3; j++) col.set([k, k, k], (i + j) * 3);
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** Tree species, picked per tree from its position (the map data only says tree or bush). */
export type TreeSpecies = 'round' | 'pine' | 'poplar';
export function treeSpecies(pos: ArrayLike<number>): TreeSpecies {
  const h = Math.abs(Math.sin(pos[0] * 12.9898 + pos[1] * 78.233 + pos[2] * 37.719) * 43758.5453) % 1;
  return h < 0.5 ? 'round' : h < 0.78 ? 'pine' : 'poplar';
}
