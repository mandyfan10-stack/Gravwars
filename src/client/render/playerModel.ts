import {
  AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CapsuleGeometry, Color, DoubleSide,
  Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Points, PointsMaterial, Quaternion, RingGeometry,
  TorusGeometry, Vector3,
} from 'three';
import { PLAYER_HALF_SEGMENT, PLAYER_RADIUS } from '../../shared/constants';

const capsule = new CapsuleGeometry(PLAYER_RADIUS, PLAYER_HALF_SEGMENT * 2, 6, 14);
const visorGeo = new BoxGeometry(0.52, 0.16, 0.14);
const packGeo = new BoxGeometry(0.46, 0.55, 0.22);
const haloGeo = new TorusGeometry(0.26, 0.035, 8, 28);
const ringGeo = new RingGeometry(0.5, 0.72, 36);
const AY = new Vector3(0, 1, 0);

/**
 * Team-colored player. Gravity is readable from:
 *  - the halo above the head (points "up" for that player),
 *  - the glowing ring under the feet (where they stand / will land),
 *  - particles that fall along their gravity,
 *  - a bright team-colored outline.
 */
export class PlayerModel {
  readonly group = new Group();
  private body = new Group();
  private particles: Points;
  private pVel: Float32Array;
  private ring: Mesh;
  private halo: Mesh;
  private t = Math.random() * 10;

  constructor(color: number) {
    const c = new Color(color);
    const bodyMat = new MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.1, emissive: c, emissiveIntensity: 0.25 });
    this.body.add(new Mesh(capsule, bodyMat));
    const outline = new Mesh(capsule, new MeshBasicMaterial({ color: c.clone().multiplyScalar(1.8), side: BackSide }));
    outline.scale.setScalar(1.09);
    this.body.add(outline);
    const visor = new Mesh(visorGeo, new MeshBasicMaterial({ color: new Color(0.6, 2.4, 3) }));
    visor.position.set(0, 0.6, -0.33);
    this.body.add(visor);
    const pack = new Mesh(packGeo, new MeshStandardMaterial({ color: 0x24262c, roughness: 0.6 }));
    pack.position.set(0, 0.2, 0.38);
    this.body.add(pack);
    this.group.add(this.body);

    const glow = (k: number) => new MeshBasicMaterial({
      color: c.clone().multiplyScalar(k), transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide,
    });
    this.halo = new Mesh(haloGeo, glow(2.6));
    this.halo.rotation.x = Math.PI / 2;
    this.halo.position.y = 1.18;
    this.group.add(this.halo);

    this.ring = new Mesh(ringGeo, glow(2));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = -0.9;
    this.group.add(this.ring);

    const N = 26;
    const pos = new Float32Array(N * 3);
    this.pVel = new Float32Array(N);
    for (let i = 0; i < N; i++) this.resetParticle(pos, i, true);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    this.particles = new Points(g, new PointsMaterial({
      color: c.clone().multiplyScalar(2.2), size: 0.09, transparent: true, opacity: 0.9,
      blending: AdditiveBlending, depthWrite: false,
    }));
    this.particles.frustumCulled = false;
    this.group.add(this.particles);
  }

  private resetParticle(pos: Float32Array, i: number, anyHeight = false) {
    const a = Math.random() * Math.PI * 2;
    const r = 0.25 + Math.random() * 0.35;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = anyHeight ? -2.5 + Math.random() * 3.5 : 0.9;
    pos[i * 3 + 2] = Math.sin(a) * r;
    this.pVel[i] = 1.5 + Math.random() * 2.5;
  }

  /** pos = capsule center, frame = body frame (local Y = up), yaw = facing inside the frame. */
  setPose(pos: Vector3, frame: Quaternion, yaw: number) {
    this.group.position.copy(pos);
    this.group.quaternion.copy(frame);
    this.body.quaternion.setFromAxisAngle(AY, yaw);
  }

  /** groundDist: distance from capsule center to the surface below along gravity (or Infinity). */
  update(dt: number, groundDist = 0.915) {
    this.t += dt;
    this.halo.position.y = 1.18 + Math.sin(this.t * 2.2) * 0.04;
    const show = Number.isFinite(groundDist) && groundDist < 40;
    this.ring.visible = show;
    if (show) {
      this.ring.position.y = -groundDist + 0.03;
      const s = 1 + Math.min(groundDist - 0.915, 10) * 0.08;
      this.ring.scale.setScalar(s);
    }
    const attr = this.particles.geometry.getAttribute('position') as BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < this.pVel.length; i++) {
      this.pVel[i] += dt * 6;
      arr[i * 3 + 1] -= this.pVel[i] * dt;
      if (arr[i * 3 + 1] < -Math.min(groundDist, 3)) this.resetParticle(arr, i);
    }
    attr.needsUpdate = true;
  }
}