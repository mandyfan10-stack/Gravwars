/**
 * Host-side validation of untrusted client packets (P2P: the host is the authority, a client may be modified).
 * Pure helpers without Three.js scene / network state, so they are covered by headless tests.
 */
import { Quaternion, Vector3 } from 'three';
import {
  BLOCK_MATERIALS, BUILD_KINDS, PIECE_CELL, PIECE_LEVEL, PIECE_THICK, PIECE_VARIANTS,
  type BlockKind, type BlockMaterial, type PieceVariant,
} from '../blocks';
import { EYE_OFFSET } from '../constants';
import { ITEMS, type ItemId } from '../economy';
import { FISHING } from '../fishing';
import { CROSSBOW_LEVELS, KICK, WEAPONS, type WeaponId } from '../weapons';
import type { QuatTuple, Vec3Tuple } from './protocol';

/** Any coordinate in the world is well inside this (the cube half size is ~126 m). */
export const WORLD_LIMIT = 1000;
/** Base slack between the client's claimed eye / muzzle and the host's sim position, m (prediction + latency). */
export const EYE_SLACK = 3;
/** Extra slack per m/s of the host-side velocity (≈ how far the player moves during one RTT). */
export const EYE_SLACK_PER_SPEED = 0.35;
/** Max reach for building / removing pieces from the host-side position, m. */
export const BUILD_REACH = 15;
/** Max crossbow charge time accepted (level 3 needs 3 s). */
export const MAX_CHARGE_T = 3.5;
/** Shortest possible fishing cycle: cast flight + min wait (the strike itself is on top of that). */
export const MIN_FISH_INTERVAL = FISHING.castTime + FISHING.waitMin;
/** Max distance from a pond (its centre plane) to the angler for a catch to count, m. */
export const FISH_POND_REACH = FISHING.leash + FISHING.reach;

export const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < WORLD_LIMIT * 10;

export function isVec3(v: unknown): v is Vec3Tuple {
  return Array.isArray(v) && v.length === 3 && v.every((x) => finiteNum(x) && Math.abs(x) <= WORLD_LIMIT);
}

export function isQuat(v: unknown): v is QuatTuple {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((x) => finiteNum(x))) return false;
  const len = Math.hypot(v[0], v[1], v[2], v[3]);
  return Math.abs(len - 1) < 0.01;
}

/** Direction: finite, non-degenerate. */
export function isDir(v: unknown): v is Vec3Tuple {
  if (!isVec3(v)) return false;
  return Math.hypot(v[0], v[1], v[2]) > 1e-3;
}

/**
 * Does a client-claimed eye / muzzle point plausibly belong to a player whose capsule centre is at `pos` on the host?
 * The tolerance grows with speed (prediction / latency; the hook pulls fast).
 */
export function eyeNear(eye: Vec3Tuple, pos: Vector3, up: Vector3, vel: Vector3): boolean {
  const ex = pos.x + up.x * EYE_OFFSET, ey = pos.y + up.y * EYE_OFFSET, ez = pos.z + up.z * EYE_OFFSET;
  const d = Math.hypot(eye[0] - ex, eye[1] - ey, eye[2] - ez);
  return d <= EYE_SLACK + vel.length() * EYE_SLACK_PER_SPEED;
}

/** Clamp a number to a range, NaN / Infinity → `fallback`. */
export function clampNum(v: unknown, lo: number, hi: number, fallback = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

export const isBlockMaterial = (m: unknown): m is BlockMaterial =>
  typeof m === 'string' && Object.prototype.hasOwnProperty.call(BLOCK_MATERIALS, m);

export const isBlockKind = (k: unknown): k is BlockKind => typeof k === 'string' && (BUILD_KINDS as string[]).includes(k);

export const isPieceVariant = (v: unknown): v is PieceVariant => typeof v === 'string' && (PIECE_VARIANTS as string[]).includes(v);

export const isWeaponId = (w: unknown): w is WeaponId => typeof w === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, w);

