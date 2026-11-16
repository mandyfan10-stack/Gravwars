import { Matrix4, Quaternion, Vector3 } from 'three';
import { PLAYER_HALF_SEGMENT, PLAYER_HEIGHT, PLAYER_RADIUS, WORLD } from './constants';
import { MATCH_RULES } from './lobby';
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
export const BLOCK_REACH = 7.5;
/** Material in the inventory at the start (one piece costs PIECE_COST). */
export const START_BLOCKS: Record<BlockMaterial, number> = { wood: 30, stone: 0, metal: 0 };

/** Build pieces (macro structures): wall, floor, ramp. */
export type PieceKind = 'wall' | 'floor' | 'ramp';
export const PIECE_KINDS: PieceKind[] = ['wall', 'floor', 'ramp'];
export type BlockKind = 'block' | PieceKind;
export const BUILD_KINDS: BlockKind[] = ['wall', 'block', 'floor', 'ramp'];
export const PIECE_LABEL: Record<BlockKind, string> = { block: 'Блок 1×1', wall: 'Стена', floor: 'Пол', ramp: 'Лестница' };

/** Sub-category variant for each piece in the Q radial menu: plain, with hole/window, or with team door/hatch. */
export type PieceVariant = 'plain' | 'hole' | 'door';
export const PIECE_VARIANTS: PieceVariant[] = ['plain', 'hole', 'door'];
export const VARIANT_LABEL: Record<PieceVariant, string> = {
  plain: 'Обычная',
  hole: 'С проёмом',
  door: 'С дверью / люком',
};

/** Horizontal grid cell, m (square cells: width = height = 4.5 m, +50% larger, so walls are square and ramps are 45°). */
export const PIECE_CELL = 4.5;
/** Height of one building level (wall height, ramp rise), m. */
export const PIECE_LEVEL = 4.5;
export const PIECE_THICK = 0.25;
/** Material units one piece costs: a resource is a piece (1 wood = 1 wall / floor / ramp). */
export const PIECE_COST = 1;
/** Bridge plates cost the same as any piece (kept for the tests and the bots). */
export const BRIDGE_COST = PIECE_COST;
/** Piece HP = material HP × this. */
export const PIECE_HP_MUL = 2.5;

export interface Block {
  id: number;
  kind: BlockKind;
  variant: PieceVariant;
  /** True when a door/hatch (`variant === 'door'`) is currently swung open. */
  open: boolean;
  center: Vector3;
  /** Half extents in the block's own (rotated) axes. */
  half: Vector3;
  quat: Quaternion;
  material: BlockMaterial;
  hp: number;
  maxHp: number;
  /** Material returned on pick-up. */
  cost: number;
  /** Who placed it (null = map). Only your own team can open its door, and only you/team can pick it back up. */
  team: TeamId | null;
  /** Pieces: grid key (no two pieces in the same slot) and base level along the grid's up axis. */
  key: string | null;
  level: number;
  collider: ReturnType<PhysicsWorld['createCollider']>;
}

export interface PiecePlan {
  kind: BlockKind;
  variant?: PieceVariant;
  center: Vector3;
  half: Vector3;
  quat: Quaternion;
  key: string;
  level: number;
}

export type PlaceResult = 'ok' | 'resources' | 'player' | 'occupied' | 'blocked';

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

/** Global vertical ground reference in face-local frame (`-cubeHalfY` on faces, `0` in origin test rooms). */
export function snapGlobalLevel(rawY: number, cubeHalfY = WORLD.cubeHalf): number {
  const faceGround = -cubeHalfY;
  const baseY = Math.abs(rawY - faceGround) < 55 ? faceGround : 0;
  return Math.round((baseY + Math.round((rawY - baseY) / PIECE_LEVEL) * PIECE_LEVEL) * 1000) / 1000;
}

/**
 * The piece of `kind` in a global grid slot: frame of the axis-aligned `upAxis`, `along` / `sg` = the local axis and sign
 * it faces, `bnd` = the cell boundary it starts at (along · sg), `b` = the cell centre on the other axis, `level` =
 * the floor height (frame-local y). Players' pieces and the map's bridge lanes go through this, so keys match.
 */
export function piecePlan(
  kind: PieceKind,
  upAxis: Vector3,
  along: 'x' | 'z',
  sg: number,
  bnd: number,
  b: number,
  level: number,
  variant: PieceVariant = 'plain',
): PiecePlan {
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
  return { kind, variant, center, half, quat, key, level };
}

