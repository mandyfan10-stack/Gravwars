import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { BlockMaterial, BlockSystem } from '../../shared/blocks';
import { BotManager } from '../../shared/bots';
import { Combat, Faction, Target } from '../../shared/combat';
import { Economy } from '../../shared/economy';
import { Pickups } from '../../shared/economy';
import { escapeHtml } from '../../shared/escape';
import { Holdable } from '../../shared/inventory';
import { LobbyConfig } from '../../shared/lobby';
import { MapData } from '../../shared/map';
import { Match } from '../../shared/match';
import { MoveInput } from '../../shared/movement';
import type { UserCommand } from '../../shared/net/pmove';
import { RateLimiter } from '../../shared/net/validate';
import { NpcManager } from '../../shared/npcs';
import { PhysicsWorld, Rapier } from '../../shared/physics';
import { Props } from '../../shared/props';
import { PlayerSim } from '../../shared/sim';
import { TeamId, getTeam } from '../../shared/teams';
import { Throws } from '../../shared/throwables';
import { WeaponId, WeaponState } from '../../shared/weapons';
import { GameAudio } from '../audio';
import { BlockController } from '../blockController';
import { Hands } from '../hands';
import { Hud, teamHex } from '../hud';
import type { InventoryUi } from '../inventoryUi';
import { LocalPlayer } from '../localPlayer';
import { MatchUi } from '../matchUi';
import { PlayerCombat } from '../playerCombat';
import { Pockets } from '../pockets';
import { Fx } from '../render/fx';
import { MapView } from '../render/mapView';
import { MatchStats } from '../stats';
import { P2PTransport } from './p2p';
import { RemotePlayerManager } from './remotePlayerManager';

export const SNAPSHOT_INTERVAL = 0.04; // 25 Hz authoritative snapshots
export const PICKUP_RESYNC_TICKS = 25;

export interface HumanLobbySeat {
  id: string;
  name: string;
  team: TeamId;
}

export interface RemoteClientSim {
  peerId: string;
  name: string;
  team: TeamId;
  sim: PlayerSim;
  target: Target;
  weapons: WeaponState;
  wallet: { cash: number; crystal: number };
  blocksInv: Record<BlockMaterial, number>;
  eco: Economy;
  input: MoveInput;
  cmd: UserCommand;
  yaw: number;
  pitch: number;
  heldItem?: Holdable;
  lastSeq: number;
  lastTick: number;
  firing: boolean;
  reloadT: number;
  reloadW: WeaponId | null;
  reloadCap: number;
  reloadTotal: number;
  reloadEmpty: boolean;
  respawnT: number;
  woodRegenT: number;
  out: boolean;
  disconnected: boolean;
  dirtySync: boolean;
  pendingNotice?: { text: string; color: string };
  pendingSound?: 'pickup' | 'coins' | 'reject' | 'eat' | 'patch';
  deathInfo?: { cause: 'killed' | 'fall' | 'self' | 'void'; killerId?: string; weapon?: string; head?: boolean; final?: boolean };
  /** Host-side anti-cheat: per-action rate limits and timers (seconds of `performance.now()`). */
  limiter: RateLimiter;
  kickCdUntil: number;
  crossbowReadyAt: number;
  lastFishAt: number;
}

export interface SpectatorTarget {
  id: string;
  name: string;
  team: TeamId;
  pos: Vector3;
  up: Vector3;
  frame: Quaternion;
  yaw: number;
  pitch: number;
  alive: boolean;
  hp: number;
  weapon: string;
}

export interface NetMatchDeps {
  transport: P2PTransport;
  lobby: LobbyConfig;
  isHost: boolean;
  myId: string;
  R: Rapier;
  world: PhysicsWorld;
  map: MapData;
  sim: PlayerSim;
  local: LocalPlayer;
  combat: Combat;
  blocks: BlockSystem;
  props: Props;
  match: Match;
  bots: BotManager;
  npcs: NpcManager;
  throws: Throws;
  pickups: Pickups;
  eco: Economy;
  pockets: Pockets;
  player: PlayerCombat;
  hands: Hands;
  build: BlockController;
  ui: MatchUi;
  invUi?: InventoryUi;
  stats: MatchStats;
  hud: Hud;
  fx: Fx;
  audio: GameAudio;
  mapView: MapView;
  remotePlayers: RemotePlayerManager;
  camera: PerspectiveCamera;
  onHostDisconnect?: () => void;
  onChat?: (sender: string, text: string, team?: TeamId) => void;
}

