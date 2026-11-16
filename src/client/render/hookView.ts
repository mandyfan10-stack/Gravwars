import {
  BoxGeometry, ConeGeometry, CylinderGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Scene, TorusGeometry, Vector3,
} from 'three';
import { HOOK, PlayerSim } from '../../shared/sim';

const SEGMENTS = 14;
const Z = new Vector3(0, 0, 1);
const _a = new Vector3();
const _b = new Vector3();
const _d = new Vector3();
const _claw = new Vector3();
const _sag = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _spin = new Quaternion();
const _s = new Vector3();

/** Detailed four-pronged steel grappling claw with barbed hooks, swivel eye, and glowing collar, pointing along -Z. */
function clawMesh() {
  const g = new Group();
  const metal = new MeshStandardMaterial({ color: 0x76808a, roughness: 0.28, metalness: 0.85 });
  const dark = new MeshStandardMaterial({ color: 0x22252a, roughness: 0.45, metalness: 0.7 });
  const glow = new MeshStandardMaterial({ color: 0x5df2ff, emissive: 0x35d6ff, emissiveIntensity: 1.4, roughness: 0.25 });

  // Central shaft + harpoon conical spear tip + rear swivel ring
  const shank = new Mesh(new CylinderGeometry(0.022, 0.022, 0.24, 10).rotateX(Math.PI / 2), dark);
  g.add(shank);
  const tip = new Mesh(new ConeGeometry(0.032, 0.14, 10).rotateX(-Math.PI / 2), metal);
  tip.position.z = -0.17;
  const collar = new Mesh(new TorusGeometry(0.034, 0.008, 6, 14), glow);
  collar.position.z = -0.02;
  const eye = new Mesh(new TorusGeometry(0.024, 0.006, 6, 12), metal);
  eye.position.z = 0.135;
  eye.rotation.y = Math.PI / 2;
  g.add(tip, collar, eye);

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const arm = new Group();
    arm.rotation.z = a;
    const rib = new Mesh(new BoxGeometry(0.018, 0.024, 0.14), dark);
    rib.position.set(0.068, 0, -0.075);
    rib.rotation.y = -0.58;
    const fang = new Mesh(new ConeGeometry(0.022, 0.13, 6).rotateX(-Math.PI * 0.82), metal);
    fang.position.set(0.115, 0, -0.02);
    fang.rotation.y = -0.9;
    arm.add(rib, fang);
    g.add(arm);
  }
  return g;
}

/**
 * The local player's grappling hook in the world: the claw flying out / biting / coming back, and the rope from
 * the launcher to it (slack while it flies, taut while it pulls).
 */
export class HookView {
  private readonly claw = clawMesh();
  private readonly rope: InstancedMesh;

  constructor(scene: Scene, private sim: { hook: PlayerSim['hook'] }) {
    this.rope = new InstancedMesh(new BoxGeometry(1, 1, 1).translate(0, 0, 0.5),
      new MeshStandardMaterial({ color: 0xd4c49c, roughness: 0.72, metalness: 0.15 }), SEGMENTS);
    this.rope.frustumCulled = false;
    this.claw.visible = this.rope.visible = false;
    scene.add(this.claw, this.rope);
  }

  destroy(scene: Scene) {
    scene.remove(this.claw, this.rope);
    this.rope.dispose();
  }

  /** `start`: world point of the claw's seat on the launcher in the hands. */
  update(start: Vector3 | null, down: Vector3) {
    const h = this.sim.hook;
    const show = !!h && !!start;
    this.claw.visible = this.rope.visible = show;
    if (!h || !start) return;
    // where the claw is now
    _d.copy(h.anchor).sub(h.from);
    const dist = _d.length() || 1;
    _d.divideScalar(dist);
    let slack = 0;
    if (h.phase === 'fly') {
      _claw.copy(h.from).addScaledVector(_d, Math.min(dist, h.t * HOOK.fly));
      slack = 0.6;
    } else if (h.phase === 'back') {
      const k = Math.min(1, (h.t * HOOK.fly * 1.5) / dist);
      _claw.copy(h.anchor).lerp(start, k);
      slack = 1;
    } else _claw.copy(h.anchor);
    this.claw.position.copy(_claw);
    _a.copy(_claw).sub(start).normalize();
    this.claw.quaternion.setFromUnitVectors(_b.set(0, 0, -1), _a);
    if (h.phase === 'fly' || h.phase === 'back') {
      _spin.setFromAxisAngle(Z, h.t * 18);
      this.claw.quaternion.multiply(_spin);
    }
    // the rope: a sagging curve made of short straight pieces
    const len = start.distanceTo(_claw);
    const sag = slack * Math.min(1.5, len * 0.05);
    for (let i = 0; i < SEGMENTS; i++) {
      const t0 = i / SEGMENTS, t1 = (i + 1) / SEGMENTS;
      _a.lerpVectors(start, _claw, t0).addScaledVector(_sag.copy(down), sag * 4 * t0 * (1 - t0));
      _b.lerpVectors(start, _claw, t1).addScaledVector(_sag.copy(down), sag * 4 * t1 * (1 - t1));
      const l = _a.distanceTo(_b);
      _q.setFromUnitVectors(Z, _sag.copy(_b).sub(_a).divideScalar(l || 1));
      _m.compose(_a, _q, _s.set(0.022, 0.022, l));
      this.rope.setMatrixAt(i, _m);
    }
    this.rope.instanceMatrix.needsUpdate = true;
  }
}
