import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import type { MapData } from './map';

export type Rapier = typeof RAPIER;
export type PhysicsWorld = InstanceType<typeof RAPIER.World>;

let ready: Promise<Rapier> | null = null;

export function initRapier(): Promise<Rapier> {
  if (!ready) ready = RAPIER.init().then(() => RAPIER);
  return ready;
}

/** Builds static colliders from map data. Same code runs on the client and on the server. */
export function buildPhysicsWorld(R: Rapier, map: MapData): PhysicsWorld {
  const world = new R.World({ x: 0, y: 0, z: 0 });
  const add = (desc: InstanceType<typeof R.ColliderDesc> | null) => {
    if (desc) world.createCollider(desc);
  };
  for (const b of map.boxes) {
    if (!b.collide) continue;
    add(R.ColliderDesc.cuboid(b.half[0], b.half[1], b.half[2])
      .setTranslation(b.pos[0], b.pos[1], b.pos[2])
      .setRotation({ x: b.quat[0], y: b.quat[1], z: b.quat[2], w: b.quat[3] }));
  }
  for (const b of map.buildings) {
    add(R.ColliderDesc.cuboid(b.half[0], b.half[1], b.half[2])
      .setTranslation(b.pos[0], b.pos[1], b.pos[2])
      .setRotation({ x: b.quat[0], y: b.quat[1], z: b.quat[2], w: b.quat[3] }));
  }
  for (const h of map.hulls) {
    if (!h.collide) continue;
    add(R.ColliderDesc.convexHull(new Float32Array(h.points)));
  }
  const q = new Quaternion();
  const v = new Vector3();
  for (const h of map.houses) {
    q.set(h.quat[0], h.quat[1], h.quat[2], h.quat[3]);
    const [w, hh, d] = h.size;
    // walls
    v.set(0, hh / 2, 0).applyQuaternion(q);
    add(R.ColliderDesc.cuboid(w / 2, hh / 2, d / 2)
      .setTranslation(h.pos[0] + v.x, h.pos[1] + v.y, h.pos[2] + v.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
    // gable roof prism (ridge along local X), slight overhang
    const pts: number[] = [];
    const ow = w / 2;
    const od = d / 2 + 0.35;
    const eave = hh - (h.roofH * 0.35) / (d / 2);
    for (const p of [[-ow, eave, -od], [ow, eave, -od], [-ow, eave, od], [ow, eave, od], [-ow, hh, 0], [ow, hh, 0], [-ow, hh + h.roofH, 0], [ow, hh + h.roofH, 0]]) {
      v.set(p[0], p[1], p[2]).applyQuaternion(q);
      pts.push(h.pos[0] + v.x, h.pos[1] + v.y, h.pos[2] + v.z);
    }
    add(R.ColliderDesc.convexHull(new Float32Array(pts)));
  }
  for (const t of map.trees) {
    if (t.kind !== 'tree') continue;
    const th = 1.6 * t.scale;
    const r = 0.18 * t.scale;
    q.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...t.up));
    add(R.ColliderDesc.cuboid(r, th / 2, r)
      .setTranslation(t.pos[0] + t.up[0] * th / 2, t.pos[1] + t.up[1] * th / 2, t.pos[2] + t.up[2] * th / 2)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
  }
  const c = map.coreHalf;
  add(R.ColliderDesc.cuboid(c, c, c));
  world.step();
  return world;
}