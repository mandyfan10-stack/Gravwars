import { MeshStandardMaterial, Texture, Vector2 } from 'three';
import { trackTexture } from './texFilter';

/**
 * Interior mapping ("rooms behind the windows"): where the glass mask is white, the facade becomes a window into a
 * fake room. The view ray is traced inside a box per room cell (back wall, side walls, floor, ceiling) in the wall's
 * own tangent frame, built from screen-space derivatives, so it works on any facade with metre-scaled UVs.
 * Each room gets its own colours from a hash of its cell: wallpaper, floor, a lit or unlit lamp, sometimes curtains,
 * a picture and a piece of furniture against the back wall. No extra geometry, one texture lookup for the mask.
 */
export interface RoomsOptions {
  /** Glass mask (white = glass). */
  mask: Texture;
  /** Rooms per UV unit along u and v (UV 0..1 covers `metres` metres). */
  cells: [number, number];
  /** Size of one UV unit, m. */
  metres: number;
  /** Room depth, m. */
  depth: number;
  /** Variation between materials using the shader. */
  seed: number;
  /** Colour variety between rooms, 0 (all neutral) .. 1 (wallpapers, curtains). */
  variety?: number;
  /** How much of the facade texture's own glass colour stays (tinted / mirrored glass), 0..1. */
  glassTint?: number;
}

const GLSL_PARS = /* glsl */ `
uniform sampler2D roomMask;
uniform vec2 roomCells;
uniform float roomMetres;
uniform float roomDepth;
uniform float roomSeed;
uniform float roomVariety;
uniform float roomTint;
float roomHash(vec2 p, float k) { return fract(sin(dot(p, vec2(127.1, 311.7)) + roomSeed * 17.0 + k * 91.3) * 43758.5453); }
vec3 roomPick(float h, vec3 a, vec3 b, vec3 c, vec3 d) { return h < 0.25 ? a : h < 0.5 ? b : h < 0.75 ? c : d; }
`;

