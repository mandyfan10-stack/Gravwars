import { Matrix4, Quaternion, Vector3 } from 'three';
import { PLAYER_HALF_SEGMENT, PLAYER_RADIUS } from './constants';
import type { PhysicsWorld, Rapier } from './physics';

export type BuildKind = 'wall' | 'floor' | 'ramp';
export type BuildMaterial = 'wood' | 'stone' | 'metal';
export const BUILD_MATERIALS = { wood: { label: 'Дерево', hp: 100, color: 0xb88753 }, stone: { label: 'Камень', hp: 200, color: 0x959899 }, metal: { label: 'Металл', hp: 350, color: 0x9eacb4 } } as const;
export const BUILD_SIZE = 3;
export const BUILD_COST = 10;
export const BUILD_RANGE = 10;
export interface BuildPlan { kind: BuildKind; cell: Vector3; position: Vector3; rotation: Quaternion; half: Vector3; key: string }
export interface Building { id: number; plan: BuildPlan; material: BuildMaterial; hp: number; maxHp: number; collider: ReturnType<PhysicsWorld['createCollider']> }

/** World-axis grid, but the wall/ramp frame follows the builder's current gravity and facing. */
export function planBuild(kind: BuildKind, point: Vector3, upVector: Vector3, forward: Vector3, turns = 0): BuildPlan {
  const up = upVector.clone().normalize();
  // Gravity is axis-aligned; quantize facing to one of the four local horizontal directions.
  const f = forward.clone().addScaledVector(up, -forward.dot(up));
  if (f.lengthSq() < 1e-5) f.set(Math.abs(up.x) < 0.9 ? 1 : 0, Math.abs(up.x) < 0.9 ? 0 : 1, 0);
  const axes = [new Vector3(1,0,0), new Vector3(-1,0,0), new Vector3(0,1,0), new Vector3(0,-1,0), new Vector3(0,0,1), new Vector3(0,0,-1)].filter(a => Math.abs(a.dot(up)) < 0.1);
  axes.sort((a,b) => b.dot(f) - a.dot(f));
  const front = axes[0].clone().applyAxisAngle(up, turns * Math.PI / 2).round();
  const right = front.clone().cross(up).normalize();
  const rot = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, up, front.clone().negate()));
  const cell = point.clone().divideScalar(BUILD_SIZE).round().multiplyScalar(BUILD_SIZE);
  let offset = new Vector3();
  let half = new Vector3(1.5, 1.5, 0.09);
  if (kind === 'floor') { half = new Vector3(1.5, 0.09, 1.5); offset.set(0,-1.41,0); }
  if (kind === 'wall') offset.set(0,0,-1.41);
  if (kind === 'ramp') { half = new Vector3(1.5, 0.09, Math.sqrt(2) * 1.5); rot.multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0), Math.PI / 4)); }
  const position = cell.clone().add(offset.applyQuaternion(kind === 'ramp' ? new Quaternion() : rot));
  const normal = new Vector3(0, kind === 'wall' ? 0 : 1, kind === 'wall' ? 1 : 0).applyQuaternion(rot);
  const canonical = (v: Vector3) => { const a = v.toArray().map(n => Math.round(n * 1000)); const first = a.find(n => n !== 0) ?? 1; return a.map(n => first < 0 ? -n : n); };
  const key = [...position.toArray().map(n => Math.round(n * 1000)), ...canonical(normal), ...(kind === 'ramp' ? canonical(new Vector3(1,0,0).applyQuaternion(rot)) : [])].join(':');
  return { kind, cell, position, rotation: rot, half, key };
}

