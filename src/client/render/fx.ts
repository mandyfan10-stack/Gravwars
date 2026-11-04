import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, Color, Group, IcosahedronGeometry, InstancedMesh,
  Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PointLight, Points, PointsMaterial, Quaternion, Scene,
  SphereGeometry, Vector3,
} from 'three';
import type { Combat, CombatEvent } from '../../shared/combat';

const MAX_TRACERS = 128;
const MAX_SPARKS = 900;
const Z = new Vector3(0, 0, 1);
const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _b = new Vector3();
const _d = new Vector3();

interface Blast { mesh: Mesh; ring: Mesh; t: number; radius: number; alive: boolean }

/** Tracers, grenades, explosions and sparks driven by combat events. */
export class Fx {
  readonly group = new Group();
  private tracers: InstancedMesh;
  /** Visual offset of a bullet that left the eye: makes it appear from the gun muzzle. */
  private muzzleOffset = new Map<number, { off: Vector3; start: Vector3 }>();
  private grenades = new Map<number, Mesh>();
  private grenadePool: Mesh[] = [];
  private grenadeGeo = new SphereGeometry(0.11, 12, 8);
  private grenadeMat = new MeshStandardMaterial({ color: 0x3d5a2a, roughness: 0.6, metalness: 0.3, emissive: new Color(0, 0, 0) });
  private blasts: Blast[] = [];
  private lights: { light: PointLight; t: number }[] = [];
  private sparks: Points;
  private sPos: Float32Array;
  private sCol: Float32Array;
  private sVel: Float32Array;
  private sLife: Float32Array;
  private sBase: Float32Array;
  private sNext = 0;
  /** Down direction for cosmetic particles (the local player's gravity). */
  readonly down = new Vector3(0, -1, 0);

  constructor(scene: Scene) {
    scene.add(this.group);
    this.tracers = new InstancedMesh(new BoxGeometry(1, 1, 1).translate(0, 0, -0.5),
      new MeshBasicMaterial({ color: new Color(5, 3.6, 1.6), transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }),
      MAX_TRACERS);
    this.tracers.frustumCulled = false;
    this.tracers.count = 0;
    this.group.add(this.tracers);

    const geo = new BufferGeometry();
    this.sPos = new Float32Array(MAX_SPARKS * 3);
    this.sCol = new Float32Array(MAX_SPARKS * 3);
    this.sVel = new Float32Array(MAX_SPARKS * 3);
    this.sLife = new Float32Array(MAX_SPARKS);
    this.sBase = new Float32Array(MAX_SPARKS * 4);
    geo.setAttribute('position', new BufferAttribute(this.sPos, 3));
    geo.setAttribute('color', new BufferAttribute(this.sCol, 3));
    this.sparks = new Points(geo, new PointsMaterial({
      size: 0.09, vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false,
    }));
    this.sparks.frustumCulled = false;
    this.group.add(this.sparks);

    const blastGeo = new IcosahedronGeometry(1, 2);
    const ringGeo = new SphereGeometry(1, 24, 12);
    for (let i = 0; i < 6; i++) {
      const mesh = new Mesh(blastGeo, new MeshBasicMaterial({ color: new Color(3, 1.25, 0.3), transparent: true, blending: AdditiveBlending, depthWrite: false }));
      const ring = new Mesh(ringGeo, new MeshBasicMaterial({ color: new Color(0.9, 0.75, 0.6), transparent: true, depthWrite: false, opacity: 0.3 }));
      mesh.visible = ring.visible = false;
      this.group.add(mesh, ring);
      this.blasts.push({ mesh, ring, t: 0, radius: 1, alive: false });
    }
    // constant number of lights → no shader recompiles when explosions happen
    for (let i = 0; i < 2; i++) {
      const light = new PointLight(0xffa040, 0, 18, 1.6);
      this.group.add(light);
      this.lights.push({ light, t: 1 });
    }
  }

  spark(pos: Vector3, vel: Vector3, color: Color, life: number) {
    const i = this.sNext;
    this.sNext = (this.sNext + 1) % MAX_SPARKS;
    pos.toArray(this.sPos, i * 3);
    vel.toArray(this.sVel, i * 3);
    this.sLife[i] = life;
    this.sBase[i * 4] = color.r;
    this.sBase[i * 4 + 1] = color.g;
    this.sBase[i * 4 + 2] = color.b;
    this.sBase[i * 4 + 3] = life;
  }

  burst(pos: Vector3, normal: Vector3 | null, n: number, speed: number, color: Color, life = 0.4) {
    for (let k = 0; k < n; k++) {
      _d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      if (normal) {
        if (_d.dot(normal) < 0) _d.reflect(normal);
        _d.addScaledVector(normal, 0.6).normalize();
      }
      this.spark(pos, _d.multiplyScalar(speed * (0.3 + Math.random() * 0.7)), color, life * (0.5 + Math.random() * 0.5));
    }
  }

  /** Register where the local player's bullets visually start. */
  setMuzzle(projectileId: number, eye: Vector3, muzzle: Vector3) {
    this.muzzleOffset.set(projectileId, { off: muzzle.clone().sub(eye), start: eye.clone() });
  }