/** Placed blocks: aiming, validation, inventory, damage. Shared by the client and the server. */
export class BlockSystem {
  /** Keyed by collider handle. */
  readonly blocks = new Map<number, Block>();
  readonly inventory: Record<BlockMaterial, number> = { ...START_BLOCKS };
  /** Distance from world origin to the vertical floor plane (equals WORLD.cubeHalf, or 22.5 m in Skirmish). */
  cubeHalfY = WORLD.cubeHalf;
  /** Bumped on every change, so views know when to rebuild. */
  version = 0;
  /** Called when a block/piece is placed in the world (`place()`). */
  onPlace?: (block: Block) => void;
  /** Called when a block/piece is destroyed by damage or an explosion. */
  onBreak?: (block: Block) => void;
  /** Called when a block/piece takes non-fatal damage (HP changed). */
  onDamage?: (block: Block) => void;
  /** Called whenever a block/piece is removed from the world (broken or reclaimed). */
  onRemove?: (block: Block) => void;
  /** Called when a door/hatch is opened or closed. */
  onDoorToggle?: (block: Block) => void;
  private nextId = 1;

  constructor(private R: Rapier, private world: PhysicsWorld, private playerCollider?: Collider) {
    if (playerCollider) this.characters.push(playerCollider);
  }

  byCollider(handle: number) {
    return this.blocks.get(handle);
  }

  /** Player + bot capsules. They move without a physics step, so they are tested directly, not via the query tree. */
  readonly characters: Collider[] = [];
  /** Team crystals (optional): prevents placing 1×1 blocks inside a crystal's glowing core and blocks bots from building near crystals. */
  crystals: readonly { pos: Vector3; up: Vector3; alive?: boolean }[] = [];
  private isCharacter(c: { handle: number }) {
    return this.characters.some((ch) => ch.handle === c.handle);
  }

  private hitsCrystal(center: Vector3, radius = 0.88): boolean {
    for (const c of this.crystals) {
      if (c.alive === false) continue;
      _l.copy(center).sub(c.pos);
      const along = _l.dot(c.up);
      if (along < -2.2 || along > 2.2) continue;
      _l.addScaledVector(c.up, -along);
      if (_l.lengthSq() < radius * radius) return true;
    }
    return false;
  }

  /** Is `center` within `radius` m of any crystal? Used to forbid bots from building near crystals. */
  nearCrystal(center: Vector3, radius = 5.2): boolean {
    for (const c of this.crystals) {
      if (c.alive === false) continue;
      if (center.distanceTo(c.pos) < radius) return true;
    }
    return false;
  }

  /**
   * Where a build item of `kind` goes on the unified GLOBAL grid:
   * - `block` snaps to the global 1 m lattice aligned with the cube face;
   * - macro pieces (`wall`, `floor`, `ramp`) snap onto the global 4.5 m grid aligned with gravity.
   */
  plan(
    kind: BlockKind,
    pos: Vector3,
    up: Vector3,
    facing: Vector3,
    eye = pos,
    viewDir = facing,
    variant: PieceVariant = 'plain',
  ): PiecePlan | null {
    if (kind === 'block') return this.planBlock(eye, viewDir, up, pos, facing);
    const upAxis = axisOf(up);
    const q = frameForUp(upAxis);
    const qi = q.clone().invert();
    const lp = pos.clone().applyQuaternion(qi);
    const lf = facing.clone().applyQuaternion(qi);
    if (Math.hypot(lf.x, lf.z) < 1e-4) return null;
    const along: 'x' | 'z' = Math.abs(lf.x) >= Math.abs(lf.z) ? 'x' : 'z';
    const side: 'x' | 'z' = along === 'x' ? 'z' : 'x';
    const sg = Math.sign(lf[along]) || 1;
    // base level snapped to the global vertical grid
    const feet = lp.y - PLAYER_HEIGHT / 2;
    let rawLevel = feet;
    const down = upAxis.clone().negate();
    const ground = this.world.castRay(new this.R.Ray(pos, down), PLAYER_HEIGHT / 2 + 2.5, true, undefined, undefined, undefined, undefined,
      (c) => !this.isCharacter(c));
    if (ground) {
      rawLevel = lp.y - ground.timeOfImpact;
      const under = this.blocks.get(ground.collider.handle);
      if (under && under.kind !== 'block' && under.key?.startsWith(`${axisKey(upAxis)}|`)) {
        rawLevel = under.level + Math.round((feet - under.level) / PIECE_LEVEL) * PIECE_LEVEL;
      }
    }
    const level = snapGlobalLevel(rawLevel, this.cubeHalfY);
    const a = lp[along] * sg;
    const bnd = Math.ceil((a + PLAYER_RADIUS + 0.25) / PIECE_CELL) * PIECE_CELL;
    const b = (Math.floor(lp[side] / PIECE_CELL) + 0.5) * PIECE_CELL;
    return piecePlan(kind, upAxis, along, sg, bnd, b, level, variant);
  }

