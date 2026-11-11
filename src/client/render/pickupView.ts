import {
  BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Group, IcosahedronGeometry, LatheGeometry, Line, LineBasicMaterial,
  Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Quaternion, Scene, SphereGeometry, Vector2, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ItemId, Pickup, PickupKind, Pickups } from '../../shared/economy';
import type { Fishing } from '../../shared/fishing';
import type { Throws } from '../../shared/throwables';

const Y = new Vector3(0, 1, 0);
const _q = new Quaternion();
const _ax = new Vector3();
/** Items on the ground are drawn this much bigger than life: easy to spot from a distance. */
export const PICKUP_SCALE = 2.5;

/** Apple: a slightly squashed low-poly ball with a stem and a leaf (one merged geometry per material). */
export function appleMeshes() {
  const body = new IcosahedronGeometry(0.085, 1).scale(1, 0.88, 1).translate(0, 0.075, 0);
  const stem = new CylinderGeometry(0.006, 0.008, 0.045, 4).translate(0, 0.16, 0);
  const leaf = new SphereGeometry(0.03, 4, 2).scale(1, 0.2, 0.5).rotateZ(0.5).translate(0.03, 0.165, 0);
  const g = new Group();
  g.add(new Mesh(body, new MeshStandardMaterial({ color: 0xb8322a, roughness: 0.45, flatShading: true })));
  g.add(new Mesh(mergeGeometries([stem, leaf]), new MeshStandardMaterial({ color: 0x5a6b2a, roughness: 0.9, flatShading: true })));
  return g;
}

/** Empty bottle lying on its side: green glass, lathe profile. */
export function bottleMeshes() {
  const pts = [[0, 0], [0.034, 0], [0.036, 0.01], [0.036, 0.15], [0.03, 0.18], [0.013, 0.215], [0.012, 0.26], [0.015, 0.265], [0.0, 0.265]]
    .map(([x, y]) => new Vector2(x, y));
  const glass = new LatheGeometry(pts, 10).translate(0, -0.13, 0).rotateZ(Math.PI / 2).translate(0, 0.036, 0);
  const label = new CylinderGeometry(0.0375, 0.0375, 0.07, 10, 1, true).rotateZ(Math.PI / 2).translate(0.02, 0.036, 0);
  const g = new Group();
  g.add(new Mesh(glass, new MeshPhysicalMaterial({ color: 0x3f7a3a, roughness: 0.15, metalness: 0, transmission: 0, transparent: true, opacity: 0.88 })));
  g.add(new Mesh(label, new MeshStandardMaterial({ color: 0xd9cfb3, roughness: 0.9 })));
  return g;
}

/** Fish lying on its side: a flattened body, a tail fin, a darker back. */
export function fishMeshes() {
  const body = new SphereGeometry(0.05, 8, 5).scale(2.4, 0.42, 1).translate(0, 0.022, 0);
  const tail = new BoxGeometry(0.06, 0.012, 0.075).translate(-0.14, 0.022, 0);
  const g = new Group();
  g.add(new Mesh(body, new MeshStandardMaterial({ color: 0x8c9aa3, roughness: 0.35, metalness: 0.3, flatShading: true })));
  g.add(new Mesh(tail, new MeshStandardMaterial({ color: 0x5c6870, roughness: 0.6, flatShading: true })));
  return g;
}

/** First-aid kit: a white case with a red cross and a dark handle. */
export function medkitMeshes() {
  const g = new Group();
  const red = new MeshStandardMaterial({ color: 0xc8322c, roughness: 0.6 });
  g.add(new Mesh(new BoxGeometry(0.16, 0.07, 0.11).translate(0, 0.035, 0), new MeshStandardMaterial({ color: 0xece8de, roughness: 0.7 })));
  g.add(new Mesh(mergeGeometries([
    new BoxGeometry(0.06, 0.004, 0.018).translate(0, 0.071, 0), new BoxGeometry(0.018, 0.004, 0.06).translate(0, 0.071, 0),
  ]), red));
  g.add(new Mesh(new BoxGeometry(0.06, 0.015, 0.012).translate(0, 0.078, 0), new MeshStandardMaterial({ color: 0x33363c, roughness: 0.8 })));
  return g;
}

