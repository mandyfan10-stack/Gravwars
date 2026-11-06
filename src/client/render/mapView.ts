import {
  Box3, BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DoubleSide,
  Group, IcosahedronGeometry, InstancedMesh, Material, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, Quaternion, Texture, Vector3,
} from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HouseDef, MapData, MatKind } from '../../shared/map';
import { Rng } from '../../shared/math';
import {
  glassFacadeTexture, groundTextures, houseFacadeTextures, officeFacadeTexture, roofTexture,
} from './textures';
import { crystalCluster, CrystalCluster, crystalGeometry, crystalMaterials } from './crystal';
import { withRooms } from './rooms';
import { waterMaterial } from './water';
import { trackTexture } from './texFilter';

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
    sh.uniforms.tintMask = { value: trackTexture(mask) };
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
    water: waterMaterial().material,
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
  /** Draw distance: map regions farther than `far` m from `eye` are not drawn (nor cast shadows). */
  cull(eye: Vector3, far: number): void;
  /** Show / hide a team's bed crystal. */
  setBedAlive(team: string, alive: boolean): void;
}

export function buildMapView(map: MapData): MapView {
  const group = new Group();
  const mats = makeMaterials();
  // regions: every base island, the central city in four quarters. Each has its own batches, so whole regions drop
  // out of view (frustum, shadow pass, draw distance) instead of one map-sized batch being drawn always.
  const regions = new Map<string, { group: Group; box: Box3 }>();
  const regionOf = (x: number, y: number, z: number) => {
    let best = map.islands[0], bd = Infinity;
    for (const i of map.islands) {
      const d = (i.origin[0] - x) ** 2 + (i.origin[1] - y) ** 2 + (i.origin[2] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best.id === 'center' ? `center${x < 0 ? '-' : '+'}${y < 0 ? '-' : '+'}` : best.id;
  };
  /** The region holding a point; `r` = how far the thing reaches around it (for the region's bounds). */
  const region = (pos: ArrayLike<number>, r = 1) => {
    const key = regionOf(pos[0], pos[1], pos[2]);
    let g = regions.get(key);
    if (!g) { g = { group: new Group(), box: new Box3() }; g.group.name = `region:${key}`; group.add(g.group); regions.set(key, g); }
    g.box.expandByPoint(new Vector3(pos[0] - r, pos[1] - r, pos[2] - r)).expandByPoint(new Vector3(pos[0] + r, pos[1] + r, pos[2] + r));
    return g;
  };
  const keyOf = (pos: ArrayLike<number>) => regionOf(pos[0], pos[1], pos[2]);
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
  const byMat = new Map<string, typeof map.boxes>();
  for (const b of map.boxes) {
    if (b.hidden) continue;
    const k = `${keyOf(b.pos)}|${b.mat}`;
    if (!byMat.has(k)) byMat.set(k, []);
    byMat.get(k)!.push(b);
    region(b.pos, Math.max(...b.half));
  }
  for (const [k, list] of byMat) {
    const mat = k.split('|')[1] as MatKind;
    const im = new InstancedMesh(unit, mats[mat], list.length);
    list.forEach((b, i) => {
      m4.compose(p.set(...b.pos), q.set(...b.quat), sc.set(b.half[0] * 2, b.half[1] * 2, b.half[2] * 2));
      im.setMatrixAt(i, m4);
      im.setColorAt(i, col.setHex(b.color));
    });
    im.computeBoundingSphere();
    region(list[0].pos).group.add(shadowy(im, mat !== 'glow' && mat !== 'water'));
  }

  // --- convex hulls, merged per material with vertex colors
  const hullGeo = new Map<string, BufferGeometry[]>();
  for (const h of map.hulls) {
    const pts: Vector3[] = [];
    for (let i = 0; i < h.points.length; i += 3) pts.push(new Vector3(h.points[i], h.points[i + 1], h.points[i + 2]));
    const g = new ConvexGeometry(pts);
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    col.setHex(h.color);
    for (let i = 0; i < n; i++) colors.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new BufferAttribute(colors, 3));
    const at = [h.points[0], h.points[1], h.points[2]];
    region(at, 12);
    const k = `${keyOf(at)}|${h.mat}`;
    if (!hullGeo.has(k)) hullGeo.set(k, []);
    hullGeo.get(k)!.push(g);
  }
  for (const [k, geos] of hullGeo) {
    const [rk, mat] = k.split('|') as [string, MatKind];
    const base = mats[mat];
    const m = base.clone();
    if (base.onBeforeCompile) {
      m.onBeforeCompile = base.onBeforeCompile;
      m.customProgramCacheKey = base.customProgramCacheKey;
    }
    (m as MeshStandardMaterial).vertexColors = true;
    regions.get(rk)!.group.add(shadowy(new Mesh(mergeGeometries(geos), m)));
  }

  // --- old-town houses
  const [fA, fMask, fGlass] = houseFacadeTextures();
  const housesBy = new Map<string, HouseDef[]>();
  for (const h of map.houses) {
    region(h.pos, Math.max(...h.size));
    const k = keyOf(h.pos);
    if (!housesBy.has(k)) housesBy.set(k, []);
    housesBy.get(k)!.push(h);
  }
  // rooms behind the windows: one 3 × 3 m bay per room
  const wallMat = withRooms(tintMasked(new MeshStandardMaterial({ map: fA, vertexColors: true, roughness: 0.9 }), fMask),
    { mask: fGlass, cells: [4, 4], metres: 12, depth: 3.5, seed: 1 });
  const roofMat = new MeshStandardMaterial({ map: roofTexture(), vertexColors: true, roughness: 0.8, side: DoubleSide });
  for (const [k, list] of housesBy) {
    const houses = buildHouses(list);
    regions.get(k)!.group.add(shadowy(new Mesh(houses.walls, wallMat)), shadowy(new Mesh(houses.roofs, roofMat)));
  }

  // --- skyscrapers and office blocks
  const [glassA, glassMask] = glassFacadeTexture();
  const [officeA, officeMask] = officeFacadeTexture();
  const towerWall = withRooms(new MeshStandardMaterial({
    map: glassA, roughness: 0.18, metalness: 0.55, vertexColors: true, envMapIntensity: 1.4,
  }), { mask: glassMask, cells: [3, 4], metres: 12, depth: 6, seed: 2, variety: 0.25, glassTint: 0.45 });
  const officeWall = withRooms(new MeshStandardMaterial({ map: officeA, roughness: 0.85, vertexColors: true }),
    { mask: officeMask, cells: [4, 4], metres: 12, depth: 5, seed: 3, variety: 0.35, glassTint: 0.2 });
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
    region(b.pos, Math.max(hx, hy, hz)).group.add(shadowy(mesh));
  }

  // --- trees and bushes (instanced trunks + low-poly canopy blobs), batched per region
  const trunkGeo = new CylinderGeometry(0.11, 0.17, 1, 6).translate(0, 0.5, 0);
  const trunkMat = new MeshStandardMaterial({ color: 0x6b4f37, roughness: 1 });
  const blobGeo = new IcosahedronGeometry(1, 1);
  const blobMat = new MeshStandardMaterial({ roughness: 0.95, flatShading: true });
  const forest = new Map<string, { trunks: Matrix4[]; blobs: { pos: Vector3; r: number; color: number }[] }>();
  const trng = new Rng(77);
  const Y = new Vector3(0, 1, 0);
  const greens = [0x4f7f35, 0x5e8d3b, 0x6d9a41, 0x47722f, 0x7aa34a];
  for (const t of map.trees) {
    region(t.pos, 4 * t.scale);
    const k = keyOf(t.pos);
    if (!forest.has(k)) forest.set(k, { trunks: [], blobs: [] });
    const f = forest.get(k)!;
    const up = new Vector3(...t.up);
    q.setFromUnitVectors(Y, up);
    const base = new Vector3(...t.pos);
    if (t.kind === 'tree') {
      const th = 1.9 * t.scale;
      f.trunks.push(new Matrix4().compose(base, q, sc.set(t.scale, th, t.scale)));
      const c = base.clone().addScaledVector(up, th + 0.9 * t.scale);
      f.blobs.push({ pos: c, r: 1.45 * t.scale, color: trng.pick(greens) });
      for (let k2 = 0; k2 < 3; k2++) {
        const off = new Vector3(trng.range(-1, 1), trng.range(-0.4, 0.6), trng.range(-1, 1)).applyQuaternion(q).multiplyScalar(0.8 * t.scale);
        f.blobs.push({ pos: c.clone().add(off), r: trng.range(0.8, 1.1) * t.scale, color: trng.pick(greens) });
      }
    } else {
      const c = base.clone().addScaledVector(up, 0.45 * t.scale);
      for (let k2 = 0; k2 < 2; k2++) {
        const off = new Vector3(trng.range(-0.5, 0.5), 0, trng.range(-0.5, 0.5)).applyQuaternion(q).multiplyScalar(t.scale);
        f.blobs.push({ pos: c.clone().add(off), r: trng.range(0.55, 0.8) * t.scale, color: trng.pick(greens) });
      }
    }
  }
  for (const [k, f] of forest) {
    const g = regions.get(k)!.group;
    if (f.trunks.length) {
      const trunkMesh = new InstancedMesh(trunkGeo, trunkMat, f.trunks.length);
      f.trunks.forEach((m, i) => trunkMesh.setMatrixAt(i, m));
      trunkMesh.computeBoundingSphere();
      g.add(shadowy(trunkMesh));
    }
    const blobMesh = new InstancedMesh(blobGeo, blobMat, Math.max(1, f.blobs.length));
    f.blobs.forEach((b, i) => {
      q.setFromAxisAngle(new Vector3(trng.range(-1, 1), 1, trng.range(-1, 1)).normalize(), trng.range(0, 6));
      m4.compose(b.pos, q, sc.setScalar(b.r));
      blobMesh.setMatrixAt(i, m4);
      blobMesh.setColorAt(i, col.setHex(b.color));
    });
    blobMesh.count = f.blobs.length;
    blobMesh.computeBoundingSphere();
    g.add(shadowy(blobMesh));
  }

  // --- bed crystals (no collider; hidden when the bed is broken) + small floating markers above them
  const spinners: { mesh: Object3D; up: Vector3; base: Vector3; phase: number }[] = [];
  const clusters: CrystalCluster[] = [];
  const beds = new Map<string, Object3D[]>();
  map.statues.forEach((s, i) => {
    const up = new Vector3(...s.up);
    const cluster = crystalCluster(s.color, 17 + i * 31);
    cluster.group.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), up);
    cluster.group.position.set(...s.bed);
    group.add(cluster.group);
    clusters.push(cluster);
    const mark = new Mesh(crystalGeometry(0.32, 1.1, new Rng(i + 5)), crystalMaterials(s.color).core);
    beds.set(s.team, [cluster.group, mark]);
    mark.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), up);
    const base = new Vector3(...s.pos);
    mark.position.copy(base);
    group.add(mark);
    spinners.push({ mesh: mark, up, base, phase: Math.random() * 6 });
  });

  const water = mats.water;
  return {
    group,
    setBedAlive(team, alive) {
      for (const o of beds.get(team) ?? []) o.visible = alive;
    },
    cull(eye, far) {
      for (const r of regions.values()) r.group.visible = r.box.distanceToPoint(eye) < far;
    },
    update(time, dt) {
      water.userData.update(time);
      for (const c of clusters) if (c.group.visible) c.update(time, dt);
      for (const s of spinners) {
        s.mesh.rotateOnWorldAxis(s.up, dt * 1.2);
        s.mesh.position.copy(s.base).addScaledVector(s.up, Math.sin(time * 1.6 + s.phase) * 0.25);
      }
    },
  };
}
