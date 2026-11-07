import { Matrix4, Quaternion, Vector3 } from 'three';
import { PLAYER_HALF_SEGMENT, PLAYER_HEIGHT, PLAYER_RADIUS } from './constants';
import { frameForUp } from './math';
import type { PhysicsWorld, Rapier } from './physics';
import type { TeamId } from './teams';

export type BlockMaterial = 'wood' | 'stone' | 'metal';
export const BLOCK_MATERIALS: Record<BlockMaterial, { label: string; hp: number; color: number }> = {
  // phase 4: wood +100 %, stone +200 %, metal +350 % over the first prototype (60 / 140 / 300)
  wood: { label: 'Дерево', hp: 120, color: 0xb88753 },
  stone: { label: 'Камень', hp: 420, color: 0x959899 },
  metal: { label: 'Металл', hp: 1350, color: 0x9eacb4 },
};
export const BLOCK_ORDER: BlockMaterial[] = ['wood', 'stone', 'metal'];
/** Edge length of a fortification block, m. */
export const BLOCK_SIZE = 1;
/** How far from the eye a piece / block can be aimed at (pick-up with RMB), m. */
export const BLOCK_REACH = 6;
/** Material in the inventory at the start (one piece costs PIECE_COST). */
export const START_BLOCKS: Record<BlockMaterial, number> = { wood: 30, stone: 0, metal: 0 };

/** Build pieces (chosen in the radial menu): wall, floor, ramp. */
export type PieceKind = 'wall' | 'floor' | 'ramp';
export const PIECE_KINDS: PieceKind[] = ['wall', 'floor', 'ramp'];
export const PIECE_LABEL: Record<PieceKind, string> = { wall: 'Стена', floor: 'Пол', ramp: 'Лестница' };
/** Horizontal grid cell, m (GravWars: 6 m, a bridge over the 48 m gap at a cube edge is 8 floors + 16 ramps + 1). */
export const PIECE_CELL = 6;
/** Height of one building level (wall height, ramp rise), m. */
export const PIECE_LEVEL = 3;
export const PIECE_THICK = 0.25;
/** Material units one piece costs: a resource is a piece (1 wood = 1 wall / floor / ramp). */
export const PIECE_COST = 1;
/** Bridge plates cost the same as any piece (kept for the tests and the bots). */
export const BRIDGE_COST = PIECE_COST;
/** Piece HP = material HP × this. */
export const PIECE_HP_MUL = 2.5;

export type BlockKind = 'block' | PieceKind;

export interface Block {
  id: number;
  kind: BlockKind;
  center: Vector3;
  /** Half extents in the block's own (rotated) axes. */
  half: Vector3;
  quat: Quaternion;
  material: BlockMaterial;
  hp: number;
  maxHp: number;
  /** Material returned on pick-up. */
  cost: number;
  /** Who placed it (null = map). Only your own pieces can be picked back up. */
  team: TeamId | null;
  /** Pieces: grid key (no two pieces in the same slot) and base level along the grid's up axis. */
  key: string | null;
  level: number;
  collider: ReturnType<PhysicsWorld['createCollider']>;
}

export interface PiecePlan {
  kind: PieceKind;
  center: Vector3;
  half: Vector3;
  quat: Quaternion;
  key: string;
  level: number;
}

export type PlaceResult = 'ok' | 'resources' | 'player' | 'occupied';

type Collider = ReturnType<PhysicsWorld['createCollider']>;
const HALF = BLOCK_SIZE / 2;
const IDENTITY = new Quaternion();
const _m = new Matrix4();
const _l = new Vector3();

/** Nearest world axis (all gravities are axis aligned, so pieces are too). */
export function axisOf(v: { x: number; y: number; z: number }, out = new Vector3()): Vector3 {
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  if (ax >= ay && ax >= az) return out.set(Math.sign(v.x) || 1, 0, 0);
  if (ay >= az) return out.set(0, Math.sign(v.y) || 1, 0);
  return out.set(0, 0, Math.sign(v.z) || 1);
}

/** Distance from a point to an oriented box surface (0 inside). */
function boxDistance(p: Vector3, center: Vector3, half: Vector3, quat: Quaternion) {
  _l.copy(p).sub(center).applyQuaternion(_q.copy(quat).invert());
  return Math.hypot(Math.max(Math.abs(_l.x) - half.x, 0), Math.max(Math.abs(_l.y) - half.y, 0), Math.max(Math.abs(_l.z) - half.z, 0));
}
const _q = new Quaternion();

/**
 * The piece of `kind` in a grid slot: frame of the axis-aligned `upAxis`, `along` / `sg` = the local axis and sign
 * it faces, `bnd` = the cell boundary it starts at (along · sg), `b` = the cell centre on the other axis, `level` =
 * the floor height (frame-local y). Players' pieces and the map's bridge lanes go through this, so keys match.
 */