/** Meshes of one item (unscaled, real size). */
export function itemMeshes(kind: ItemId): Group {
  return kind === 'apple' ? appleMeshes() : kind === 'bottle' ? bottleMeshes() : kind === 'fish' ? fishMeshes() : medkitMeshes();
}

/** A wad of banknotes with a band (dropped by bandits). */
function cashMeshes() {
  const g = new Group();
  const notes = new Mesh(new BoxGeometry(0.16, 0.035, 0.075).translate(0, 0.018, 0), new MeshStandardMaterial({ color: 0x8aa37a, roughness: 0.9 }));
  const band = new Mesh(new BoxGeometry(0.03, 0.038, 0.078).translate(0, 0.019, 0), new MeshStandardMaterial({ color: 0xd8cfa8, roughness: 0.8 }));
  g.add(notes, band);
  return g;
}

/** Ammo box with brass cartridges on top. */
function ammoMeshes() {
  const g = new Group();
  const box = new Mesh(new BoxGeometry(0.15, 0.08, 0.09).translate(0, 0.04, 0), new MeshStandardMaterial({ color: 0x46543c, roughness: 0.75 }));
  const stripe = new Mesh(new BoxGeometry(0.154, 0.02, 0.094).translate(0, 0.055, 0), new MeshStandardMaterial({ color: 0xd9a83e, roughness: 0.5 }));
  const brass = new MeshStandardMaterial({ color: 0xe6b84c, roughness: 0.3, metalness: 0.7 });
  for (const x of [-0.04, 0, 0.04]) {
    g.add(new Mesh(new CylinderGeometry(0.011, 0.011, 0.04, 6).translate(x, 0.095, 0), brass));
  }
  g.add(box, stripe);
  return g;
}

/** Stack of wooden planks / beams. */
function woodMeshes() {
  const g = new Group();
  const mat = new MeshStandardMaterial({ color: 0xb88248, roughness: 0.85 });
  const dark = new MeshStandardMaterial({ color: 0x7c5228, roughness: 0.9 });
  g.add(new Mesh(new BoxGeometry(0.18, 0.032, 0.05).translate(0, 0.016, -0.03), mat));
  g.add(new Mesh(new BoxGeometry(0.18, 0.032, 0.05).translate(0, 0.016, 0.03), mat));
  g.add(new Mesh(new BoxGeometry(0.17, 0.032, 0.05).rotateY(0.18).translate(0, 0.048, 0), dark));
  return g;
}

/** Cut stone blocks. */
function stoneMeshes() {
  const g = new Group();
  const mat = new MeshStandardMaterial({ color: 0x96999c, roughness: 0.9, flatShading: true });
  g.add(new Mesh(new BoxGeometry(0.14, 0.06, 0.1).translate(-0.01, 0.03, 0), mat));
  g.add(new Mesh(new BoxGeometry(0.09, 0.05, 0.08).rotateY(0.4).translate(0.03, 0.075, 0.01), mat));
  return g;
}

/** Steel I-beam / ingot bundle. */
function metalMeshes() {
  const g = new Group();
  const mat = new MeshStandardMaterial({ color: 0x8ea0ad, roughness: 0.35, metalness: 0.65 });
  g.add(new Mesh(new BoxGeometry(0.17, 0.022, 0.08).translate(0, 0.011, 0), mat));
  g.add(new Mesh(new BoxGeometry(0.17, 0.04, 0.024).translate(0, 0.042, 0), mat));
  g.add(new Mesh(new BoxGeometry(0.17, 0.022, 0.08).translate(0, 0.073, 0), mat));
  return g;
}