const GLSL_MAIN = /* glsl */ `
{
  float wm = texture2D(roomMask, vMapUv).r;
  // derivatives in uniform control flow (inside the branch they are undefined at the glass edge)
  vec3 P = -vViewPosition;
  vec3 dpx = dFdx(P), dpy = dFdy(P);
  vec2 duvx = dFdx(vMapUv), duvy = dFdy(vMapUv);
  // no UV gradient (flat-mapped bits like gables): nothing to trace
  if (wm > 0.01 && abs(duvx.x * duvy.y - duvx.y * duvy.x) > 1e-14) {
    vec3 N = normalize(cross(dpx, dpy));
    vec3 V = normalize(vViewPosition);
    if (dot(N, V) < 0.0) N = -N;
    vec3 dp2perp = cross(dpy, N), dp1perp = cross(N, dpx);
    vec3 T = dp2perp * duvx.x + dp1perp * duvy.x;
    vec3 B = dp2perp * duvx.y + dp1perp * duvy.y;
    T *= inversesqrt(max(dot(T, T), 1e-20));
    B *= inversesqrt(max(dot(B, B), 1e-20));
    // view ray in room space (metres): x along u, y up the facade, z into the building
    vec3 d = normalize(vec3(dot(-V, T), dot(-V, B), max(dot(V, N), 0.02)));
    // keep every component away from zero (the far-plane division below)
    d = sign(d + 1e-7) * max(abs(d), vec3(1e-4));
    vec2 cellUV = vMapUv * roomCells;
    vec2 id = floor(cellUV);
    vec2 size = roomMetres / roomCells;
    vec3 box = vec3(size, roomDepth);
    vec3 o = vec3(fract(cellUV) * size, 0.0);
    vec3 far = (step(0.0, d) * box - o) / d;
    float t = min(min(far.x, far.y), far.z);
    vec3 h = (o + d * t) / box;

    float lit = step(roomHash(id, 1.0), 0.38);
    vec3 wall = roomPick(roomHash(id, 2.0), vec3(0.78, 0.74, 0.66), vec3(0.62, 0.70, 0.66), vec3(0.66, 0.68, 0.76), vec3(0.80, 0.72, 0.62));
    vec3 floorC = roomPick(roomHash(id, 3.0), vec3(0.42, 0.28, 0.17), vec3(0.30, 0.30, 0.32), vec3(0.50, 0.38, 0.26), vec3(0.36, 0.22, 0.20));
    vec3 col;
    if (t == far.z) {
      col = wall;
      // a picture / shelf and a low piece of furniture against the back wall
      float px = roomHash(id, 4.0) * 0.5 + 0.15;
      if (h.x > px && h.x < px + 0.22 && h.y > 0.5 && h.y < 0.72) col = roomPick(roomHash(id, 5.0), vec3(0.25, 0.32, 0.45), vec3(0.55, 0.30, 0.22), vec3(0.20, 0.35, 0.25), vec3(0.85, 0.80, 0.70));
      float fx = roomHash(id, 6.0) * 0.4 + 0.1;
      if (h.x > fx && h.x < fx + 0.45 && h.y < 0.28) col = floorC * 0.55;
    } else if (t == far.x) {
      col = wall * 0.82;
    } else if (d.y < 0.0) {
      col = floorC;
    } else {
      col = vec3(0.86);
      // ceiling lamp
      col += lit * vec3(1.6, 1.25, 0.8) * smoothstep(0.18, 0.0, length(h.xz - vec2(0.5, 0.5)));
    }
    // light: dim daylight from the window, deeper is darker; lit rooms are warm and bright
    float light = mix(1.0, 0.45, h.z);
    col *= mix(vec3(0.2, 0.21, 0.24), vec3(0.72, 0.58, 0.4), lit) * light;
    // curtains at the sides of some windows, right behind the glass
    vec2 w01 = fract(cellUV);
    if (roomHash(id, 7.0) < 0.4 * roomVariety && (w01.x < 0.2 || w01.x > 0.8))
      col = roomPick(roomHash(id, 8.0), vec3(0.55, 0.20, 0.18), vec3(0.75, 0.70, 0.55), vec3(0.25, 0.32, 0.45), vec3(0.42, 0.45, 0.30)) * mix(0.45, 0.8, lit);
    // office towers: mostly neutral rooms; far away the glass is mostly a mirror
    col = mix(vec3(dot(col, vec3(0.3, 0.55, 0.15))), col, roomVariety);
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    float farFade = 1.0 - 0.65 * smoothstep(50.0, 180.0, length(P));
    vec3 add = wm * col * (1.0 - fres) * 0.85 * farFade * (1.0 - roomTint * 0.6);
    // never let a degenerate pixel poison the frame (bloom would spread a NaN everywhere)
    if (!(add.x >= 0.0 && add.y >= 0.0 && add.z >= 0.0 && add.x < 100.0)) add = vec3(0.0);
    totalEmissiveRadiance += add;
  }
}
`;

/** Add the rooms to a facade material (keeps any shader patch already on it). */
export function withRooms(mat: MeshStandardMaterial, o: RoomsOptions): MeshStandardMaterial {
  const prev = mat.onBeforeCompile;
  const prevKey = Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey') ? mat.customProgramCacheKey.bind(mat) : () => '';
  const uniforms = {
    roomMask: { value: trackTexture(o.mask) },
    roomCells: { value: new Vector2(...o.cells) },
    roomMetres: { value: o.metres },
    roomDepth: { value: o.depth },
    roomSeed: { value: o.seed },
    roomVariety: { value: o.variety ?? 1 },
    roomTint: { value: o.glassTint ?? 0 },
  };
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    Object.assign(sh.uniforms, uniforms);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_PARS}`)
      // glass: dark albedo and smooth, so the sky reflects in it and the room shows through
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float roomGlass = texture2D(roomMask, vMapUv).r;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * mix(0.05, 1.0, roomTint), roomGlass);
        roughnessFactor = mix(roughnessFactor, 0.1, roomGlass);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${GLSL_MAIN}`);
  };
  mat.customProgramCacheKey = () => `${prevKey()}|rooms`;
  return mat;
}