export function piecePlan(kind: PieceKind, upAxis: Vector3, along: 'x' | 'z', sg: number, bnd: number, b: number, level: number): PiecePlan {
  const q = frameForUp(upAxis);
  const side: 'x' | 'z' = along === 'x' ? 'z' : 'x';
  // local basis: F forward, U up, S sideways (right handed)
  const F = new Vector3();
  F[along] = sg;
  const U = new Vector3(0, 1, 0);
  let fa = bnd + PIECE_CELL / 2;
  let y = level;
  const half = new Vector3();
  let rot = 0;
  if (kind === 'wall') {
    fa = bnd;
    y = level + PIECE_LEVEL / 2;
    half.set(PIECE_THICK / 2, PIECE_LEVEL / 2, PIECE_CELL / 2);
  } else if (kind === 'floor') {
    y = level - PIECE_THICK / 2;
    half.set(PIECE_CELL / 2, PIECE_THICK / 2, PIECE_CELL / 2);
  } else {
    rot = Math.atan2(PIECE_LEVEL, PIECE_CELL);
    y = level + PIECE_LEVEL / 2 - Math.cos(rot) * PIECE_THICK / 2;
    fa += Math.sin(rot) * PIECE_THICK / 2;
    half.set(Math.hypot(PIECE_CELL, PIECE_LEVEL) / 2, PIECE_THICK / 2, PIECE_CELL / 2);
  }
  const Fx = F.clone().multiplyScalar(Math.cos(rot)).addScaledVector(U, Math.sin(rot));
  const Uy = U.clone().multiplyScalar(Math.cos(rot)).addScaledVector(F, -Math.sin(rot));
  const Sz = new Vector3().crossVectors(Fx, Uy);
  const local = new Vector3();
  local[along] = fa * sg;
  local.y = y;
  local[side] = b;
  const center = local.applyQuaternion(q);
  const quat = new Quaternion().setFromRotationMatrix(_m.makeBasis(Fx, Uy, Sz)).premultiply(q);
  const r = (v: number) => Math.round(v * 10);
  const key = `${axisKey(upAxis)}|${kind}|${r(center.x)},${r(center.y)},${r(center.z)}`;
  return { kind, center, half, quat, key, level };
}

/** Placed blocks: aiming, validation, inventory, damage. Shared by the client and the future server. */
export class BlockSystem {
  /** Keyed by collider handle. */
  readonly blocks = new Map<number, Block>();
  readonly inventory: Record<BlockMaterial, number> = { ...START_BLOCKS };
  /** Bumped on every change, so views know when to rebuild. */
  version = 0;
  private nextId = 1;

  constructor(private R: Rapier, private world: PhysicsWorld, private playerCollider?: Collider) {
    if (playerCollider) this.characters.push(playerCollider);
  }

  byCollider(handle: number) {
    return this.blocks.get(handle);
  }

  /** Player + bot capsules. They move without a physics step, so they are tested directly, not via the query tree. */
  readonly characters: Collider[] = [];
  private isCharacter(c: { handle: number }) {
    return this.characters.some((ch) => ch.handle === c.handle);
  }

  /**
   * Where a piece of `kind` goes for a player at `pos` looking along `facing`: on a 4 m grid aligned with the gravity,
   * the first cell boundary in front (wall) or the cell behind it (floor at feet level, ramp rising away).
   * The level is the ground under the feet; standing on a piece it snaps to that piece's levels, so ramps chain.
   */
  plan(kind: PieceKind, pos: Vector3, up: Vector3, facing: Vector3): PiecePlan | null {
    const upAxis = axisOf(up);
    const q = frameForUp(upAxis);
    const qi = q.clone().invert();
    const lp = pos.clone().applyQuaternion(qi);
    const lf = facing.clone().applyQuaternion(qi);
    if (Math.hypot(lf.x, lf.z) < 1e-4) return null;
    const along: 'x' | 'z' = Math.abs(lf.x) >= Math.abs(lf.z) ? 'x' : 'z';
    const side: 'x' | 'z' = along === 'x' ? 'z' : 'x';
    const sg = Math.sign(lf[along]) || 1;
    // base level: what is under the feet
    const feet = lp.y - PLAYER_HEIGHT / 2;
    let level = feet;
    const down = upAxis.clone().negate();
    const ground = this.world.castRay(new this.R.Ray(pos, down), PLAYER_HEIGHT / 2 + 2.5, true, undefined, undefined, undefined, undefined,
      (c) => !this.isCharacter(c));
    if (ground) {
      level = lp.y - ground.timeOfImpact;
      const under = this.blocks.get(ground.collider.handle);
      if (under?.key && under.key.startsWith(`${axisKey(upAxis)}|`))
        level = under.level + Math.round((feet - under.level) / PIECE_LEVEL) * PIECE_LEVEL;
    }
    const a = lp[along] * sg;
    const bnd = Math.ceil((a + PLAYER_RADIUS + 0.25) / PIECE_CELL) * PIECE_CELL;
    const b = (Math.floor(lp[side] / PIECE_CELL) + 0.5) * PIECE_CELL;
    return piecePlan(kind, upAxis, along, sg, bnd, b, level);
  }

