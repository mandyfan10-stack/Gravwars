import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { BlockMaterial, BlockSystem } from '../../shared/blocks';
import type { BotManager } from '../../shared/bots';
import type { Combat, Faction, Target } from '../../shared/combat';
import type { Economy, Pickups } from '../../shared/economy';
import { escapeHtml } from '../../shared/escape';
import type { Holdable } from '../../shared/inventory';
import type { LobbyConfig } from '../../shared/lobby';
import type { MapData } from '../../shared/map';
import type { Match } from '../../shared/match';
import type { MoveInput } from '../../shared/movement';
import type { UserCommand } from '../../shared/net/pmove';
import { PICKUP_RESYNC_TICKS, SNAPSHOT_INTERVAL } from '../../shared/net/snapshot';
import type { RateLimiter } from '../../shared/net/validate';
import type { NpcManager } from '../../shared/npcs';
import type { PhysicsWorld, Rapier } from '../../shared/physics';
import type { Props } from '../../shared/props';
import type { PlayerSim } from '../../shared/sim';
import { TeamId, getTeam } from '../../shared/teams';
import type { Throws } from '../../shared/throwables';
import type { WeaponId, WeaponState } from '../../shared/weapons';
import type { GameAudio } from '../audio';
import type { BlockController } from '../blockController';
import type { Hands } from '../hands';
import type { Hud } from '../hud';
import type { InventoryUi } from '../inventoryUi';
import type { LocalPlayer } from '../localPlayer';
import type { MatchUi } from '../matchUi';
import type { PlayerCombat } from '../playerCombat';
import type { Pockets } from '../pockets';
import type { Fx } from '../render/fx';
import type { MapView } from '../render/mapView';
import type { MatchStats } from '../stats';
import type { P2PTransport } from './p2p';
import type { RemotePlayerManager } from './remotePlayerManager';

export { PICKUP_RESYNC_TICKS, SNAPSHOT_INTERVAL };

const teamHex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

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
  crystalAmmoT: number;
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
  maxHp?: number;
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

export function playRemoteGunAudio(weapon: WeaponId, pos: Vector3, deps: Pick<NetMatchDeps, 'camera' | 'audio'>, chargeT = 0) {
  const d = pos.distanceTo(deps.camera.position);
  if (weapon === 'shotgun') deps.audio.shotgun(d, false);
  else if (weapon === 'revolver') deps.audio.revolver(d);
  else if (weapon === 'rocket') deps.audio.rocket(d);
  else if (weapon === 'crossbow') deps.audio.crossbowShot(chargeT, d);
  else if (weapon === 'pistol' || weapon === 'rifle') deps.audio.shot(weapon === 'pistol', d);
}
