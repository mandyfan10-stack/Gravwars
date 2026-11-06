import {
  BufferGeometry, Color, CylinderGeometry, Group, LatheGeometry, Material, Mesh, MeshStandardMaterial, Object3D, Quaternion,
  SphereGeometry, TorusGeometry, Vector2, Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { bakeMeshes } from './bake';

/**
 * A plain modern human, procedurally built and rigged, real proportions (1.8 m): no textures, smooth shapes, muted
 * real-world colours. The rig is a tree of Object3D "bones" (pelvis → spine → chest → neck/head, shoulders → upper
 * arm → forearm → hand, hips → thigh → shin → foot); limbs hang along -Y in the rest pose, the body faces +Z and its
 * origin is between the feet on the floor. Outfits: a team soldier (softshell jacket in the team colour, plate
 * carrier, helmet), a street gang member (hoodie, jeans, sneakers), a homeless man (long worn coat, beanie, beard)
 * and a shopkeeper (suit, shirt, tie).
 */
export type Outfit = 'soldier' | 'gang' | 'bum' | 'suit';

/** Rest-pose measurements, metres. */
export const BODY = {
  pelvisY: 0.975,
  spine: 0.14,
  shoulderX: 0.2,
  shoulderY: 0.31,
  upperArm: 0.28,
  foreArm: 0.26,
  hipX: 0.095,
  hipY: -0.02,
  thigh: 0.44,
  shin: 0.43,
  neckY: 0.4,
};

const SKIN = [0xe2b799, 0xcf9c78, 0xb07a58, 0x8c5c40, 0xf0cdb0, 0x6e4632];
const HAIR = [0x2a211b, 0x4a3727, 0x1b1714, 0x6b4c32, 0x9a8670];

// --- shared geometry (one copy for every character)
const geoCache = new Map<string, BufferGeometry>();
function cached(key: string, make: () => BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}
/** Surface of revolution from [radius, y] points listed bottom to top. */
function lathe(key: string, pts: [number, number][], seg = 14, sx = 1, sz = 1) {
  return cached(key, () => {
    const g = new LatheGeometry(pts.map(([r, y]) => new Vector2(r, y)), seg);
    g.scale(sx, 1, sz);
    g.computeVertexNormals();
    return g;
  });
}
/** A limb segment hanging from its joint (y = 0) down to -len, tapering from r0 to r1, rounded ends. */
function limb(key: string, len: number, r0: number, r1: number, sz = 1) {
  const m = (r0 + r1) / 2;
  return lathe(key, [
    [0, -len - r1 * 0.7], [r1 * 0.72, -len - r1 * 0.45], [r1, -len], [m * 1.04, -len * 0.55], [r0 * 1.02, -len * 0.18],
    [r0, 0], [r0 * 0.72, r0 * 0.5], [0, r0 * 0.75],
  ], 12, 1, sz);
}
const sphere = (key: string, sx: number, sy: number, sz: number, w = 16, h = 12, thetaLen = Math.PI) =>
  cached(key, () => new SphereGeometry(1, w, h, 0, Math.PI * 2, 0, thetaLen).scale(sx, sy, sz));
const rbox = (key: string, x: number, y: number, z: number, r: number) => cached(key, () => new RoundedBoxGeometry(x, y, z, 2, r));

export interface HumanRig {
  root: Group;
  /** Falls over when dying (rotates about the feet). */
  fall: Group;
  pelvis: Object3D;
  chest: Object3D;
  head: Object3D;
  upper: [Object3D, Object3D];
  fore: [Object3D, Object3D];
  hand: [Object3D, Object3D];
  thigh: [Object3D, Object3D];
  shin: [Object3D, Object3D];
  foot: [Object3D, Object3D];
  materials: MeshStandardMaterial[];
}

/** Index 0 = left, 1 = right; the character faces +Z, so its left is +X. */
const SIDES = [1, -1] as const;

export function buildHuman(outfit: Outfit, color: number, grime = 0, seed = Math.random()): HumanRig {
  const rand = (() => { let s = Math.floor(seed * 2 ** 31) || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const materials: MeshStandardMaterial[] = [];
  const mat = (c: number | Color, roughness = 0.85, metalness = 0) => {
    const col = new Color(c);
    if (grime > 0) {
      // worn and dirty: duller, browner, darker
      const l = col.r * 0.3 + col.g * 0.59 + col.b * 0.11;
      col.lerp(new Color(l, l, l), 0.4 * grime).multiply(new Color(1 - 0.18 * grime, 1 - 0.24 * grime, 1 - 0.34 * grime));
    }
    const m = new MeshStandardMaterial({ color: col, roughness, metalness });
    materials.push(m);
    return m;
  };
  const skin = mat(SKIN[Math.floor(rand() * SKIN.length)], 0.62);
  const hairC = HAIR[Math.floor(rand() * HAIR.length)];
  const hair = mat(hairC, 0.9);
  const dark = mat(0x16181a, 0.5);
  const team = new Color(color);

  // per outfit: [jacket, sleeves, trousers, shoes, hands]
  let jacket: Material, trousers: Material, shoes: Material, hands: Material;
  if (outfit === 'soldier') {
    jacket = mat(team.clone().multiplyScalar(0.72), 0.8);
    trousers = mat(0x3a3d40, 0.9);
    shoes = mat(0x2b241c, 0.7);
    hands = mat(0x232527, 0.75); // gloves
  } else if (outfit === 'gang') {
    jacket = mat(color, 0.95);
    trousers = mat(0x2c3a52, 0.92); // jeans
    shoes = mat(0xd9d6cf, 0.7); // white sneakers
    hands = skin;
  } else if (outfit === 'bum') {
    jacket = mat(color, 1);
    trousers = mat(0x4a4a46, 1);
    shoes = mat(0x35281c, 0.9);
    hands = skin;
  } else {
    jacket = mat(color, 0.6);
    trousers = mat(color, 0.6);
    shoes = mat(0x111214, 0.35);
    hands = skin;
  }

  const add = (parent: Object3D, geo: BufferGeometry, m: Material, x = 0, y = 0, z = 0) => {
    const mesh = new Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const bone = (parent: Object3D, x: number, y: number, z: number) => {
    const o = new Object3D();
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };

  const root = new Group();
  const fall = new Group();
  root.add(fall);
  const pelvis = bone(fall, 0, BODY.pelvisY, 0);
  // hips and seat (trousers), belt
  add(pelvis, lathe('hips', [[0, -0.11], [0.13, -0.1], [0.162, -0.04], [0.158, 0.04], [0.15, 0.12], [0, 0.13]], 14, 1, 0.68), trousers);
  add(pelvis, cached('belt', () => new CylinderGeometry(0.153, 0.156, 0.04, 14, 1, true).scale(1, 1, 0.7)), outfit === 'suit' ? dark : mat(0x2a2522, 0.6), 0, 0.09, 0);

  const chest = bone(pelvis, 0, BODY.spine, 0);
  // torso: waist → ribcage → shoulders, flattened front to back
  add(chest, lathe('torso', [[0, -0.05], [0.148, -0.05], [0.152, 0.02], [0.165, 0.12], [0.185, 0.24], [0.19, 0.3], [0.165, 0.35], [0.1, 0.385], [0, 0.39]], 16, 1, 0.64), jacket);
  if (outfit === 'soldier') {
    // plate carrier: front and back plates with pouches, team patch
    const vest = mat(0x4a4b42, 0.85);
    add(chest, rbox('plate', 0.28, 0.3, 0.05, 0.015), vest, 0, 0.17, 0.11);
    add(chest, rbox('plateB', 0.28, 0.3, 0.05, 0.015), vest, 0, 0.18, -0.105);
    for (const x of [-0.085, 0, 0.085]) add(chest, rbox('pouch', 0.07, 0.09, 0.04, 0.01), vest, x, 0.07, 0.15);
    add(chest, rbox('patch', 0.09, 0.05, 0.01, 0.004), mat(team.clone().multiplyScalar(1.15), 0.6), 0.06, 0.26, 0.137);
  } else if (outfit === 'gang') {
    // hood lying on the shoulders, front pocket, drawstrings
    add(chest, cached('hood', () => new TorusGeometry(0.11, 0.045, 8, 16).scale(1, 0.75, 1).rotateX(Math.PI / 2 - 0.35)), jacket, 0, 0.36, -0.03);
    add(chest, rbox('pocket', 0.2, 0.09, 0.02, 0.01), jacket, 0, 0.03, 0.105);
    for (const x of [-0.03, 0.03]) add(chest, cached('string', () => new CylinderGeometry(0.004, 0.004, 0.12, 4)), mat(0xe8e4dc, 0.8), x, 0.28, 0.12);
  } else if (outfit === 'bum') {
    // long coat skirt down to the knees, collar turned up
    add(pelvis, lathe('coat', [[0.235, -0.5], [0.215, -0.3], [0.19, -0.1], [0.172, 0.05], [0.16, 0.14]], 14, 1, 0.72), jacket);
    add(chest, cached('collar', () => new CylinderGeometry(0.085, 0.11, 0.08, 12, 1, true)), jacket, 0, 0.39, -0.01);
  } else {
    // shirt front, tie, lapels
    add(chest, cached('shirt', () => new CylinderGeometry(0.0, 0.07, 0.2, 3, 1).rotateZ(Math.PI).scale(1, 1, 0.2)), mat(0xeeeeea, 0.6), 0, 0.29, 0.112);
    add(chest, rbox('tie', 0.03, 0.2, 0.012, 0.004), mat(0x5c1f24, 0.5), 0, 0.24, 0.118);
    add(chest, cached('collarS', () => new CylinderGeometry(0.06, 0.065, 0.035, 12, 1, true)), mat(0xeeeeea, 0.6), 0, 0.395, 0);
  }

  // neck and head
  add(chest, cached('neck', () => new CylinderGeometry(0.05, 0.056, 0.1, 10)), skin, 0, BODY.neckY, 0.005);
  const head = bone(chest, 0, BODY.neckY + 0.03, 0.01);
  add(head, sphere('skull', 0.087, 0.112, 0.1), skin, 0, 0.12, 0);
  add(head, sphere('jaw', 0.074, 0.06, 0.082), skin, 0, 0.055, 0.018);
  add(head, cached('nose', () => new CylinderGeometry(0.004, 0.014, 0.04, 4).rotateX(-0.25)), skin, 0, 0.105, 0.098);
  for (const s of SIDES) {
    add(head, sphere('ear', 0.012, 0.026, 0.018, 8, 6), skin, s * 0.086, 0.11, -0.005);
    add(head, sphere('eye', 0.011, 0.008, 0.006, 8, 6), dark, s * 0.032, 0.128, 0.091);
    add(head, rbox('brow', 0.03, 0.007, 0.008, 0.003), hair, s * 0.033, 0.145, 0.093);
  }
  if (outfit === 'soldier') {
    // ballistic helmet with a team band
    add(head, sphere('helmet', 0.106, 0.105, 0.118, 16, 8, Math.PI / 2), mat(0x3d4038, 0.7), 0, 0.13, -0.005);
    add(head, cached('band', () => new CylinderGeometry(0.107, 0.109, 0.022, 16, 1, true).scale(1, 1, 1.11)), mat(team, 0.6), 0, 0.142, -0.005);
  } else if (outfit === 'bum') {
    add(head, sphere('beanie', 0.095, 0.118, 0.106, 14, 8, Math.PI / 2 + 0.2), mat(0x5a3f33, 1), 0, 0.14, -0.005);
    add(head, sphere('beard', 0.078, 0.06, 0.08, 12, 8), mat(0x5a5048, 1), 0, 0.045, 0.024);
  } else {
    // short hair
    add(head, sphere('hair', 0.093, 0.121, 0.106, 16, 8, Math.PI / 2 + 0.25), hair, 0, 0.124, -0.008);
  }

  // arms
  const upper: Object3D[] = [], fore: Object3D[] = [], hand: Object3D[] = [];
  for (const s of SIDES) {
    const u = bone(chest, s * BODY.shoulderX, BODY.shoulderY, 0);
    add(u, sphere('deltoid', 0.062, 0.06, 0.06), jacket, 0, -0.01, 0);
    add(u, limb('upperArm', BODY.upperArm, 0.054, 0.043), jacket);
    const f = bone(u, 0, -BODY.upperArm, 0);
    add(f, limb('foreArm', BODY.foreArm, 0.043, 0.034), jacket);
    // cuff of skin or glove at the wrist
    const h = bone(f, 0, -BODY.foreArm, 0);
    add(h, rbox('palm', 0.07, 0.085, 0.032, 0.012), hands, 0, -0.05, 0.004);
    add(h, rbox('fingers', 0.068, 0.05, 0.026, 0.011), hands, 0, -0.105, 0.012).rotation.x = 0.5;
    add(h, rbox('thumb', 0.022, 0.05, 0.022, 0.009), hands, s * -0.035, -0.045, 0.02).rotation.z = s * -0.4;
    upper.push(u); fore.push(f); hand.push(h);
  }

  // legs
  const thigh: Object3D[] = [], shin: Object3D[] = [], foot: Object3D[] = [];
  for (const s of SIDES) {
    const t = bone(pelvis, s * BODY.hipX, BODY.hipY, 0);
    add(t, limb('thigh', BODY.thigh, 0.085, 0.058, 0.95), trousers);
    const k = bone(t, 0, -BODY.thigh, 0);
    add(k, limb('shin', BODY.shin, 0.058, 0.043, 0.95), trousers);
    const f = bone(k, 0, -BODY.shin, 0);
    add(f, rbox(outfit === 'gang' ? 'sneaker' : 'shoe', 0.1, 0.085, 0.27, 0.03), shoes, 0, -0.045, 0.05);
    if (outfit === 'gang') add(f, rbox('sole', 0.104, 0.025, 0.274, 0.01), mat(0xf2f0ea, 0.8), 0, -0.078, 0.05);
    thigh.push(t); shin.push(k); foot.push(f);
  }

  // one draw call per bone: every part of a bone baked into one vertex-coloured mesh (~15 per person instead of ~85)
  const body = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  for (const b of [pelvis, chest, head, ...upper, ...fore, ...hand, ...thigh, ...shin, ...foot]) bakeMeshes(b, body, (m) => m.parent === b);
  for (const m of materials) m.dispose();
  materials.length = 0;
  materials.push(body);

  return {
    root, fall, pelvis, chest, head, materials,
    upper: upper as [Object3D, Object3D], fore: fore as [Object3D, Object3D], hand: hand as [Object3D, Object3D],
    thigh: thigh as [Object3D, Object3D], shin: shin as [Object3D, Object3D], foot: foot as [Object3D, Object3D],
  };
}

// --- two-bone IK for the arms (in the chest's space)
const _d = new Vector3();
const _n = new Vector3();
const _e = new Vector3();
const _v = new Vector3();
const _q = new Quaternion();
const _qi = new Quaternion();
const DOWN = new Vector3(0, -1, 0);

/**
 * Point the arm so the wrist reaches `target` (chest space), elbow bending toward `pole`; `w` blends from the
 * arm's current rotations (0) to the solved pose (1).
 */
export function solveArm(upper: Object3D, fore: Object3D, target: Vector3, pole: Vector3, w = 1) {
  const L1 = BODY.upperArm, L2 = BODY.foreArm;
  _d.subVectors(target, upper.position);
  const dist = Math.min(Math.max(_d.length(), 0.05), L1 + L2 - 1e-3);
  _d.normalize();
  // shoulder angle (law of cosines), bent toward the pole in the plane of (dir, pole)
  const a = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist))));
  _n.crossVectors(_d, pole);
  if (_n.lengthSq() < 1e-8) _n.set(1, 0, 0);
  _n.normalize();
  _e.copy(_d).applyAxisAngle(_n, a); // elbow direction
  _q.setFromUnitVectors(DOWN, _e);
  upper.quaternion.slerp(_q, w);
  // forearm: from the elbow to the (reachable) wrist point, in the upper arm's solved space
  _v.copy(_d).multiplyScalar(dist).addScaledVector(_e, -L1); // wrist - elbow, both relative to the shoulder
  _v.normalize().applyQuaternion(_qi.copy(_q).invert());
  _q.setFromUnitVectors(DOWN, _v);
  fore.quaternion.slerp(_q, w);
}