  /** Voxel placement for a 1×1×1 block on the unified global 1 m grid. */
  private planBlock(eye: Vector3, dir: Vector3, up: Vector3, pos = eye, facing = dir): PiecePlan | null {
    const upAxis = axisOf(up);
    const q = frameForUp(upAxis);
    const qi = q.clone().invert();
    const down = upAxis.clone().negate();
    const faceGround = -this.cubeHalfY;
    const lpPlayer = pos.clone().applyQuaternion(qi);
    const baseY = Math.abs(lpPlayer.y - faceGround) < 55 ? faceGround : 0;

    const d = (dir.lengthSq() > 1e-6 ? dir : facing).clone().normalize();
    const hit = this.world.castRayAndGetNormal(new this.R.Ray(eye, d), BLOCK_REACH, true, undefined, undefined, undefined, undefined,
      (c) => !this.isCharacter(c));

    let center: Vector3;
    if (hit) {
      const hitNormal = new Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
      const hitBlock = this.blocks.get(hit.collider.handle);
      if (hitBlock && hitBlock.kind === 'block') {
        const bqInv = hitBlock.quat.clone().invert();
        const step = axisOf(hitNormal.clone().applyQuaternion(bqInv)).applyQuaternion(hitBlock.quat);
        center = hitBlock.center.clone().addScaledVector(step, BLOCK_SIZE);
      } else {
        const hitPos = eye.clone().addScaledVector(d, hit.timeOfImpact);
        const p = hitPos.clone().addScaledVector(hitNormal, HALF * 0.95);
        const lp = p.clone().applyQuaternion(qi);
        const lx = Math.floor(lp.x + 0.5);
        const lz = Math.floor(lp.z + 0.5);
        const probe = new Vector3(lx, lp.y + 0.35, lz).applyQuaternion(q);
        const floorHit = this.world.castRay(new this.R.Ray(probe, down), 8, true, undefined, undefined, undefined, undefined,
          (c) => !this.isCharacter(c) && this.blocks.get(c.handle)?.kind !== 'block');
        const floorY = floorHit ? (lp.y + 0.35 - floorHit.timeOfImpact) : baseY;
        const ly = floorY + Math.floor(Math.max(0, lp.y - floorY)) + HALF;
        center = new Vector3(lx, ly, lz).applyQuaternion(q);
      }
    } else {
      // Responsive fallback when looking into open air: place 2.2 m ahead at feet level on the global 1 m grid
      const ahead = pos.clone().addScaledVector(facing.clone().normalize(), 2.2).applyQuaternion(qi);
      const lx = Math.floor(ahead.x + 0.5);
      const lz = Math.floor(ahead.z + 0.5);
      const ly = baseY + Math.floor(Math.max(0, (lpPlayer.y - PLAYER_HEIGHT / 2) - baseY)) + HALF;
      center = new Vector3(lx, ly, lz).applyQuaternion(q);
    }

    const r4 = (v: number) => Math.round(v * 10000) / 10000;
    center.set(r4(center.x), r4(center.y), r4(center.z));
    const localY = center.clone().applyQuaternion(qi).y;
    const level = Math.round((localY - HALF) * 1000) / 1000;
    const r2 = (v: number) => Math.round(v * 100);
    const key = `${axisKey(upAxis)}|block|${r2(center.x)},${r2(center.y)},${r2(center.z)}`;
    return { kind: 'block', variant: 'plain', center, half: new Vector3(HALF, HALF, HALF), quat: q, key, level };
  }

  /** Material a piece costs: one unit, whatever the piece (1 wood = 1 piece; bridges too). */
  costOf(_plan: PiecePlan): number {
    return PIECE_COST;
  }

