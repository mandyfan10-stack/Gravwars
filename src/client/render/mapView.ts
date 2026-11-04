import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DoubleSide, EdgesGeometry,
  Group, IcosahedronGeometry, InstancedMesh, LineBasicMaterial, LineSegments, Material, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, OctahedronGeometry, Quaternion, Texture, TorusGeometry, Vector3,
} from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HouseDef, MapData, MatKind } from '../../shared/map';
import { Rng } from '../../shared/math';
import {
  coreTextures, glassFacadeTexture, groundTextures, houseFacadeTextures, officeFacadeTexture, roofTexture,
} from './textures';

/**
 * World-space triplanar detail map (multiplied into the color). Works for instanced boxes of any size and
 * for every gravity orientation, because the world is axis-aligned.
 */
function triplanar(mat: MeshStandardMaterial, map: Texture, metersPerTile: number, scroll = 0): MeshStandardMaterial {
  const uniforms = { triMap: { value: map }, triScale: { value: 1 / metersPerTile }, triTime: { value: 0 } };
  mat.userData.tri = uniforms;
  mat.userData.scroll = scroll;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriN;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        {
          vec4 tp = vec4(transformed, 1.0);
          vec3 tn = objectNormal;
          #ifdef USE_INSTANCING
            tp = instanceMatrix * tp;
            tn = mat3(instanceMatrix) * tn;
          #endif
          vTriPos = (modelMatrix * tp).xyz;
          vTriN = mat3(modelMatrix) * tn;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTriPos; varying vec3 vTriN;
        uniform sampler2D triMap; uniform float triScale; uniform float triTime;`)
      .replace('#include <map_fragment>', `
        {
          vec3 bw = pow(abs(normalize(vTriN)), vec3(4.0));
          bw /= (bw.x + bw.y + bw.z);
          vec3 tp = vTriPos * triScale + vec3(triTime);
          vec4 tx = texture2D(triMap, tp.yz) * bw.x + texture2D(triMap, tp.xz) * bw.y + texture2D(triMap, tp.xy) * bw.z;
          diffuseColor *= tx;
        }`);
  };
  mat.customProgramCacheKey = () => 'tri';
  return mat;
}

/** Albedo map whose tinted part (mask = white) is multiplied by vertex color, the rest (frames, glass) is not. */
function tintMasked(mat: MeshStandardMaterial, mask: Texture): MeshStandardMaterial {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.tintMask = { value: mask };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tintMask;')
      .replace('#include <color_fragment>', '')
      .replace('#include <map_fragment>', `
        {
          vec4 tc = texture2D(map, vMapUv);
          float k = texture2D(tintMask, vMapUv).r;
          diffuseColor.rgb *= tc.rgb * mix(vec3(1.0), vec3(vColor.rgb), k);
        }`);
  };
  mat.customProgramCacheKey = () => 'tintMask';
  return mat;
}

function makeMaterials(): Record<MatKind, Material> {
  const t = groundTextures();
  const std = (o: ConstructorParameters<typeof MeshStandardMaterial>[0]) => new MeshStandardMaterial(o);
  return {
    concrete: triplanar(std({ roughness: 0.92 }), t.concrete, 4),
    asphalt: triplanar(std({ roughness: 0.95 }), t.asphalt, 3),
    paving: triplanar(std({ roughness: 0.88 }), t.paving, 2),
    grass: triplanar(std({ roughness: 1 }), t.grass, 3),
    water: triplanar(std({ roughness: 0.08, metalness: 0.25, envMapIntensity: 1.2 }), t.water, 5, 1),
    dirt: std({ roughness: 1, flatShading: true }),
    rock: std({ roughness: 1, flatShading: true }),
    metal: std({ roughness: 0.45, metalness: 0.6 }),
    car: std({ roughness: 0.25, metalness: 0.5 }),
    glass: std({ roughness: 0.05, metalness: 0.9 }),
    paint: std({ roughness: 0.75 }),
    plaster: triplanar(std({ roughness: 0.9 }), t.plaster, 3),
    stone: triplanar(std({ roughness: 0.85 }), t.stone, 2),
    test: std({ roughness: 0.55 }),
    glow: new MeshBasicMaterial({ color: new Color(2.2, 2.2, 2.2) }),
  };
}

/** Builds merged geometry for every old-town house: walls with facade UVs + gabled tile roofs. */
function buildHouses(houses: HouseDef[]): { walls: BufferGeometry; roofs: BufferGeometry } {
  const wall = { pos: [] as number[], nrm: [] as number[], uv: [] as number[], col: [] as number[] };
  const roof = { pos: [] as number[], nrm: [] as number[], uv: [] as number[], col: [] as number[] };
  const q = new Quaternion();
  const o = new Vector3();
  const tmp = new Vector3();
  const e1 = new Vector3();
  const e2 = new Vector3();
  const n = new Vector3();
  const col = new Color();
  const rng = new Rng(99);
  type Buf = typeof wall;
  const tri = (b: Buf, p: number[][], uv: number[][]) => {
    const w = p.map((v) => tmp.set(v[0], v[1], v[2]).applyQuaternion(q).add(o).toArray());
    e1.fromArray(w[1]).sub(e2.fromArray(w[0]));
    e2.fromArray(w[2]).sub(tmp.fromArray(w[0]));
    n.crossVectors(e1, e2).normalize();
    for (let i = 0; i < 3; i++) {
      b.pos.push(...w[i]);
      b.nrm.push(n.x, n.y, n.z);
      b.uv.push(uv[i][0], uv[i][1]);
      b.col.push(col.r, col.g, col.b);
    }
  };
  const quad = (b: Buf, p: number[][], uv: number[][]) => {
    tri(b, [p[0], p[1], p[2]], [uv[0], uv[1], uv[2]]);
    tri(b, [p[0], p[2], p[3]], [uv[0], uv[2], uv[3]]);
  };
  const F = 12; // facade texture size in meters
  for (const h of houses) {
    q.set(...h.quat);
    o.set(...h.pos);
    const [w, ht, d] = h.size;
    const x = w / 2;
    const z = d / 2;
    const u0 = rng.int(0, 3) / 4; // pick a random column of the atlas
    col.setHex(h.wall);
    const side = (a: number[], b: number[], len: number) => {
      // a→b along the bottom edge (CCW seen from outside)
      quad(wall, [[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], ht, b[1]], [a[0], ht, a[1]]],
        [[u0, 0], [u0 + len / F, 0], [u0 + len / F, ht / F], [u0, ht / F]]);
    };
    side([-x, z], [x, z], w);
    side([x, -z], [-x, -z], w);
    side([x, z], [x, -z], d);
    side([-x, -z], [-x, z], d);
    // gable triangles (plain plaster: sample the top margin of a cell)
    const pu = [0.005, 0.99];
    tri(wall, [[x, ht, z], [x, ht, -z], [x, ht + h.roofH, 0]], [pu, pu, pu]);
    tri(wall, [[-x, ht, -z], [-x, ht, z], [-x, ht + h.roofH, 0]], [pu, pu, pu]);
    // roof slopes with overhang
    col.setHex(h.roof);
    const ox = x + 0.15;
    const oz = z + 0.35;
    const eave = ht - (h.roofH * 0.35) / z;
    const slope = Math.hypot(oz, h.roofH + (ht - eave));
    const R = 2;
    quad(roof, [[-ox, eave, oz], [ox, eave, oz], [ox, ht + h.roofH, 0], [-ox, ht + h.roofH, 0]],
      [[0, 0], [ox * 2 / R, 0], [ox * 2 / R, slope / R], [0, slope / R]]);
    quad(roof, [[ox, eave, -oz], [-ox, eave, -oz], [-ox, ht + h.roofH, 0], [ox, ht + h.roofH, 0]],
      [[0, 0], [ox * 2 / R, 0], [ox * 2 / R, slope / R], [0, slope / R]]);
    // chimney
    if (rng.chance(0.6)) {
      col.setHex(0x9a6a50);
      const cx = rng.range(-x * 0.6, x * 0.6);
      const cz = rng.pick([-1, 1]) * z * 0.35;
      const y0 = ht + h.roofH * 0.4;
      const y1 = ht + h.roofH + 0.9;
      const s = 0.35;
      const cu = [0.005, 0.99];
      for (const [a, b] of [[[-s, s], [s, s]], [[s, -s], [-s, -s]], [[s, s], [s, -s]], [[-s, -s], [-s, s]]] as number[][][])
        quad(roof, [[cx + a[0], y0, cz + a[1]], [cx + b[0], y0, cz + b[1]], [cx + b[0], y1, cz + b[1]], [cx + a[0], y1, cz + a[1]]],
          [cu, cu, cu, cu]);
    }
  }
  const make = (b: Buf) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(b.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(b.nrm), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(b.uv), 2));
    g.setAttribute('color', new BufferAttribute(new Float32Array(b.col), 3));
    g.computeBoundingSphere();
    return g;
  };
  return { walls: make(wall), roofs: make(roof) };
}

export interface MapView {
  group: Group;
  update(time: number, dt: number): void;
  /** Show / hide a team's bed crystal. */
  setBedAlive(team: string, alive: boolean): void;
}

export function buildMapView(map: MapData): MapView {
  const group = new Group();
  const mats = makeMaterials();
  const unit = new BoxGeometry(1, 1, 1);
  const m4 = new Matrix4();
  const p = new Vector3();
  const q = new Quaternion();
  const sc = new Vector3();
  const col = new Color();
  const shadowy = (o: Object3D, cast = true) => {
    o.castShadow = cast;
    o.receiveShadow = true;
    return o;
  };

  // --- instanced boxes (one draw call per material)
  const byMat = new Map<MatKind, typeof map.boxes>();
  for (const b of map.boxes) {
    if (!byMat.has(b.mat)) byMat.set(b.mat, []);
    byMat.get(b.mat)!.push(b);
  }
  for (const [mat, list] of byMat) {
    const im = new InstancedMesh(unit, mats[mat], list.length);
    list.forEach((b, i) => {
      m4.compose(p.set(...b.pos), q.set(...b.quat), sc.set(b.half[0] * 2, b.half[1] * 2, b.half[2] * 2));
      im.setMatrixAt(i, m4);
      im.setColorAt(i, col.setHex(b.color));
    });
    im.computeBoundingSphere();
    group.add(shadowy(im, mat !== 'glow' && mat !== 'water'));
  }

  // --- convex hulls, merged per material with vertex colors
  const hullGeo = new Map<MatKind, BufferGeometry[]>();
  for (const h of map.hulls) {
    const pts: Vector3[] = [];
    for (let i = 0; i < h.points.length; i += 3) pts.push(new Vector3(h.points[i], h.points[i + 1], h.points[i + 2]));
    const g = new ConvexGeometry(pts);
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    col.setHex(h.color);
    for (let i = 0; i < n; i++) colors.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new BufferAttribute(colors, 3));
    if (!hullGeo.has(h.mat)) hullGeo.set(h.mat, []);
    hullGeo.get(h.mat)!.push(g);
  }
  for (const [mat, geos] of hullGeo) {
    const base = mats[mat];
    const m = base.clone();
    if (base.onBeforeCompile) {
      m.onBeforeCompile = base.onBeforeCompile;
      m.customProgramCacheKey = base.customProgramCacheKey;
    }
    (m as MeshStandardMaterial).vertexColors = true;
    group.add(shadowy(new Mesh(mergeGeometries(geos), m)));
  }

  // --- old-town houses
  const [fA, fMask] = houseFacadeTextures();
  const houses = buildHouses(map.houses);
  const wallMat = tintMasked(new MeshStandardMaterial({ map: fA, vertexColors: true, roughness: 0.9 }), fMask);
  const roofMat = new MeshStandardMaterial({ map: roofTexture(), vertexColors: true, roughness: 0.8, side: DoubleSide });
  group.add(shadowy(new Mesh(houses.walls, wallMat)), shadowy(new Mesh(houses.roofs, roofMat)));

  // --- skyscrapers and office blocks
  const towerWall = new MeshStandardMaterial({
    map: glassFacadeTexture(), roughness: 0.18, metalness: 0.55, vertexColors: true, envMapIntensity: 1.4,
  });
  const officeWall = new MeshStandardMaterial({ map: officeFacadeTexture(), roughness: 0.85, vertexColors: true });
  const roofTop = triplanar(new MeshStandardMaterial({ roughness: 0.95, color: 0x9d9a93 }), groundTextures().concrete, 4);
  for (const b of map.buildings) {
    const [hx, hy, hz] = b.half;
    const g = new BoxGeometry(hx * 2, hy * 2, hz * 2);
    const uv = g.getAttribute('uv') as BufferAttribute;
    const F = 12;
    const faceSize: [number, number][] = [[hz * 2, hy * 2], [hz * 2, hy * 2], [hx * 2, hz * 2], [hx * 2, hz * 2], [hx * 2, hy * 2], [hx * 2, hy * 2]];
    for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * faceSize[f][0] / F, uv.getY(i) * faceSize[f][1] / F);
    }
    const colors = new Float32Array(uv.count * 3);
    col.setHex(b.color);
    for (let i = 0; i < uv.count; i++) colors.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new BufferAttribute(colors, 3));
    const wm = b.style === 'tower' ? towerWall : officeWall;
    const mesh = new Mesh(g, [wm, wm, roofTop, roofTop, wm, wm]);
    mesh.position.set(...b.pos);
    mesh.quaternion.set(...b.quat);
    group.add(shadowy(mesh));
  }

  // --- trees and bushes (instanced trunks + low-poly canopy blobs)
  const trunks = map.trees.filter((t) => t.kind === 'tree');
  const blobs: { pos: Vector3; r: number; color: number }[] = [];
  const trunkMesh = new InstancedMesh(new CylinderGeometry(0.11, 0.17, 1, 6).translate(0, 0.5, 0),
    new MeshStandardMaterial({ color: 0x6b4f37, roughness: 1 }), Math.max(1, trunks.length));
  const trng = new Rng(77);
  const Y = new Vector3(0, 1, 0);
  let ti = 0;
  for (const t of map.trees) {
    const up = new Vector3(...t.up);
    q.setFromUnitVectors(Y, up);
    const base = new Vector3(...t.pos);
    const greens = [0x4f7f35, 0x5e8d3b, 0x6d9a41, 0x47722f, 0x7aa34a];
    if (t.kind === 'tree') {
      const th = 1.9 * t.scale;
      m4.compose(base, q, sc.set(t.scale, th, t.scale));
      trunkMesh.setMatrixAt(ti++, m4);
      const c = base.clone().addScaledVector(up, th + 0.9 * t.scale);
      const g = trng.pick(greens);
      blobs.push({ pos: c, r: 1.45 * t.scale, color: g });
      for (let k = 0; k < 3; k++) {
        const off = new Vector3(trng.range(-1, 1), trng.range(-0.4, 0.6), trng.range(-1, 1)).applyQuaternion(q).multiplyScalar(0.8 * t.scale);
        blobs.push({ pos: c.clone().add(off), r: trng.range(0.8, 1.1) * t.scale, color: trng.pick(greens) });
      }
    } else {
      const c = base.clone().addScaledVector(up, 0.45 * t.scale);
      for (let k = 0; k < 2; k++) {
        const off = new Vector3(trng.range(-0.5, 0.5), 0, trng.range(-0.5, 0.5)).applyQuaternion(q).multiplyScalar(t.scale);
        blobs.push({ pos: c.clone().add(off), r: trng.range(0.55, 0.8) * t.scale, color: trng.pick(greens) });
      }
    }
  }
  trunkMesh.count = ti;
  group.add(shadowy(trunkMesh));
  const blobMesh = new InstancedMesh(new IcosahedronGeometry(1, 1),
    new MeshStandardMaterial({ roughness: 0.95, flatShading: true }), Math.max(1, blobs.length));
  blobs.forEach((b, i) => {
    q.setFromAxisAngle(new Vector3(trng.range(-1, 1), 1, trng.range(-1, 1)).normalize(), trng.range(0, 6));
    m4.compose(b.pos, q, sc.setScalar(b.r));
    blobMesh.setMatrixAt(i, m4);
    blobMesh.setColorAt(i, col.setHex(b.color));
  });
  blobMesh.count = blobs.length;
  blobMesh.computeBoundingSphere();
  group.add(shadowy(blobMesh));

  // --- central island core: sandstone with golden runes
  const c = map.coreHalf * 2;
  const [cA, cE] = coreTextures();
  cA.repeat.set(10, 10);
  cE.repeat.set(10, 10);
  const core = new Mesh(new BoxGeometry(c, c, c), new MeshStandardMaterial({
    map: cA, emissiveMap: cE, emissive: new Color(1.4, 1.1, 0.6), roughness: 0.8,
  }));
  group.add(shadowy(core));
  const edges = new LineSegments(new EdgesGeometry(new BoxGeometry(c + 0.05, c + 0.05, c + 0.05)),
    new LineBasicMaterial({ color: new Color(2.4, 1.7, 0.6) }));
  group.add(edges);

  // --- bed crystals (no collider; hidden when the bed is broken) + small floating markers above them
  const spinners: { mesh: Mesh; up: Vector3; base: Vector3; phase: number }[] = [];
  const beds = new Map<string, Object3D[]>();
  const octa = new OctahedronGeometry(0.7);
  const unitOcta = new OctahedronGeometry(1);
  for (const s of map.statues) {
    const crystal = new Mesh(unitOcta, new MeshBasicMaterial({ color: new Color(s.color).multiplyScalar(1.6) }));
    crystal.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...s.up));
    crystal.scale.set(0.9, 2.2, 0.9);
    crystal.position.set(...s.bed);
    group.add(crystal);
    const m = new Mesh(octa, new MeshBasicMaterial({ color: new Color(s.color).multiplyScalar(2.5) }));
    beds.set(s.team, [crystal, m]);
    const up = new Vector3(...s.up);
    m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), up);
    const base = new Vector3(...s.pos);
    m.position.copy(base);
    group.add(m);
    spinners.push({ mesh: m, up, base, phase: Math.random() * 6 });
  }

  // --- lift / geyser rings
  const rings: { mesh: Mesh; base: Vector3; up: Vector3; t: number }[] = [];
  const ringGeo = new TorusGeometry(1.1, 0.06, 6, 32);
  for (const pad of map.pads) {
    const up = new Vector3(...pad.up);
    const base = new Vector3(...pad.pos);
    const color = pad.kind === 'lift' ? 0x4ad8ff : 0xb05cff;
    for (let i = 0; i < 4; i++) {
      const mat = new MeshBasicMaterial({
        color: new Color(color).multiplyScalar(2), transparent: true, blending: AdditiveBlending,
        depthWrite: false, side: DoubleSide,
      });
      const m = new Mesh(ringGeo, mat);
      m.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), up);
      group.add(m);
      rings.push({ mesh: m, base, up, t: i / 4 });
    }
  }

  const water = mats.water as MeshStandardMaterial;
  return {
    group,
    setBedAlive(team, alive) {
      for (const o of beds.get(team) ?? []) o.visible = alive;
    },
    update(time, dt) {
      water.userData.tri.triTime.value = time * 0.03;
      for (const s of spinners) {
        s.mesh.rotateOnWorldAxis(s.up, dt * 1.2);
        s.mesh.position.copy(s.base).addScaledVector(s.up, Math.sin(time * 1.6 + s.phase) * 0.25);
      }
      for (const r of rings) {
        r.t = (r.t + dt * 0.6) % 1;
        r.mesh.position.copy(r.base).addScaledVector(r.up, r.t * 5);
        r.mesh.scale.setScalar(1 - r.t * 0.5);
        (r.mesh.material as MeshBasicMaterial).opacity = 1 - r.t;
      }
    },
  };
}
