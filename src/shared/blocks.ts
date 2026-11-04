import { Quaternion, Vector3 } from 'three';
import { PLAYER_HALF_SEGMENT, PLAYER_HEIGHT, PLAYER_RADIUS } from './constants';
import type { PhysicsWorld, Rapier } from './physics';
import type { TeamId } from './teams';

export type BlockMaterial = 'wood' | 'stone' | 'metal';
export const BLOCK_MATERIALS: Record<BlockMaterial, { label: string; hp: number; color: number }> = {
  wood: { label: 'Дерево', hp: 60, color: 0xb88753 },
  stone: { label: 'Камень', hp: 140, color: 0x959899 },
  metal: { label: 'Металл', hp: 300, color: 0x9eacb4 },
};
export const BLOCK_ORDER: BlockMaterial[] = ['wood', 'stone', 'metal'];
/** Edge length of a block, m. A standing jump (~1.45 m) clears exactly one block. */
export const BLOCK_SIZE = 1;
/** How far from the eye a surface can be aimed at, m. */
export const BLOCK_REACH = 5;
export const START_BLOCKS: Record<BlockMaterial, number> = { wood: 24, stone: 0, metal: 0 };

export interface Block {
  id: number;
  center: Vector3;
  material: BlockMaterial;
  hp: number;
  maxHp: number;
  /** Who placed it (null = map). Only your own blocks can be picked back up. */
  team: TeamId | null;
  collider: ReturnType<PhysicsWorld['createCollider']>;
}

export type PlaceResult = 'ok' | 'resources' | 'player' | 'occupied' | 'range';

export interface BlockTarget {
  center: Vector3;
  /** Nothing was aimed at: the block continues the block / ground under the feet (bridging). */
  assisted: boolean;
}

const HALF = BLOCK_SIZE / 2;
const IDENTITY = new Quaternion();

/** Nearest world axis (all gravities are axis aligned, so blocks are too). */
export function axisOf(v: { x: number; y: number; z: number }, out = new Vector3()): Vector3 {
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  if (ax >= ay && ax >= az) return out.set(Math.sign(v.x) || 1, 0, 0);
  if (ay >= az) return out.set(0, Math.sign(v.y) || 1, 0);
  return out.set(0, 0, Math.sign(v.z) || 1);
}

/**
 * Snap to the 1 m world grid across `axis`, keep the coordinate along it. Blocks sit flush on whatever they
 * are attached to (the map is not grid aligned), but rows of blocks still line up sideways.
 */
export function snapAcross(p: Vector3, axis: Vector3): Vector3 {
  if (Math.abs(axis.x) < 0.5) p.x = Math.floor(p.x) + HALF;
  if (Math.abs(axis.y) < 0.5) p.y = Math.floor(p.y) + HALF;
  if (Math.abs(axis.z) < 0.5) p.z = Math.floor(p.z) + HALF;
  return p;
}

/** Placed blocks: aiming, validation, inventory, damage. Shared by the client and the future server. */
export class BlockSystem {
  /** Keyed by collider handle. */
  readonly blocks = new Map<number, Block>();
  readonly inventory: Record<BlockMaterial, number> = { ...START_BLOCKS };
  /** Bumped on every change, so views know when to rebuild. */
  version = 0;
  private nextId = 1;

  constructor(private R: Rapier, private world: PhysicsWorld, private playerCollider?: ReturnType<PhysicsWorld['createCollider']>) {}

  byCollider(handle: number) {
    return this.blocks.get(handle);
  }

  /** Where a block would go: on the aimed face, or (aiming at nothing) next to what is under the feet. */
  target(eye: Vector3, dir: Vector3, playerPos: Vector3, up: Vector3, facing: Vector3): BlockTarget | null {
    const R = this.R;
    const hit = this.world.castRayAndGetNormal(new R.Ray(eye, dir), BLOCK_REACH, true, undefined, undefined, this.playerCollider);
    if (hit) {
      const n = axisOf(hit.normal);
      const b = this.blocks.get(hit.collider.handle);
      if (b) return { center: b.center.clone().addScaledVector(n, BLOCK_SIZE), assisted: false };
      const p = eye.clone().addScaledVector(dir, hit.timeOfImpact).addScaledVector(n, HALF);
      return { center: snapAcross(p, n), assisted: false };
    }
    // bridging: continue the column under the feet one block in the facing direction
    const down = up.clone().negate();
    const ground = this.world.castRay(new R.Ray(playerPos, down), PLAYER_HEIGHT / 2 + 0.6, true, undefined, undefined, this.playerCollider);
    if (!ground) return null;
    const flat = facing.clone().addScaledVector(up, -facing.dot(up));
    if (flat.lengthSq() < 1e-6) return null;
    const step = axisOf(flat);
    const under = this.blocks.get(ground.collider.handle);
    if (under) return { center: under.center.clone().addScaledVector(step, BLOCK_SIZE), assisted: true };
    const center = snapAcross(playerPos.clone().addScaledVector(down, ground.timeOfImpact + HALF), axisOf(up)).addScaledVector(step, BLOCK_SIZE);
    // map edges are not on the grid: slide the first bridge block outwards until it clears the edge
    for (let k = 0; k < 10 && !this.isFree(center); k++) center.addScaledVector(step, 0.1);
    return { center, assisted: true };
  }