  /** `free`: bots build without using player's BlockSystem inventory (and are forbidden from building near crystals). */
  validate(plan: PiecePlan, material: BlockMaterial, free = false): PlaceResult {
    if (!free && this.inventory[material] < this.costOf(plan)) return 'resources';
    if (free && this.nearCrystal(plan.center, 5.2)) return 'blocked';
    for (const b of this.blocks.values()) if (b.key === plan.key) return 'occupied';
    if (plan.kind === 'block') {
      if (this.findByPos(plan.center, 0.25)) return 'occupied';
      if (!this.isFree(plan.center) || this.hitsCrystal(plan.center)) return 'blocked';
    }
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
    const baseHp = plan.kind === 'block' ? BLOCK_MATERIALS[material].hp : BLOCK_MATERIALS[material].hp * PIECE_HP_MUL;
    const hp = Math.max(1, Math.round(baseHp * MATCH_RULES.blockHp));
    this.insert(plan.kind, plan.center, plan.half, plan.quat, material, team, free ? 0 : cost, plan.key, plan.level, hp, true, plan.variant ?? 'plain');
    const placed = this.findByPos(plan.center, 0.05);
    if (placed) this.onPlace?.(placed);
    return 'ok';
  }

  /** The piece / block under the crosshair, if any (also checks open doors analytically). */
  aimedBlock(eye: Vector3, dir: Vector3): Block | null {
    const door = this.aimedDoor(eye, dir, BLOCK_REACH);
    const hit = this.world.castRay(new this.R.Ray(eye, dir), BLOCK_REACH, true, undefined, undefined, undefined, undefined,
      (c) => !this.isCharacter(c));
    const hitBlock = (hit && this.blocks.get(hit.collider.handle)) || null;
    if (door && (!hit || door.dist <= hit.timeOfImpact + 0.1)) return door.block;
    return hitBlock;
  }

  /** Find a `door` or `hole` block along the ray within `reach` m. */
  aimedDoor(eye: Vector3, dir: Vector3, reach = 4.2): { block: Block; dist: number } | null {
    const d = dir.clone().normalize();
    let best: { block: Block; dist: number } | null = null;
    for (const b of this.blocks.values()) {
      if (b.variant !== 'door') continue;
      const to = b.center.clone().sub(eye);
      const along = to.dot(d);
      if (along < 0 || along > reach + 2.5) continue;
      const pt = eye.clone().addScaledVector(d, along);
      if (boxDistance(pt, b.center, b.half.clone().addScalar(0.15), b.quat) <= 0.2) {
        if (!best || along < best.dist) best = { block: b, dist: along };
      }
    }
    return best;
  }

  /**
   * Toggle a team door (wall with door) or hatch (floor with hatch) aimed at by `eye`/`dir` (or nearest within 3.2m).
   * Any member of `team` (the team of the player who built it) can open/close it.
   */
  toggleDoor(eye: Vector3, dir: Vector3, team: TeamId | null): Block | null {
    const aimed = this.aimedDoor(eye, dir, 4.2);
    let target = aimed?.block ?? null;
    if (!target) {
      let bestD = 3.2;
      for (const b of this.blocks.values()) {
        if (b.variant !== 'door') continue;
        const d = eye.distanceTo(b.center);
        if (d < bestD) { bestD = d; target = b; }
      }
    }
    if (!target) return null;
    if (target.team && team && target.team !== team) return null;
    this.setDoorState(target, !target.open);
    return target;
  }

  setDoorState(block: Block, open: boolean) {
    if (block.variant !== 'door' || block.open === open) return;
    block.open = open;
    // When open, shrink the collider to a thin corner post so teammates walk/fall cleanly through the doorway/hatch
    if (open) {
      block.collider.setShape(new this.R.Cuboid(0.04, 0.04, 0.04));
    } else {
      block.collider.setShape(new this.R.Cuboid(block.half.x, block.half.y, block.half.z));
    }
    this.version++;
    this.refresh();
    this.onDoorToggle?.(block);
  }

  /** Is the 1 m cell free of map geometry and other blocks? */
  isFree(center: Vector3) {
    const probe = new this.R.Cuboid(HALF - 0.03, HALF - 0.03, HALF - 0.03);
    return !this.world.intersectionWithShape(center, IDENTITY, probe, undefined, undefined, this.playerCollider);
  }