export const isItemId = (k: unknown): k is ItemId => typeof k === 'string' && Object.prototype.hasOwnProperty.call(ITEMS, k);

/** Exact half extents every build kind has (see `piecePlan` / the 1×1×1 block). */
export function expectedHalf(kind: BlockKind): [number, number, number] {
  if (kind === 'block') return [0.5, 0.5, 0.5];
  if (kind === 'wall') return [PIECE_THICK / 2, PIECE_LEVEL / 2, PIECE_CELL / 2];
  if (kind === 'floor') return [PIECE_CELL / 2, PIECE_THICK / 2, PIECE_CELL / 2];
  return [Math.hypot(PIECE_CELL, PIECE_LEVEL) / 2, PIECE_THICK / 2, PIECE_CELL / 2];
}

export interface BuildPlaceRaw {
  kind: unknown; variant?: unknown; center: unknown; half: unknown; quat: unknown; material: unknown; key?: unknown; level?: unknown;
}
export interface BuildPlaceClean {
  kind: BlockKind; variant: PieceVariant; center: Vector3; half: Vector3; quat: Quaternion; material: BlockMaterial; key: string | undefined; level: number;
}

/** Shape-check a `build_place` action. Null = reject (unknown kind / variant / material, odd size, NaN, absurd key / level). */
export function cleanBuildPlace(act: BuildPlaceRaw): BuildPlaceClean | null {
  if (!isBlockKind(act.kind) || !isBlockMaterial(act.material)) return null;
  if (act.variant !== undefined && !isPieceVariant(act.variant)) return null;
  if (!isVec3(act.center) || !isVec3(act.half) || !isQuat(act.quat)) return null;
  const want = expectedHalf(act.kind);
  for (let i = 0; i < 3; i++) if (Math.abs(act.half[i] - want[i]) > 0.05) return null;
  if (act.key !== undefined && act.key !== null && (typeof act.key !== 'string' || act.key.length > 96)) return null;
  if (act.level !== undefined && !finiteNum(act.level)) return null;
  const level = typeof act.level === 'number' ? act.level : 0;
  if (Math.abs(level) > WORLD_LIMIT) return null;
  return {
    kind: act.kind,
    variant: act.variant ?? 'plain',
    material: act.material,
    center: new Vector3(...act.center),
    half: new Vector3(...want),
    quat: new Quaternion(...act.quat).normalize(),
    key: typeof act.key === 'string' ? act.key : undefined,
    level,
  };
}

/**
 * Per-action token bucket: allows `burst` actions back to back (packets bunch up on the wire), refilled at one token
 * per `interval * leniency` seconds. Time is passed in, so it is deterministic in tests.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; t: number }>();
  constructor(private readonly burst = 3, private readonly leniency = 0.8) {}

  allow(key: string, interval: number, now: number): boolean {
    const period = Math.max(1e-3, interval * this.leniency);
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, t: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + Math.max(0, now - b.t) / period);
    b.t = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  reset() {
    this.buckets.clear();
  }
}

/** Min time between two uses of a weapon (fists / guns / grenades). */
export function fireInterval(w: WeaponId): number {
  if (w === 'crossbow') return CROSSBOW_LEVELS[0].reload;
  return Math.max(0.05, WEAPONS[w].interval);
}

/** Min time between kicks (the client's cooldown after a miss is the shortest one). */
export const KICK_INTERVAL = Math.max(0.1, KICK.cdMiss);

/** Is the angler close enough to any pond for a catch to be real? */
export function nearPond(pos: Vector3, ponds: { pos: Vec3Tuple; half: [number, number] }[]): boolean {
  for (const p of ponds) {
    const reach = FISH_POND_REACH + Math.hypot(p.half[0], p.half[1]);
    if (Math.hypot(pos.x - p.pos[0], pos.y - p.pos[1], pos.z - p.pos[2]) <= reach) return true;
  }
  return false;
}
