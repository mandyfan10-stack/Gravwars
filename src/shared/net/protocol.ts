import type { Difficulty } from '../bots';
import type { LobbyConfig } from '../lobby';
import type { TeamId } from '../teams';

export type NetworkRole = 'host' | 'client';

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
  | { type: 'lobby:welcome'; yourId: string; players: NetworkPlayerInfo[]; config: LobbyConfig }
  | { type: 'lobby:update'; players: NetworkPlayerInfo[]; config: LobbyConfig }
  | { type: 'lobby:seat'; team: TeamId; seatIndex: number }
  | { type: 'lobby:bot'; team: TeamId; seatIndex: number; difficulty: Difficulty }
  | { type: 'lobby:remove_seat'; team: TeamId; seatIndex: number }
  | { type: 'lobby:start'; seed: number; config: LobbyConfig; activeTeams: TeamId[]; mapTeam?: TeamId };

/** Input vector sent from client to host at fixed tick rate (~60Hz). */
export interface PlayerInputPacket {
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

/** Client actions that produce immediate authoritative changes on host. */
export type ClientAction =
  | { type: 'fire'; weapon: string; origin: [number, number, number]; dir: [number, number, number]; chargeT?: number }
  | { type: 'reload' }
  | { type: 'kick'; eye: [number, number, number]; dir: [number, number, number] }
  | { type: 'hook'; eye: [number, number, number]; dir: [number, number, number]; release?: boolean }
  | { type: 'throw'; kind: string; origin: [number, number, number]; dir: [number, number, number] }
  | {
      type: 'build_place';
      kind: string;
      center: [number, number, number];
      half: [number, number, number];
      quat: [number, number, number, number];
      material: string;
      team: TeamId;
    }
  | { type: 'build_remove'; pos: [number, number, number] }
  | { type: 'buy'; itemId: string }
  | { type: 'sell'; kind: string }
  | { type: 'interact'; target: string; targetId?: number };

/** Serialized state of a single player in the world snapshot. */
export interface RemotePlayerSnapshot {
  id: string;
  pos: [number, number, number];
  vel: [number, number, number];
  frame: [number, number, number, number]; // Quaternion x,y,z,w
  yaw: number;
  pitch: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  onGround: boolean;
  team: TeamId;
  activeWeapon: string;
  hookPos: [number, number, number] | null;
  crouching: boolean;
  isFiring: boolean;
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
  pos: [number, number, number];
  vel: [number, number, number];
  frame: [number, number, number, number];
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
}

/** Authoritative world snapshot broadcast by host (~20-30Hz). */
export interface WorldSnapshot {
  tick: number;
  serverTime: number;
  players: RemotePlayerSnapshot[];
  crystals: Record<TeamId, CrystalSnapshot>;
  bots?: RemoteBotSnapshot[];
}

/** Discrete world events sent reliably from host to clients. */
export type WorldEvent =
  | {
      type: 'block:place';
      kind: string;
      center: [number, number, number];
      half: [number, number, number];
      quat: [number, number, number, number];
      material: string;
      team: TeamId | null;
    }
  | { type: 'block:damage'; id: number; hp: number }
  | { type: 'block:break'; pos: [number, number, number] }
  | { type: 'combat:hit'; victimId: string; attackerId: string; damage: number; isHead: boolean; killed?: boolean; weapon?: string; victimTeam?: TeamId; isNpc?: boolean }
  | { type: 'combat:kill'; victimId: string; attackerId: string; weapon: string; dist: number; isHead: boolean; attackerTeam?: TeamId; victimTeam?: TeamId }
  | { type: 'combat:bullet'; ownerId: string; origin: [number, number, number]; dir: [number, number, number]; weapon: string; chargeT?: number }
  | { type: 'combat:kick'; ownerId: string; eye: [number, number, number]; dir: [number, number, number] }
  | { type: 'combat:throw'; ownerId: string; itemKind: string; origin: [number, number, number]; dir: [number, number, number] }
  | { type: 'player:impulse'; targetId: string; vec: [number, number, number] }
  | { type: 'sound'; name: string; pos: [number, number, number]; volume?: number }
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
