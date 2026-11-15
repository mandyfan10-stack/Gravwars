import type { Difficulty } from '../bots';
import type { LobbyConfig } from '../lobby';
import type { TeamId } from '../teams';

export type NetworkRole = 'host' | 'client';
export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

/** Information about a connected player in lobby or match. */
export interface NetworkPlayerInfo {
  id: string;
  name: string;
  team: TeamId;
  seatIndex: number;
  isHost: boolean;
  pingMs: number;
}

/** Messages exchanged in the pre-match lobby. */
export type LobbyMessage =
  | { type: 'lobby:join'; name: string }
  | { type: 'lobby:name'; name: string }
  | { type: 'lobby:welcome'; yourId: string; players: NetworkPlayerInfo[]; config: LobbyConfig }
  | { type: 'lobby:update'; players: NetworkPlayerInfo[]; config: LobbyConfig }
  | { type: 'lobby:seat'; team: TeamId; seatIndex: number }
  | { type: 'lobby:bot'; team: TeamId; seatIndex: number; difficulty: Difficulty }
  | { type: 'lobby:remove_seat'; team: TeamId; seatIndex: number }
  | { type: 'lobby:rejected'; reason: string }
  | { type: 'lobby:start'; seed: number; config: LobbyConfig; activeTeams: TeamId[]; mapTeam?: TeamId; skipFortTeams?: TeamId[] };

/** Input vector sent from client to host at fixed tick rate (~64Hz). */
export interface PlayerInputPacket {
  seq?: number;
  tick: number;
  forward: number;
  right: number;
  up: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  yaw: number;
  pitch: number;
  slot: number;
  weapon?: string;
}

/** Client actions validated and executed authoritatively on host. */
export type ClientAction =
  | { type: 'fire'; weapon: string; origin: Vec3Tuple; dir: Vec3Tuple; chargeT?: number }
  | { type: 'reload' }
  | { type: 'kick'; eye: Vec3Tuple; dir: Vec3Tuple }
  | { type: 'hook'; eye: Vec3Tuple; dir: Vec3Tuple; release?: boolean }
  | { type: 'throw'; kind: string; origin: Vec3Tuple; dir: Vec3Tuple }
  | {
      type: 'build_place';
      kind: string;
      center: Vec3Tuple;
      half: Vec3Tuple;
      quat: QuatTuple;
      material: string;
      team: TeamId;
      key?: string;
      level?: number;
    }
  | { type: 'build_remove'; pos: Vec3Tuple }
  | { type: 'buy'; itemId: string }
  | { type: 'sell'; kind: string }
  | {
      type: 'interact';
      target: string;
      targetId?: number;
      pos?: Vec3Tuple;
      dir?: Vec3Tuple;
    }
  | { type: 'select_slot'; slot: number; weapon?: string };

/** Serialized state of a single player in the world snapshot. */
export interface RemotePlayerSnapshot {
  id: string;
  name?: string;
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  frame: QuatTuple;
  yaw: number;
  pitch: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  onGround: boolean;
  team: TeamId;
  activeWeapon: string;
  hookPos: Vec3Tuple | null;
  hookPhase?: 'fly' | 'pull' | 'back';
  crouching: boolean;
  isFiring: boolean;
  stun?: number;
  guard?: boolean;
  out?: boolean;
  ackSeq?: number;
}

/** Serialized state of a crystal on a base. */
export interface CrystalSnapshot {
  team: TeamId;
  stage: number;
  hp: number;
  maxHp: number;
  invulnerable: boolean;
  invulnT?: number;
  broken: boolean;
}

/** Serialized state of a single bot in the world snapshot. */
export interface RemoteBotSnapshot {
  id: number;
  team: TeamId;
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  frame: QuatTuple;
  yaw: number;
  pitch: number;
  hp: number;
  alive: boolean;
  out: boolean;
  onGround: boolean;
  weapon: string;
  shotsTotal: number;
  kicksTotal: number;
  fishing: boolean;
  status: string;
  stun?: number;
  guard?: boolean;
}

/** Serialized state of a dynamic NPC (bum / gang). */
export interface RemoteNpcSnapshot {
  id: number;
  kind: 'bum' | 'gang';
  alive: boolean;
  hp: number;
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  frame: QuatTuple;
  yaw: number;
  state: string;
  fire: boolean;
  stun: number;
  weapon: string;
  shotsTotal?: number;
  throwsTotal?: number;
}

/** Serialized state of a cruising / crashing car. */
export interface RemoteCarSnapshot {
  id: number;
  alive: boolean;
  hp?: number;
  pos: Vec3Tuple;
  vel?: Vec3Tuple;
  quat?: QuatTuple;
  up: Vec3Tuple;
  yaw: number;
  scale: number;
  color: number;
  state: string;
  crashT: number;
}

/** Serialized state of an arena or dropped pickup. */
export interface RemotePickupSnapshot {
  id: number;
  kind: string;
  amount: number;
  once: boolean;
  pos: Vec3Tuple;
  up: Vec3Tuple;
  alive: boolean;
}

/** Serialized state of a non-resting / broken prop (crate or barrel). */
export interface RemotePropSnapshot {
  idx: number;
  pos: Vec3Tuple;
  quat: QuatTuple;
  hp: number;
  present: boolean;
}

