import {
  BoxGeometry, ConeGeometry, CylinderGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Scene, Vector3,
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
const _s = new Vector3();

/** A three-pronged claw, pointing along -Z. */
function clawMesh() {
  const g = new Group();
  const metal = new MeshStandardMaterial({ color: 0x2d2f33, roughness: 0.35, metalness: 0.8 });
  const shank = new Mesh(new CylinderGeometry(0.018, 0.018, 0.2, 8).rotateX(Math.PI / 2), metal);
  g.add(shank);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const prong = new Mesh(new ConeGeometry(0.014, 0.12, 6).rotateX(-Math.PI / 2), metal);
    prong.position.set(Math.cos(a) * 0.04, Math.sin(a) * 0.04, -0.1);
    prong.lookAt(Math.cos(a) * 0.11, Math.sin(a) * 0.11, -0.04);
    g.add(prong);
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

  constructor(scene: Scene, private sim: PlayerSim) {
    this.rope = new InstancedMesh(new BoxGeometry(1, 1, 1).translate(0, 0, 0.5),
      new MeshStandardMaterial({ color: 0x9b8a68, roughness: 0.9 }), SEGMENTS);
    this.rope.frustumCulled = false;
    this.claw.visible = this.rope.visible = false;
    scene.add(this.claw, this.rope);
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
    // the rope: a sagging curve made of short straight pieces
    const len = start.distanceTo(_claw);
    const sag = slack * Math.min(1.5, len * 0.05);
    for (let i = 0; i < SEGMENTS; i++) {
      const t0 = i / SEGMENTS, t1 = (i + 1) / SEGMENTS;
      _a.lerpVectors(start, _claw, t0).addScaledVector(_sag.copy(down), sag * 4 * t0 * (1 - t0));
      _b.lerpVectors(start, _claw, t1).addScaledVector(_sag.copy(down), sag * 4 * t1 * (1 - t1));
      const l = _a.distanceTo(_b);
      _q.setFromUnitVectors(Z, _sag.copy(_b).sub(_a).divideScalar(l || 1));
      _m.compose(_a, _q, _s.set(0.014, 0.014, l));
      this.rope.setMatrixAt(i, _m);
    }
    this.rope.instanceMatrix.needsUpdate = true;
  }
}