/** Builds an inflated BackSide hull geometry for a crisp 3D outline around a pickup mesh. */
function makeOutlineGeometry(src: BufferGeometry, thickness = 0.009): BufferGeometry {
  const g = src.clone();
  const pos = g.getAttribute('position');
  // Compute averaged smooth normal per shared vertex position so hard-edged boxes expand without gaps
  const sums = new Map<string, Vector3>();
  g.computeVertexNormals();
  const nrm = g.getAttribute('normal');
  const v = new Vector3();
  const n = new Vector3();
  const keyOf = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i);
    const k = keyOf(v.x, v.y, v.z);
    const acc = sums.get(k);
    if (acc) acc.add(n);
    else sums.set(k, n.clone());
  }
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const avg = sums.get(keyOf(v.x, v.y, v.z)) ?? n.fromBufferAttribute(nrm, i);
    if (avg.lengthSq() > 1e-8) avg.normalize();
    out[i * 3] = v.x + avg.x * thickness;
    out[i * 3 + 1] = v.y + avg.y * thickness;
    out[i * 3 + 2] = v.z + avg.z * thickness;
  }
  const res = new BufferGeometry();
  res.setAttribute('position', new BufferAttribute(out, 3));
  if (g.index) res.setIndex(g.index.clone());
  return res;
}