  handle(e: CombatEvent) {
    if (e.type === 'impact') {
      this.burst(e.pos, e.normal, 10, 6, new Color(3, 2.2, 1.2), 0.35);
      this.burst(e.pos, e.normal, 5, 1.5, new Color(0.5, 0.45, 0.4), 0.6);
    } else if (e.type === 'fizzle') {
      this.burst(e.pos, null, 14, 3, new Color(2, 0.8, 3.5), 0.5);
    } else if (e.type === 'hit') {
      this.burst(e.pos, null, e.head ? 18 : 10, 4, e.head ? new Color(4, 1, 0.6) : new Color(3, 0.6, 0.5), 0.35);
    } else if (e.type === 'bounce') {
      this.burst(e.pos, null, 3, 1.5, new Color(1.5, 1.2, 0.8), 0.25);
    } else if (e.type === 'explode') {
      const b = this.blasts.find((x) => !x.alive) ?? this.blasts[0];
      b.alive = true;
      b.t = 0;
      b.radius = e.radius;
      b.mesh.position.copy(e.pos);
      b.ring.position.copy(e.pos);
      b.mesh.visible = b.ring.visible = true;
      const l = this.lights.reduce((x, y) => (x.t > y.t ? x : y));
      l.t = 0;
      l.light.position.copy(e.pos);
      this.burst(e.pos, null, 70, 14, new Color(5, 2.6, 0.9), 0.7);
      this.burst(e.pos, null, 30, 5, new Color(0.9, 0.8, 0.7), 1.2);
    }
  }

  update(dt: number, combat: Combat, time: number) {
    // tracers for live bullets
    let n = 0;
    const live = new Set<number>();
    for (const p of combat.projectiles) {
      if (!p.alive) continue;
      live.add(p.id);
      if (p.weapon === 'rifle') {
        if (n >= MAX_TRACERS) continue;
        const mo = this.muzzleOffset.get(p.id);
        _b.copy(p.pos);
        if (mo) {
          const k = Math.max(0, 1 - p.pos.distanceTo(mo.start) / 12);
          _b.addScaledVector(mo.off, k);
        }
        const sp = p.vel.length();
        const len = Math.min(sp * 0.035, p.age * sp + 0.3);
        _d.copy(p.vel).divideScalar(sp);
        _q.setFromUnitVectors(Z, _d);
        _m.compose(_b, _q, _s.set(0.025, 0.025, len));
        this.tracers.setMatrixAt(n++, _m);
      } else {
        let g = this.grenades.get(p.id);
        if (!g) {
          g = this.grenadePool.pop() ?? new Mesh(this.grenadeGeo, this.grenadeMat.clone());
          this.group.add(g);
          this.grenades.set(p.id, g);
        }
        g.position.copy(p.pos);
        g.rotation.x += dt * p.vel.length();
        const blink = Math.sin(p.age * (6 + p.age * 8)) > 0.3 ? 3 : 0;
        (g.material as MeshStandardMaterial).emissive.setRGB(blink, blink * 0.1, 0);
      }
    }
    this.tracers.count = n;
    this.tracers.instanceMatrix.needsUpdate = true;
    for (const [id, g] of this.grenades) {
      if (live.has(id)) continue;
      this.group.remove(g);
      this.grenadePool.push(g);
      this.grenades.delete(id);
    }
    for (const id of this.muzzleOffset.keys()) if (!live.has(id)) this.muzzleOffset.delete(id);

    // explosions
    for (const b of this.blasts) {
      if (!b.alive) continue;
      b.t += dt;
      const k = b.t / 0.45;
      if (k >= 1) {
        b.alive = false;
        b.mesh.visible = b.ring.visible = false;
        continue;
      }
      const e = 1 - (1 - k) ** 3;
      b.mesh.scale.setScalar(b.radius * (0.25 + 0.55 * e));
      (b.mesh.material as MeshBasicMaterial).opacity = (1 - k) ** 1.5;
      b.ring.scale.setScalar(b.radius * (0.4 + 0.8 * e));
      (b.ring.material as MeshBasicMaterial).opacity = 0.35 * (1 - k);
    }
    for (const l of this.lights) {
      l.t += dt;
      l.light.intensity = l.t < 0.5 ? 260 * (1 - l.t / 0.5) ** 2 : 0;
    }

    // sparks
    const g = 9;
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.sLife[i] <= 0) {
        this.sCol[i * 3] = this.sCol[i * 3 + 1] = this.sCol[i * 3 + 2] = 0;
        continue;
      }
      this.sLife[i] -= dt;
      const j = i * 3;
      this.sVel[j] += this.down.x * g * dt;
      this.sVel[j + 1] += this.down.y * g * dt;
      this.sVel[j + 2] += this.down.z * g * dt;
      const drag = 1 - 2.5 * dt;
      this.sVel[j] *= drag;
      this.sVel[j + 1] *= drag;
      this.sVel[j + 2] *= drag;
      this.sPos[j] += this.sVel[j] * dt;
      this.sPos[j + 1] += this.sVel[j + 1] * dt;
      this.sPos[j + 2] += this.sVel[j + 2] * dt;
      const f = Math.max(0, this.sLife[i] / this.sBase[i * 4 + 3]);
      this.sCol[j] = this.sBase[i * 4] * f;
      this.sCol[j + 1] = this.sBase[i * 4 + 1] * f;
      this.sCol[j + 2] = this.sBase[i * 4 + 2] * f;
    }
    void time;
    this.sparks.geometry.attributes.position.needsUpdate = true;
    this.sparks.geometry.attributes.color.needsUpdate = true;
  }
}
