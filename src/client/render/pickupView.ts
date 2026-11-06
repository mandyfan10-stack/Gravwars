import {
  BoxGeometry, BufferGeometry, CylinderGeometry, Group, IcosahedronGeometry, LatheGeometry, Line, LineBasicMaterial, Mesh, MeshPhysicalMaterial,
  MeshStandardMaterial, Quaternion, Scene, SphereGeometry, Vector2, Vector3,
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

/** Items lying on the map. Each pickup gets a mesh when it shows up; meshes of items gone for good are removed. */
export class PickupView {
  private readonly meshes = new Map<number, Group>();
  private readonly protos: Record<PickupKind, Group> = {
    apple: appleMeshes(), bottle: bottleMeshes(), cash: cashMeshes(), fish: fishMeshes(), medkit: medkitMeshes(),
  };

  constructor(private scene: Scene, private pickups: Pickups) {
    this.sync();
  }

  private sync() {
    for (const it of this.pickups.items) {
      if (this.meshes.has(it.id)) continue;
      const g = this.protos[it.kind].clone();
      g.scale.setScalar(PICKUP_SCALE);
      g.traverse((o) => { o.castShadow = true; });
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

  /** `near`: item in reach gets a gentle bob so it reads as interactive. */
  update(time: number, near: Pickup | null) {
    this.sync();
    for (const it of this.pickups.items) {
      const g = this.meshes.get(it.id)!;
      if (g.visible !== it.alive || !g.position.equals(it.pos)) this.place(g, it);
      g.visible = it.alive;
      if (it === near) g.position.copy(it.pos).addScaledVector(it.up, 0.06 + Math.sin(time * 6) * 0.05);
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