export type BuildResult = 'ok' | 'duplicate' | 'resources' | 'player' | 'range' | 'occupied';
export class BuildSystem {
  readonly pieces = new Map<number, Building>();
  readonly resources: Record<BuildMaterial, number> = { wood: 200, stone: 100, metal: 80 };
  private nextId = 1;
  constructor(private R: Rapier, private world: PhysicsWorld, private playerCollider?: ReturnType<PhysicsWorld['createCollider']>) {}
  validate(plan: BuildPlan, playerPos: Vector3, playerFrame: Quaternion, eye: Vector3, material: BuildMaterial = 'wood'): BuildResult {
    if (eye.distanceTo(plan.position) > BUILD_RANGE) return 'range';
    if (this.resources[material] < BUILD_COST) return 'resources';
    if ([...this.pieces.values()].some(p => p.plan.key === plan.key)) return 'duplicate';
    const shape = new this.R.Cuboid(plan.half.x, plan.half.y, plan.half.z);
    const player = new this.R.Capsule(PLAYER_HALF_SEGMENT, PLAYER_RADIUS + 0.05);
    if (shape.intersectsShape(plan.position, plan.rotation, player, playerPos, playerFrame)) return 'player';
    // Shrink the query slightly so pieces that merely touch can connect at grid edges.
    const probe = new this.R.Cuboid(Math.max(0.01, plan.half.x - 0.03), Math.max(0.01, plan.half.y - 0.03), Math.max(0.01, plan.half.z - 0.03));
    if (this.world.intersectionWithShape(plan.position, plan.rotation, probe, undefined, undefined, this.playerCollider, undefined, c => ![...this.pieces.values()].some(p => p.collider.handle === c.handle))) return 'occupied';
    return 'ok';
  }
  place(plan: BuildPlan, playerPos: Vector3, playerFrame: Quaternion, eye: Vector3, material: BuildMaterial = 'wood'): BuildResult {
    const result = this.validate(plan, playerPos, playerFrame, eye, material);
    if (result !== 'ok') return result;
    const h = plan.half, p = plan.position, q = plan.rotation;
    const collider = this.world.createCollider(this.R.ColliderDesc.cuboid(h.x,h.y,h.z).setTranslation(p.x,p.y,p.z).setRotation(q));
    const maxHp = BUILD_MATERIALS[material].hp;
    const piece = { id: this.nextId++, plan, material, hp: maxHp, maxHp, collider };
    this.pieces.set(piece.id, piece);
    this.resources[material] -= BUILD_COST;
    this.world.step(); // refresh Rapier's broad-phase for raycasts and character movement
    return 'ok';
  }
  byCollider(handle: number) { return [...this.pieces.values()].find(p => p.collider.handle === handle); }
  /** Remove only a targeted built piece; return half its cost in its original material. */
  reclaim(handle: number): Building | null {
    const piece = this.byCollider(handle);
    if (!piece) return null;
    this.resources[piece.material] += Math.floor(BUILD_COST / 2);
    this.world.removeCollider(piece.collider, true);
    this.pieces.delete(piece.id);
    this.world.step();
    return piece;
  }
  damageCollider(handle: number, damage: number): boolean {
    const piece = this.byCollider(handle);
    if (!piece || damage <= 0) return false;
    piece.hp = Math.max(0, piece.hp - damage);
    if (!piece.hp) {
      this.world.removeCollider(piece.collider, true);
      this.pieces.delete(piece.id);
      this.world.step();
    }
    return true;
  }
  /** Radial damage uses distance to the oriented slab, rather than to its centre. */
  explosion(pos: Vector3, radius: number, damage: number) {
    for (const p of [...this.pieces.values()]) {
      const local = pos.clone().sub(p.plan.position).applyQuaternion(p.plan.rotation.clone().invert());
      const h = p.plan.half;
      const d = new Vector3(Math.max(Math.abs(local.x)-h.x,0), Math.max(Math.abs(local.y)-h.y,0), Math.max(Math.abs(local.z)-h.z,0)).length();
      if (d <= radius) this.damageCollider(p.collider.handle, Math.max(1, Math.round(damage * (1 - 0.7 * d / radius))));
    }
  }
}