  /** Material a piece costs: one unit, whatever the piece (1 wood = 1 piece; bridges too). */
  costOf(_plan: PiecePlan): number {
    return PIECE_COST;
  }

  /** `free`: bots build without an inventory. */
  validate(plan: PiecePlan, material: BlockMaterial, free = false): PlaceResult {
    if (!free && this.inventory[material] < this.costOf(plan)) return 'resources';
    for (const b of this.blocks.values()) if (b.key === plan.key) return 'occupied';
    const shape = new this.R.Cuboid(plan.half.x, plan.half.y, plan.half.z);
    const capsule = new this.R.Capsule(PLAYER_HALF_SEGMENT, PLAYER_RADIUS);
    for (const ch of this.characters)
      if (shape.intersectsShape(plan.center, plan.quat, capsule, ch.translation(), ch.rotation())) return 'player';
    return 'ok';
  }

  place(plan: PiecePlan, material: BlockMaterial, team: TeamId | null, free = false): PlaceResult {
    const result = this.validate(plan, material, free);
    if (result !== 'ok') return result;
    const cost = this.costOf(plan);
    if (!free) this.inventory[material] -= cost;
    this.insert(plan.kind, plan.center, plan.half, plan.quat, material, team, free ? 0 : cost, plan.key, plan.level, BLOCK_MATERIALS[material].hp * PIECE_HP_MUL);
    return 'ok';
  }

  /** The piece / block under the crosshair, if any. */
  aimedBlock(eye: Vector3, dir: Vector3): Block | null {
    const hit = this.world.castRay(new this.R.Ray(eye, dir), BLOCK_REACH, true, undefined, undefined, undefined, undefined,
      (c) => !this.isCharacter(c));
    return (hit && this.blocks.get(hit.collider.handle)) || null;
  }

  /** Is the 1 m cell free of map geometry and other blocks? */
  isFree(center: Vector3) {
    const probe = new this.R.Cuboid(HALF - 0.03, HALF - 0.03, HALF - 0.03);
    return !this.world.intersectionWithShape(center, IDENTITY, probe, undefined, undefined, this.playerCollider);
  }

  /** Unchecked 1 m block (map fortifications). Pass refresh = false when adding many, then call `refresh()`. */
  add(center: Vector3, material: BlockMaterial, team: TeamId | null, refresh = true): Block {
    return this.insert('block', center, new Vector3(HALF, HALF, HALF), IDENTITY, material, team, 1, null, 0, BLOCK_MATERIALS[material].hp, refresh);
  }

  /** Unchecked piece of any shape (tests, map setups). */
  insertPiece(kind: BlockKind, center: Vector3, half: Vector3, quat: Quaternion, material: BlockMaterial, team: TeamId | null = null): Block {
    return this.insert(kind, center, half, quat, material, team, PIECE_COST, null, 0, BLOCK_MATERIALS[material].hp * PIECE_HP_MUL);
  }

  private insert(kind: BlockKind, center: Vector3, half: Vector3, quat: Quaternion, material: BlockMaterial, team: TeamId | null,
    cost: number, key: string | null, level: number, hp: number, refresh = true): Block {
    const collider = this.world.createCollider(this.R.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(center.x, center.y, center.z).setRotation(quat));
    const block: Block = {
      id: this.nextId++, kind, center: center.clone(), half: half.clone(), quat: quat.clone(), material, hp, maxHp: hp, cost, team, key, level, collider,
    };
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

  /** Pick up one of your own pieces: its material goes back to the inventory. */
  reclaim(handle: number, team: TeamId | null): Block | null {
    const block = this.blocks.get(handle);
    if (!block || block.team !== team) return null;
    this.inventory[block.material] += block.cost;
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

  /** Radial damage by distance to the block surface, not its centre. */
  explosion(pos: Vector3, radius: number, damage: number) {
    for (const b of [...this.blocks.values()]) {
      const d = boxDistance(pos, b.center, b.half, b.quat);
      if (d <= radius) this.damageCollider(b.collider.handle, Math.max(1, Math.round(damage * (1 - 0.7 * d / radius))));
    }
  }
}

function axisKey(up: Vector3) {
  return `${up.x}${up.y}${up.z}`;
}
