import { Quaternion, Vector3 } from 'three';
import { DEFAULT_MOVEMENT } from './constants';
import type { CrateDef, MapData } from './map';
import type { PhysicsWorld, Rapier } from './physics';

type Body = ReturnType<PhysicsWorld['createRigidBody']>;

/** A crate / barrel that went into the void comes back to its spot after this long, s. */
const RETURN_AFTER = 45;
/** Mass, kg: a crate by its size, a barrel is full. */
const crateMass = (c: CrateDef) => (c.kind === 'barrel' ? 60 : Math.max(15, 120 * c.half[0] * c.half[1] * c.half[2]));

/** Rigid bodies of the map's crates, made with the world (`buildPhysicsWorld`); index = index in `map.crates`. */
export const crateBodies = new WeakMap<PhysicsWorld, Body[]>();

/** Dynamic, asleep until something hits it; the face's gravity is a constant force (the world has none). */
export function createCrateBody(R: Rapier, world: PhysicsWorld, c: CrateDef): Body {
  const body = world.createRigidBody(R.RigidBodyDesc.dynamic()
    .setTranslation(c.pos[0], c.pos[1], c.pos[2])
    .setRotation({ x: c.quat[0], y: c.quat[1], z: c.quat[2], w: c.quat[3] })
    .setLinearDamping(0.35).setAngularDamping(0.6).setSleeping(true).setCcdEnabled(true));
  const shape = c.kind === 'crate' ? R.ColliderDesc.cuboid(c.half[0], c.half[1], c.half[2]) : R.ColliderDesc.cylinder(c.half[1], c.half[0]);
  world.createCollider(shape.setMass(crateMass(c)).setFriction(0.8).setRestitution(0.1), body);
  const down = new Vector3(0, -1, 0).applyQuaternion(new Quaternion(...c.quat));
  body.addForce(down.multiplyScalar(crateMass(c) * DEFAULT_MOVEMENT.gravity), false);
  body.sleep(); // attaching the collider woke it up
  return body;
}

/**
 * Loose crates and barrels: kicked, shot, blown away. Each falls along its own face's gravity. The physics world is
 * stepped only while one of them moves (everything else in the world is static or moved by hand).
 */
export class Props {
  readonly bodies: Body[];
  private readonly index = new Map<number, number>();
  /** Fallen out of the cube: seconds until it comes back to its spot. */
  private readonly away = new Map<number, number>();
  /** Crates that moved since the renderer last looked (it clears the set). */
  readonly moved = new Set<number>();

  private readonly mass: number[];

  constructor(private world: PhysicsWorld, private map: MapData) {
    this.bodies = crateBodies.get(world) ?? [];
    this.bodies.forEach((b, i) => this.index.set(b.collider(0).handle, i));
    this.mass = map.crates.map(crateMass);
  }

  /** Crate index of a collider, or -1. */
  of(handle: number): number {
    return this.index.get(handle) ?? -1;
  }

  pos(i: number, out = new Vector3()) {
    const t = this.bodies[i].translation();
    return out.set(t.x, t.y, t.z);
  }

  quat(i: number, out = new Quaternion()) {
    const r = this.bodies[i].rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }

  /** Change the crate's velocity by `dv` m/s (whatever its mass), pushed at `at` (spins it) or at the centre. */
  push(i: number, dv: Vector3, at?: Vector3) {
    const b = this.bodies[i];
    const m = this.mass[i];
    const j = { x: dv.x * m, y: dv.y * m, z: dv.z * m };
    if (at) b.applyImpulseAtPoint(j, { x: at.x, y: at.y, z: at.z }, true);
    else b.applyImpulse(j, true);
    this.moved.add(i);
  }

  /** Crates in a cone in front of `eye` (kick): their indices. */
  inCone(eye: Vector3, dir: Vector3, reach: number, cos: number): number[] {
    const out: number[] = [];
    const p = new Vector3();
    this.bodies.forEach((_, i) => {
      if (this.away.has(i)) return;
      this.pos(i, p).sub(eye);
      const half = Math.max(...this.map.crates[i].half);
      const d = p.length();
      if (d > reach + half || d < 1e-3) return;
      // close crates count even a little off the cone (they fill the view)
      if (p.dot(dir) / d < cos - half / Math.max(d, 0.5) * 0.5) return;
      out.push(i);
    });
    return out;
  }

  /** A blast: every crate within `radius` flies away from it, up to `speed` m/s at the centre. */
  explosion(pos: Vector3, radius: number, speed: number) {
    const p = new Vector3();
    this.bodies.forEach((_, i) => {
      if (this.away.has(i)) return;
      this.pos(i, p);
      const d = p.distanceTo(pos);
      if (d > radius + 1) return;
      const k = Math.max(0.25, 1 - d / (radius + 1));
      p.sub(pos);
      if (p.lengthSq() < 1e-4) p.set(0, 1, 0);
      this.push(i, p.normalize().multiplyScalar(speed * k));
    });
  }

  /** Physics for moving crates; a crate that fell out of the cube waits, then is put back on its spot. */
  tick(dt: number) {
    let awake = false;
    const lim = this.map.cube.half + this.map.voidMargin;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const left = this.away.get(i);
      if (left !== undefined) {
        if (left - dt > 0) { this.away.set(i, left - dt); continue; }
        this.away.delete(i);
        const c = this.map.crates[i];
        b.setTranslation({ x: c.pos[0], y: c.pos[1], z: c.pos[2] }, false);
        b.setRotation({ x: c.quat[0], y: c.quat[1], z: c.quat[2], w: c.quat[3] }, false);
        b.setLinvel({ x: 0, y: 0, z: 0 }, false);
        b.setAngvel({ x: 0, y: 0, z: 0 }, false);
        b.setEnabled(true);
        b.sleep();
        this.moved.add(i);
        awake = true;
        continue;
      }
      if (b.isSleeping()) continue;
      awake = true;
      this.moved.add(i);
      const t = b.translation();
      if (Math.max(Math.abs(t.x), Math.abs(t.y), Math.abs(t.z)) > lim) {
        b.setEnabled(false);
        this.away.set(i, RETURN_AFTER);
      }
    }
    if (awake) {
      this.world.timestep = dt;
      this.world.step();
    }
  }

  /** Is this crate in play (not lost in the void)? */
  present(i: number) {
    return !this.away.has(i);
  }

  /** For the renderer: does any crate still move? */
  get active() {
    return this.bodies.some((b, i) => !this.away.has(i) && !b.isSleeping());
  }

  /** Not used by the game: lets tests find a crate near a point. */
  nearest(p: Vector3): number {
    let best = -1, bestD = Infinity;
    const q = new Vector3();
    for (let i = 0; i < this.bodies.length; i++) {
      const d = this.pos(i, q).distanceToSquared(p);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
}