/** Authoritative world snapshot broadcast by host (~20-30Hz). */
export interface WorldSnapshot {
  tick: number;
  serverTime: number;
  matchTime?: number;
  windTime?: number;
  winnerTeam?: TeamId | 'draw' | null;
  generators?: number[];
  players: RemotePlayerSnapshot[];
  crystals: Record<TeamId, CrystalSnapshot>;
  bots?: RemoteBotSnapshot[];
  npcs?: RemoteNpcSnapshot[];
  cars?: RemoteCarSnapshot[];
  pickupsVersion?: number;
  pickups?: RemotePickupSnapshot[];
  props?: RemotePropSnapshot[];
}

/** Discrete world events sent reliably from host to clients. */
export type WorldEvent =
    | {
      type: 'block:place';
      kind: string;
      center: Vec3Tuple;
      half: Vec3Tuple;
      quat: QuatTuple;
      material: string;
      team: TeamId | null;
      key?: string;
      level?: number;
    }
  | { type: 'block:damage'; id: number; hp: number; pos?: Vec3Tuple }
  | { type: 'block:break'; pos: Vec3Tuple }
  | { type: 'prop:break'; idx: number }
  | {
      type: 'combat:hit';
      victimId: string;
      attackerId: string;
      damage: number;
      isHead: boolean;
      killed?: boolean;
      weapon?: string;
      cause?: string;
      victimTeam?: TeamId;
      isNpc?: boolean;
      pos?: Vec3Tuple;
    }
  | {
      type: 'combat:kill';
      victimId: string;
      attackerId: string;
      weapon: string;
      dist: number;
      isHead: boolean;
      cause?: string;
      final?: boolean;
      attackerTeam?: TeamId;
      victimTeam?: TeamId;
    }
  | {
      type: 'combat:bullet';
      ownerId: string;
      origin: Vec3Tuple;
      dir: Vec3Tuple;
      weapon: string;
      chargeT?: number;
      attackerTeam?: TeamId | null;
      customDamage?: number;
      customPush?: number;
      customBlockDamage?: number;
      pellets?: number;
      spread?: number;
    }
  | { type: 'combat:explode'; pos: Vec3Tuple; radius: number; ownerId?: string }
  | { type: 'combat:kick'; ownerId: string; eye: Vec3Tuple; dir: Vec3Tuple }
  | { type: 'combat:throw'; ownerId: string; itemKind: string; origin: Vec3Tuple; dir: Vec3Tuple }
  | { type: 'player:impulse'; targetId: string; vec: Vec3Tuple }
  | {
      type: 'player:sync';
      cash: number;
      crystal: number;
      items: Record<string, number>;
      blocksInv: Record<string, number>;
      doneTools?: string[];
      ownedWeapons: string[];
      ammo: Record<string, number>;
      reserve: Record<string, number>;
      activeWeapon?: string;
      reloadT?: number;
      respawnIn?: number;
      killerId?: string;
      killerWeapon?: string;
      isFinalDeath?: boolean;
      deathCause?: string;
      deathHead?: boolean;
      notice?: string;
      noticeColor?: string;
      soundKind?: 'coins' | 'pickup' | 'reject' | 'eat' | 'patch';
    }
  | {
      type: 'match:event';
      kind: 'bed_hit' | 'bed_stage1' | 'bed_blast' | 'bed_broken' | 'win' | 'lose';
      team: TeamId;
      hp?: number;
      byId?: string;
      byTeam?: TeamId | null;
      pos?: Vec3Tuple;
      blastPos?: Vec3Tuple;
    }
  | { type: 'sound'; name: string; pos: Vec3Tuple; volume?: number }
  | { type: 'chat'; sender: string; text: string };

/** Envelope for network packets over WebRTC data channels. */
export type NetPacket =
  | { kind: 'lobby'; data: LobbyMessage }
  | { kind: 'input'; data: PlayerInputPacket }
  | { kind: 'action'; data: ClientAction }
  | { kind: 'snapshot'; data: WorldSnapshot }
  | { kind: 'event'; data: WorldEvent }
  | { kind: 'ping'; t: number }
  | { kind: 'pong'; t: number };

/** Prefix for rooms to prevent collisions with other PeerJS applications. */
export const ROOM_PREFIX = 'gw-room-';

/** Generate a short 5-character readable room code. */
export function generateRoomCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** Formats user-facing room code (supporting optional GW- / gw-room- prefixes) to full peer ID. */
export function roomToPeerId(code: string): string {
  let raw = code.trim().toUpperCase();
  if (raw.startsWith(ROOM_PREFIX.toUpperCase())) raw = raw.slice(ROOM_PREFIX.length);
  if (/^GW[-_\s]+/.test(raw) || (/^GW[A-Z0-9]{4,}$/.test(raw) && raw.length >= 6)) {
    raw = raw.replace(/^GW[-_\s]*/, '');
  }
  const clean = raw.replace(/[^A-Z0-9]/g, '');
  return `${ROOM_PREFIX}${clean}`;
}

/** Formats peer ID back to short user room code. */
export function peerIdToRoom(peerId: string): string {
  return peerId.startsWith(ROOM_PREFIX) ? peerId.slice(ROOM_PREFIX.length) : peerId;
}