function withPickupOutline(proto: Group): Group {
  const meshes: Mesh[] = [];
  proto.traverse((o) => {
    if (o instanceof Mesh) meshes.push(o);
  });
  const outlineMat = new MeshBasicMaterial({
    color: 0xfff0a8,
    side: BackSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const outlineGroup = new Group();
  outlineGroup.name = 'outline';
  for (const m of meshes) {
    const om = new Mesh(makeOutlineGeometry(m.geometry, 0.009), outlineMat);
    om.position.copy(m.position);
    om.quaternion.copy(m.quaternion);
    om.scale.copy(m.scale);
    outlineGroup.add(om);
  }
  proto.add(outlineGroup);
  return proto;
}

/** Items lying on the map. Each pickup gets a mesh when it shows up; meshes of items gone for good are removed. */
export class PickupView {
  private readonly meshes = new Map<number, Group>();
  private readonly protos: Record<PickupKind, Group> = {
    apple: withPickupOutline(appleMeshes()),
    bottle: withPickupOutline(bottleMeshes()),
    cash: withPickupOutline(cashMeshes()),
    fish: withPickupOutline(fishMeshes()),
    medkit: withPickupOutline(medkitMeshes()),
    ammo: withPickupOutline(ammoMeshes()),
    wood: withPickupOutline(woodMeshes()),
    stone: withPickupOutline(stoneMeshes()),
    metal: withPickupOutline(metalMeshes()),
  };

  constructor(private scene: Scene, private pickups: Pickups) {
    this.sync();
  }

  private sync() {
    for (const it of this.pickups.items) {
      if (this.meshes.has(it.id)) continue;
      const g = this.protos[it.kind].clone();
      // Give each pickup instance its own outline material so `near` highlight is independent
      const outline = g.getObjectByName('outline');
      if (outline) {
        const instMat = new MeshBasicMaterial({
          color: 0xffe88a,
          side: BackSide,
          transparent: true,
          opacity: 0.82,
          depthWrite: false,
        });
        outline.traverse((o) => {
          if (o instanceof Mesh) o.material = instMat;
        });
        g.userData.outlineMat = instMat;
      }
      g.scale.setScalar(PICKUP_SCALE);
      g.traverse((o) => {
        if (o.name !== 'outline' && o.parent?.name !== 'outline') o.castShadow = true;
      });
      this.place(g, it);
      this.scene.add(g);
      this.meshes.set(it.id, g);
    }
    const ids = new Set(this.pickups.items.map((i) => i.id));
    for (const [id, g] of this.meshes) if (!ids.has(id)) { this.scene.remove(g); this.meshes.delete(id); }
  }

  private place(g: Group, it: Pickup) {
    g.position.copy(it.pos);
    // random yaw around the local up, fixed per item
    g.quaternion.setFromUnitVectors(Y, it.up).multiply(_q.setFromAxisAngle(Y, (it.id * 2.399) % (Math.PI * 2)));
  }

  /** Updates pickup transforms (including falling physics) and highlights the outline of `near`. */
  update(time: number, near: Pickup | null) {
    this.sync();
    for (const it of this.pickups.items) {
      const g = this.meshes.get(it.id)!;
      if (g.visible !== it.alive || !g.position.equals(it.pos)) this.place(g, it);
      g.visible = it.alive;
      const mat = g.userData.outlineMat as MeshBasicMaterial | undefined;
      if (mat) {
        if (it === near) {
          mat.color.setHex(0xffffff);
          mat.opacity = 0.95 + 0.05 * Math.sin(time * 10);
        } else {
          mat.color.setHex(0xffe88a);
          mat.opacity = 0.78;
        }
      }
    }
  }
}

/** Items in flight (thrown by hand), tumbling. */
export class ThrownView {
  private readonly meshes = new Map<number, Group>();

  constructor(private scene: Scene, private throws: Throws) {}

  update(dt: number) {
    const live = new Set<number>();
    for (const t of this.throws.items) {
      live.add(t.id);
      let g = this.meshes.get(t.id);
      if (!g) {
        g = itemMeshes(t.kind);
        g.scale.setScalar(PICKUP_SCALE);
        g.traverse((o) => { o.castShadow = true; });
        this.scene.add(g);
        this.meshes.set(t.id, g);
      }
      g.position.copy(t.pos);
      // tumble around an axis across the flight
      _ax.copy(t.vel).cross(t.down);
      if (_ax.lengthSq() > 1e-6) g.quaternion.premultiply(_q.setFromAxisAngle(_ax.normalize(), t.spin * dt));
    }
    for (const [id, g] of this.meshes) if (!live.has(id)) { this.scene.remove(g); this.meshes.delete(id); }
  }
}

/** Bobber on the water and the line from the rod tip. */
export class FishingView {
  private readonly bobber = new Group();
  private readonly line: Line;
  private readonly pts = [new Vector3(), new Vector3()];

  constructor(scene: Scene, private fishing: Fishing) {
    const red = new MeshStandardMaterial({ color: 0xd8382e, roughness: 0.4 });
    const white = new MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.4 });
    const top = new Mesh(new SphereGeometry(0.09, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), red);
    const bottom = new Mesh(new SphereGeometry(0.09, 10, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), white);
    const stick = new Mesh(new CylinderGeometry(0.01, 0.01, 0.12, 4).translate(0, 0.12, 0), red);
    this.bobber.add(top, bottom, stick);
    this.bobber.visible = false;
    this.line = new Line(new BufferGeometry().setFromPoints(this.pts), new LineBasicMaterial({ color: 0xf4f1ea, transparent: true, opacity: 0.7 }));
    this.line.frustumCulled = false;
    this.line.visible = false;
    scene.add(this.bobber, this.line);
  }

  /** `tipWorld`: rod tip position in the world (from the viewmodel), null = rod not in hand. */
  update(time: number, tipWorld: Vector3 | null) {
    const f = this.fishing;
    const out = f.phase === 'cast' || f.phase === 'wait' || f.phase === 'bite';
    this.bobber.visible = this.line.visible = out && !!tipWorld;
    if (!this.bobber.visible || !tipWorld) return;
    const up = f.bobberUp;
    const p = this.bobber.position;
    if (f.phase === 'cast') {
      // arc from the rod tip to the water
      const k = Math.min(1, f.t / f.dur);
      p.lerpVectors(tipWorld, f.bobber, k).addScaledVector(up, Math.sin(k * Math.PI) * 1.2);
    } else {
      // floating; small dips while waiting, real tugs during a bite
      const dip = f.phase === 'bite' ? (Math.sin(time * 22) > 0.2 ? -0.07 : -0.02) : Math.sin(time * 2.2) * 0.008;
      p.copy(f.bobber).addScaledVector(up, dip);
    }
    this.bobber.quaternion.setFromUnitVectors(Y, up);
    this.pts[0].copy(tipWorld);
    this.pts[1].copy(p).addScaledVector(up, 0.12);
    this.line.geometry.setFromPoints(this.pts);
  }
}