  /** The block under the crosshair, if any. */
  aimedBlock(eye: Vector3, dir: Vector3): Block | null {
    const hit = this.world.castRay(new this.R.Ray(eye, dir), BLOCK_REACH, true, undefined, undefined, this.playerCollider);
    return (hit && this.blocks.get(hit.collider.handle)) || null;
  }

  /** Is the cell free of map geometry and other blocks? */
  isFree(center: Vector3) {
    const probe = new this.R.Cuboid(HALF - 0.03, HALF - 0.03, HALF - 0.03);
    return !this.world.intersectionWithShape(center, IDENTITY, probe, undefined, undefined, this.playerCollider);
  }

  validate(center: Vector3, playerPos: Vector3, playerFrame: Quaternion, eye: Vector3, material: BlockMaterial): PlaceResult {
    if (this.inventory[material] < 1) return 'resources';
    if (eye.distanceTo(center) > BLOCK_REACH + 1) return 'range';
    const cube = new this.R.Cuboid(HALF, HALF, HALF);
    const player = new this.R.Capsule(PLAYER_HALF_SEGMENT, PLAYER_RADIUS + 0.02);
    if (cube.intersectsShape(center, IDENTITY, player, playerPos, playerFrame)) return 'player';
    if (!this.isFree(center)) return 'occupied';
    return 'ok';
  }

  place(center: Vector3, playerPos: Vector3, playerFrame: Quaternion, eye: Vector3, material: BlockMaterial, team: TeamId | null): PlaceResult {
    const result = this.validate(center, playerPos, playerFrame, eye, material);
    if (result !== 'ok') return result;
    this.inventory[material]--;
    this.add(center, material, team);
    return 'ok';
  }

  /** Unchecked insert (map fortifications). Pass refresh = false when adding many, then call `refresh()`. */
  add(center: Vector3, material: BlockMaterial, team: TeamId | null, refresh = true): Block {
    const collider = this.world.createCollider(this.R.ColliderDesc.cuboid(HALF, HALF, HALF).setTranslation(center.x, center.y, center.z));
    const hp = BLOCK_MATERIALS[material].hp;
    const block: Block = { id: this.nextId++, center: center.clone(), material, hp, maxHp: hp, team, collider };
    this.blocks.set(collider.handle, block);
    this.version++;
    if (refresh) this.refresh();
    return block;
  }

  /** Update Rapier's query structures after adding / removing colliders. */
  refresh() {
    this.world.step();
  }

  private remove(block: Block) {
    this.blocks.delete(block.collider.handle);
    this.world.removeCollider(block.collider, true);
    this.version++;
    this.refresh();
  }

  /** Pick up one of your own blocks: it goes back to the inventory. */
  reclaim(handle: number, team: TeamId | null): Block | null {
    const block = this.blocks.get(handle);
    if (!block || block.team !== team) return null;
    this.inventory[block.material]++;
    this.remove(block);
    return block;
  }

  damageCollider(handle: number, damage: number): boolean {
    const block = this.blocks.get(handle);
    if (!block || damage <= 0) return false;
    block.hp = Math.max(0, block.hp - damage);
    this.version++;
    if (!block.hp) this.remove(block);
    return true;
  }

  /** Radial damage by distance to the cube surface, not its centre. */
  explosion(pos: Vector3, radius: number, damage: number) {
    for (const b of [...this.blocks.values()]) {
      const d = new Vector3(
        Math.max(Math.abs(pos.x - b.center.x) - HALF, 0),
        Math.max(Math.abs(pos.y - b.center.y) - HALF, 0),
        Math.max(Math.abs(pos.z - b.center.z) - HALF, 0),
      ).length();
      if (d <= radius) this.damageCollider(b.collider.handle, Math.max(1, Math.round(damage * (1 - 0.7 * d / radius))));
    }
  }
}