  /** Unchecked 1 m block (map fortifications). Pass refresh = false when adding many, then call `refresh()`. */
  add(center: Vector3, material: BlockMaterial, team: TeamId | null, refresh = true): Block {
    const hp = Math.max(1, Math.round(BLOCK_MATERIALS[material].hp * MATCH_RULES.blockHp));
    const block = this.insert('block', center, new Vector3(HALF, HALF, HALF), IDENTITY, material, team, 1, null, 0, hp, refresh, 'plain');
    this.onPlace?.(block);
    return block;
  }

  /** Unchecked piece of any shape (tests, map setups, network sync). */
  insertPiece(
    kind: BlockKind,
    center: Vector3,
    half: Vector3,
    quat: Quaternion,
    material: BlockMaterial,
    team: TeamId | null = null,
    key: string | null = null,
    level = 0,
    variant: PieceVariant = 'plain',
  ): Block {
    const baseHp = kind === 'block' ? BLOCK_MATERIALS[material].hp : BLOCK_MATERIALS[material].hp * PIECE_HP_MUL;
    const hp = Math.max(1, Math.round(baseHp * MATCH_RULES.blockHp));
    return this.insert(kind, center, half, quat, material, team, PIECE_COST, key, level, hp, true, variant);
  }

  private insert(
    kind: BlockKind,
    center: Vector3,
    half: Vector3,
    quat: Quaternion,
    material: BlockMaterial,
    team: TeamId | null,
    cost: number,
    key: string | null,
    level: number,
    hp: number,
    refresh = true,
    variant: PieceVariant = 'plain',
  ): Block {
    const collider = this.world.createCollider(this.R.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(center.x, center.y, center.z).setRotation(quat));
    const block: Block = {
      id: this.nextId++,
      kind,
      variant,
      open: false,
      center: center.clone(),
      half: half.clone(),
      quat: quat.clone(),
      material,
      hp,
      maxHp: hp,
      cost,
      team,
      key,
      level,
      collider,
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

  private remove(block: Block, refresh = true) {
    this.blocks.delete(block.collider.handle);
    this.world.removeCollider(block.collider, true);
    this.version++;
    if (refresh) this.refresh();
    this.onRemove?.(block);
  }

  /** Pick up one of your own pieces: its material goes back to the inventory. */
  reclaim(handle: number, team: TeamId | null): Block | null {
    const block = this.blocks.get(handle);
    if (!block || block.team !== team) return null;
    this.inventory[block.material] += block.cost;
    this.remove(block);
    return block;
  }

  /** Find a block nearest to `pos` within `eps` m. */
  findByPos(pos: Vector3, eps = 0.12): Block | null {
    const e2 = eps * eps;
    for (const b of this.blocks.values()) {
      if (b.center.distanceToSquared(pos) <= e2) return b;
    }
    return null;
  }

  /** Remove a block nearest to `pos` within `eps` m (used by network replication). */
  removeByPos(pos: Vector3, eps = 0.08): Block | null {
    const b = this.findByPos(pos, eps);
    if (!b) return null;
    this.remove(b);
    return b;
  }

  /** Apply authoritative block HP at `pos` on a network client. */
  syncDamageAtPos(pos: Vector3, hp: number, eps = 0.12): boolean {
    const b = this.findByPos(pos, eps);
    if (!b) return false;
    b.hp = Math.max(0, hp);
    this.version++;
    if (!b.hp) {
      this.onBreak?.(b);
      this.remove(b);
    }
    return true;
  }

  damageCollider(handle: number, damage: number, refresh = true): boolean {
    const block = this.blocks.get(handle);
    if (!block || damage <= 0) return false;
    block.hp = Math.max(0, block.hp - damage);
    this.version++;
    if (!block.hp) {
      this.onBreak?.(block);
      this.remove(block, refresh);
    } else {
      this.onDamage?.(block);
    }
    return true;
  }

  /** Radial damage by distance to the block surface, not its centre. */
  explosion(pos: Vector3, radius: number, damage: number) {
    const before = this.blocks.size;
    for (const b of [...this.blocks.values()]) {
      const d = boxDistance(pos, b.center, b.half, b.quat);
      if (d <= radius) this.damageCollider(b.collider.handle, Math.max(1, Math.round(damage * (1 - 0.7 * d / radius))), false);
    }
    if (this.blocks.size !== before) this.refresh();
  }
}

function axisKey(up: Vector3) {
  return `${up.x}${up.y}${up.z}`;
}
