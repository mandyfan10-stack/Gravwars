import {
  BufferGeometry, CylinderGeometry, Group, IcosahedronGeometry, LatheGeometry, Line, LineBasicMaterial, Mesh, MeshPhysicalMaterial,
  MeshStandardMaterial, Quaternion, Scene, SphereGeometry, Vector2, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Pickup, Pickups } from '../../shared/economy';
import type { Fishing } from '../../shared/fishing';

const Y = new Vector3(0, 1, 0);
const _q = new Quaternion();

/** Apple: a slightly squashed low-poly ball with a stem and a leaf (one merged geometry per material). */
function appleMeshes() {
  const body = new IcosahedronGeometry(0.085, 1).scale(1, 0.88, 1).translate(0, 0.075, 0);
  const stem = new CylinderGeometry(0.006, 0.008, 0.045, 4).translate(0, 0.16, 0);
  const leaf = new SphereGeometry(0.03, 4, 2).scale(1, 0.2, 0.5).rotateZ(0.5).translate(0.03, 0.165, 0);
  const g = new Group();
  g.add(new Mesh(body, new MeshStandardMaterial({ color: 0xb8322a, roughness: 0.45, flatShading: true })));
  g.add(new Mesh(mergeGeometries([stem, leaf]), new MeshStandardMaterial({ color: 0x5a6b2a, roughness: 0.9, flatShading: true })));
  return g;
}

/** Empty bottle lying on its side: green glass, lathe profile. */
function bottleMeshes() {
  const pts = [[0, 0], [0.034, 0], [0.036, 0.01], [0.036, 0.15], [0.03, 0.18], [0.013, 0.215], [0.012, 0.26], [0.015, 0.265], [0.0, 0.265]]
    .map(([x, y]) => new Vector2(x, y));
  const glass = new LatheGeometry(pts, 10).translate(0, -0.13, 0).rotateZ(Math.PI / 2).translate(0, 0.036, 0);
  const label = new CylinderGeometry(0.0375, 0.0375, 0.07, 10, 1, true).rotateZ(Math.PI / 2).translate(0.02, 0.036, 0);
  const g = new Group();
  g.add(new Mesh(glass, new MeshPhysicalMaterial({ color: 0x3f7a3a, roughness: 0.15, metalness: 0, transmission: 0, transparent: true, opacity: 0.88 })));
  g.add(new Mesh(label, new MeshStandardMaterial({ color: 0xd9cfb3, roughness: 0.9 })));
  return g;
}

/** Items lying on the map. Each pickup gets a mesh once; visibility follows the simulation. */
export class PickupView {
  private readonly meshes = new Map<number, Group>();

  constructor(scene: Scene, private pickups: Pickups) {
    const apple = appleMeshes();
    const bottle = bottleMeshes();
    for (const it of pickups.items) {
      const g = (it.kind === 'apple' ? apple : bottle).clone();
      g.traverse((o) => { o.castShadow = true; });
      this.place(g, it);
      scene.add(g);
      this.meshes.set(it.id, g);
    }
  }

  private place(g: Group, it: Pickup) {
    g.position.copy(it.pos);
    // random yaw around the local up, fixed per item
    g.quaternion.setFromUnitVectors(Y, it.up).multiply(_q.setFromAxisAngle(Y, (it.id * 2.399) % (Math.PI * 2)));
  }

  /** `near`: item in reach gets a gentle bob so it reads as interactive. */
  update(time: number, near: Pickup | null) {
    for (const it of this.pickups.items) {
      const g = this.meshes.get(it.id)!;
      if (g.visible !== it.alive || !g.position.equals(it.pos)) this.place(g, it);
      g.visible = it.alive;
      if (it === near) g.position.copy(it.pos).addScaledVector(it.up, 0.04 + Math.sin(time * 6) * 0.03);
    }
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