const _losV = new Vector3();

export function hasLineOfSight(
  R: Rapier,
  world: PhysicsWorld,
  from: Vector3,
  to: Vector3,
  notChar: (c: { handle: number }) => boolean,
): boolean {
  const dir = _losV.copy(to).sub(from);
  const dist = dir.length();
  if (dist < 0.5) return true;
  dir.divideScalar(dist);
  const hit = world.castRay(new R.Ray(from, dir), dist - 0.35, true, undefined, undefined, undefined, undefined, notChar);
  return !hit;
}

export function lobbyHumans(lobby: LobbyConfig, fallbackHostId: string): HumanLobbySeat[] {
  const out: HumanLobbySeat[] = [];
  for (const [team, list] of Object.entries(lobby.seats) as [TeamId, LobbyConfig['seats'][TeamId]][]) {
    for (const s of list) {
      if (s?.kind === 'player') {
        const id = s.id || fallbackHostId;
        out.push({ id, name: s.name || getTeam(team).name, team });
      }
    }
  }
  return out;
}

export function resolvePlayerLabel(id: string | undefined, deps: NetMatchDeps, humansById: ReadonlyMap<string, HumanLobbySeat>): string {
  if (!id) return '';
  if (id.startsWith('bot:')) {
    const b = deps.bots.bots.find((it) => it.id === Number(id.slice(4)));
    return b ? `Бот ${getTeam(b.team).name}` : 'Бот';
  }
  if (id.startsWith('npc:')) return 'Бандит';
  const seat = humansById.get(id);
  if (seat) return escapeHtml(seat.name);
  const rp = deps.remotePlayers.list().find((r) => r.id === id);
  return rp ? escapeHtml(rp.name) : escapeHtml(id.slice(0, 6));
}

export function resolvePlayerTeam(
  id: string | undefined,
  myId: string,
  deps: NetMatchDeps,
  humansById: ReadonlyMap<string, HumanLobbySeat>,
  remoteClients?: ReadonlyMap<string, RemoteClientSim>,
): TeamId | undefined {
  if (!id) return undefined;
  if (id.startsWith('bot:')) {
    const b = deps.bots.bots.find((it) => it.id === Number(id.slice(4)));
    return b?.team;
  }
  if (id === myId) return deps.match.team;
  const rc = remoteClients?.get(id);
  if (rc) return rc.team;
  const seat = humansById.get(id);
  if (seat) return seat.team;
  return deps.remotePlayers.list().find((r) => r.id === id)?.team;
}

export function resolveEntityFaction(
  id: string | undefined,
  myId: string,
  deps: NetMatchDeps,
  humansById: ReadonlyMap<string, HumanLobbySeat>,
  remoteClients?: ReadonlyMap<string, RemoteClientSim>,
): Faction | undefined {
  if (!id) return undefined;
  if (id.startsWith('npc:')) {
    const n = deps.npcs.npcs.find((it) => it.id === Number(id.slice(4)));
    return n?.target.team;
  }
  return resolvePlayerTeam(id, myId, deps, humansById, remoteClients);
}

export function teamBadge(team: TeamId, label: string): string {
  const t = getTeam(team);
  return `<b style="color:${teamHex(t.color)}">${escapeHtml(label)}</b>`;
}

export function playRemoteGunAudio(weapon: WeaponId, pos: Vector3, deps: NetMatchDeps) {
  const d = pos.distanceTo(deps.camera.position);
  if (weapon === 'shotgun') deps.audio.shotgun(d, false);
  else if (weapon === 'rocket') deps.audio.rocket(d);
  else if (weapon === 'crossbow') deps.audio.crossbowShot(0, d);
  else if (weapon === 'pistol' || weapon === 'rifle') deps.audio.shot(weapon === 'pistol', d);
}
