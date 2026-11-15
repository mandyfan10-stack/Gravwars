import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import {
  Block, BlockKind, BlockMaterial, BlockSystem, PieceKind, START_BLOCKS,
} from '../../shared/blocks';
import { BotManager } from '../../shared/bots';
import { Combat, CombatEvent, Faction, MAX_HP, SPAWN_GUARD, Target } from '../../shared/combat';
import { EYE_OFFSET } from '../../shared/constants';
import {
  Economy, ItemId, Pickups, PickupKind, SHOP, Step,
} from '../../shared/economy';
import { escapeHtml } from '../../shared/escape';
import { Holdable } from '../../shared/inventory';
import { LobbyConfig } from '../../shared/lobby';
import { MapData } from '../../shared/map';
import { BED_HP, CRYSTAL_INVULN_TIME, KILL_REWARD, Match, MatchEvent } from '../../shared/match';
import { upOf } from '../../shared/math';
import { MoveInput, emptyInput } from '../../shared/movement';
import { PhysicsWorld, Rapier } from '../../shared/physics';
import { Props } from '../../shared/props';
import { PlayerSim } from '../../shared/sim';
import { TeamId, getTeam } from '../../shared/teams';
import { Throws } from '../../shared/throwables';
import { NpcManager, NpcState } from '../../shared/npcs';
import {
  WEAPONS, WEAPON_ORDER, WeaponId, WeaponState, createWeaponState, isGun, refillAmmo,
} from '../../shared/weapons';
import {
  ClientAction, CrystalSnapshot, NetPacket, PlayerInputPacket, RemoteBotSnapshot,
  RemoteCarSnapshot, RemoteNpcSnapshot, RemotePlayerSnapshot, WorldEvent, WorldSnapshot,
} from '../../shared/net/protocol';
import { GameAudio } from '../audio';
import { BlockController } from '../blockController';
import { Hands } from '../hands';
import { Hud, teamHex } from '../hud';
import { LocalPlayer } from '../localPlayer';
import { MatchUi } from '../matchUi';
import { DEATH_TIME, PlayerCombat, killIcon } from '../playerCombat';
import { Pockets } from '../pockets';
import { Fx } from '../render/fx';
import { MapView } from '../render/mapView';
import { MatchStats } from '../stats';
import { P2PTransport } from './p2p';
import { RemotePlayerManager } from './remotePlayerManager';

const SNAPSHOT_INTERVAL = 0.04; // 25 Hz authoritative snapshots
const HISTORY_LIMIT = 128;
const PICKUP_RESYNC_TICKS = 25;

interface HumanLobbySeat {
  id: string;
  name: string;
  team: TeamId;
}

interface PredictedFrame {
  seq: number;
  pos: Vector3;
  vel: Vector3;
  frame: Quaternion;
}

interface RemoteClientSim {
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
  yaw: number;
  pitch: number;
  heldItem?: Holdable;
  lastSeq: number;
  firing: boolean;
  reloadT: number;
  reloadW: WeaponId | null;
  respawnT: number;
  out: boolean;
  disconnected: boolean;
  dirtySync: boolean;
  pendingNotice?: { text: string; color: string };
  pendingSound?: 'pickup' | 'coins' | 'reject' | 'eat' | 'patch';
  deathInfo?: { cause: 'killed' | 'fall' | 'self' | 'void'; killerId?: string; weapon?: string; head?: boolean; final?: boolean };
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
  stats: MatchStats;
  hud: Hud;
  fx: Fx;
  audio: GameAudio;
  mapView: MapView;
  remotePlayers: RemotePlayerManager;
  camera: PerspectiveCamera;
  onHostDisconnect?: () => void;
}

const _tmpV = new Vector3();
const _tmpV2 = new Vector3();
const _tmpQ = new Quaternion();

function hasLineOfSight(
  R: Rapier,
  world: PhysicsWorld,
  from: Vector3,
  to: Vector3,
  notChar: (c: { handle: number }) => boolean,
): boolean {
  const dir = _tmpV.copy(to).sub(from);
  const dist = dir.length();
  if (dist < 0.5) return true;
  dir.divideScalar(dist);
  const hit = world.castRay(new R.Ray(from, dir), dist - 0.35, true, undefined, undefined, undefined, undefined, notChar);
  return !hit;
}

function lobbyHumans(lobby: LobbyConfig, fallbackHostId: string): HumanLobbySeat[] {
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

/**
 * Authoritative Host + Client Prediction/Interpolation coordinator for active P2P matches.
 */
export class NetMatchController {
  private readonly isHost: boolean;
  private readonly myId: string;
  private readonly humansById = new Map<string, HumanLobbySeat>();
  private readonly hostId: string;
  private readonly hostTeam: TeamId;

  // Host state
  private readonly remoteClients = new Map<string, RemoteClientSim>();
  private readonly targetToClient = new Map<number, RemoteClientSim>();
  private nextClientTargetId = 2000;
  private hostOut = false;
  private snapAccum = 0;
  private snapTick = 0;
  private lastPickupsVersion = -1;

  // Client state
  private readonly remoteProxyTargets = new Map<string, Target>();
  private readonly predictedHistory: PredictedFrame[] = [];
  private localSeq = 0;
  private clientOut = false;
  private latestSnapshot: WorldSnapshot | null = null;
  private readonly botTargets = new Map<number, RemoteBotSnapshot>();
  private readonly npcTargets = new Map<number, RemoteNpcSnapshot>();
  private readonly carTargets = new Map<number, RemoteCarSnapshot>();
  private clientHostDisconnected = false;

  constructor(private readonly deps: NetMatchDeps) {
    this.isHost = deps.isHost;
    this.myId = deps.myId;
    const seats = lobbyHumans(deps.lobby, deps.isHost ? deps.myId : 'host');
    for (const s of seats) this.humansById.set(s.id, s);

    if (this.isHost) {
      this.hostId = this.myId;
      this.hostTeam = deps.match.team;
      this.setupHost(seats);
    } else {
      const firstOther = seats.find((s) => s.id !== this.myId && !s.id.startsWith('local')) ?? seats.find((s) => s.id !== this.myId);
      const hostInfo = seats.find((s) => s.name.includes('(Хост)')) ?? firstOther;
      this.hostId = hostInfo?.id ?? 'host';
      this.hostTeam = (hostInfo?.team ?? deps.map.teams[0] ?? 'red') as TeamId;
      this.setupClient();
    }
  }

  // --- Shared identity helpers -------------------------------------------------------------------

  private playerLabel(id: string | undefined): string {
    if (!id) return '';
    if (id.startsWith('bot:')) {
      const b = this.deps.bots.bots.find((it) => it.id === Number(id.slice(4)));
      return b ? `Бот ${getTeam(b.team).name}` : 'Бот';
    }
    if (id.startsWith('npc:')) return 'Бандит';
    const seat = this.humansById.get(id);
    if (seat) return escapeHtml(seat.name);
    const rp = this.deps.remotePlayers.list().find((r) => r.id === id);
    return rp ? escapeHtml(rp.name) : escapeHtml(id.slice(0, 6));
  }

  private playerTeam(id: string | undefined): TeamId | undefined {
    if (!id) return undefined;
    if (id.startsWith('bot:')) {
      const b = this.deps.bots.bots.find((it) => it.id === Number(id.slice(4)));
      return b?.team;
    }
    if (id === this.myId) return this.deps.match.team;
    const rc = this.remoteClients.get(id);
    if (rc) return rc.team;
    const seat = this.humansById.get(id);
    if (seat) return seat.team;
    return this.deps.remotePlayers.list().find((r) => r.id === id)?.team;
  }

  private entityFaction(id: string | undefined): Faction | undefined {
    if (!id) return undefined;
    if (id.startsWith('npc:')) {
      const n = this.deps.npcs.npcs.find((it) => it.id === Number(id.slice(4)));
      return n?.target.team;
    }
    return this.playerTeam(id);
  }

  private ownerIdForTarget(targetId: number): string {
    if (targetId === 0) return this.myId;
    if (targetId >= 2000) return this.targetToClient.get(targetId)?.peerId ?? `p:${targetId}`;
    if (targetId >= 500 && targetId < 1000) return `npc:${targetId}`;
    if (targetId >= 100 && targetId < 500) return `bot:${targetId}`;
    return String(targetId);
  }

  private playRemoteGunAudio(weapon: WeaponId, pos: Vector3) {
    const d = pos.distanceTo(this.deps.camera.position);
    if (weapon === 'shotgun') this.deps.audio.shotgun(d, false);
    else if (weapon === 'rocket') this.deps.audio.rocket(d);
    else if (weapon === 'crossbow') this.deps.audio.crossbowShot(0, d);
    else if (weapon === 'pistol' || weapon === 'rifle') this.deps.audio.shot(weapon === 'pistol', d);
  }

  private teamBadge(team: TeamId, label: string): string {
    const t = getTeam(team);
    return `<b style="color:${teamHex(t.color)}">${escapeHtml(label)}</b>`;
  }

  /** Living remote human fighters (for SpectatorController). */
  getHumanSpectatorTargets() {
    const list: {
      id: string; name: string; team: TeamId; pos: Vector3; up: Vector3; frame: Quaternion;
      yaw: number; pitch: number; alive: boolean; hp: number; weapon: string;
    }[] = [];
    if (this.isHost) {
      for (const rc of this.remoteClients.values()) {
        if (rc.disconnected) continue;
        list.push({
          id: rc.peerId, name: rc.name, team: rc.team,
          pos: rc.sim.state.pos, up: upOf(rc.sim.state.frame).clone(), frame: rc.sim.state.frame,
          yaw: rc.yaw, pitch: rc.pitch,
          alive: rc.target.alive && !rc.out, hp: rc.target.hp,
          weapon: rc.weapons.current,
        });
      }
    } else {
      for (const rp of this.deps.remotePlayers.list()) {
        list.push({
          id: rp.id, name: rp.name, team: rp.team,
          pos: rp.pos, up: rp.up, frame: rp.frame, yaw: rp.yaw, pitch: rp.pitch,
          alive: rp.alive, hp: rp.hp, weapon: rp.weapon,
        });
      }
    }
    return list;
  }

  // --- HOST SETUP & SIMULATION -------------------------------------------------------------------

  private setupHost(seats: HumanLobbySeat[]) {
    const {
      transport, combat, blocks, props, match, bots, npcs, player, hands, build,
    } = this.deps;

    for (const s of seats) {
      if (s.id === this.myId) continue;
      this.createRemoteClientSim(s);
    }

    // Match.otherHumansAlive returns the number of non-eliminated other human players on a team
    match.otherHumansAlive = (team) => {
      let count = 0;
      for (const rc of this.remoteClients.values()) {
        if (!rc.disconnected && rc.team === team && !rc.out) count++;
      }
      return count;
    };

    const prevReviveAll = match.onReviveAll;
    match.onReviveAll = (crystalTeam) => {
      prevReviveAll?.(crystalTeam);
      for (const rc of this.remoteClients.values()) {
        if (!rc.disconnected && !rc.out && !rc.target.alive) this.reviveRemoteClient(rc);
      }
    };

    const prevOnKill = combat.onKill;
    combat.onKill = (victim, owner) => {
      prevOnKill(victim, owner);
      const rc = this.targetToClient.get(owner);
      if (rc && !victim.npc && victim.team !== rc.team) {
        rc.wallet.cash += KILL_REWARD;
        rc.dirtySync = true;
      }
    };

    player.onFire = (weapon, origin, dir, chargeT) => {
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'combat:bullet',
          ownerId: this.myId,
          origin: [origin.x, origin.y, origin.z],
          dir: [dir.x, dir.y, dir.z],
          weapon,
          chargeT,
        },
      });
    };
    player.onKick = (eye, dir) => {
      transport.broadcast({
        kind: 'event',
        data: { type: 'combat:kick', ownerId: this.myId, eye: [eye.x, eye.y, eye.z], dir: [dir.x, dir.y, dir.z] },
      });
    };
    hands.onThrow = (itemKind, origin, dir) => {
      transport.broadcast({
        kind: 'event',
        data: { type: 'combat:throw', ownerId: this.myId, itemKind, origin: [origin.x, origin.y, origin.z], dir: [dir.x, dir.y, dir.z] },
      });
    };

    bots.onShot = (botId, weapon, origin, dir, chargeT) => {
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'combat:bullet',
          ownerId: `bot:${botId}`,
          origin: [origin.x, origin.y, origin.z],
          dir: [dir.x, dir.y, dir.z],
          weapon,
          chargeT,
        },
      });
    };
    bots.onKick = (botId, eye, dir) => {
      transport.broadcast({
        kind: 'event',
        data: { type: 'combat:kick', ownerId: `bot:${botId}`, eye: [eye.x, eye.y, eye.z], dir: [dir.x, dir.y, dir.z] },
      });
    };
    npcs.onShot = (npcId, weapon, origin, dir) => {
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'combat:bullet',
          ownerId: `npc:${npcId}`,
          origin: [origin.x, origin.y, origin.z],
          dir: [dir.x, dir.y, dir.z],
          weapon,
          chargeT: 0,
        },
      });
    };

    const broadcastPlace = (b: Block) => {
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'block:place',
          kind: b.kind,
          center: [b.center.x, b.center.y, b.center.z],
          half: [b.half.x, b.half.y, b.half.z],
          quat: [b.quat.x, b.quat.y, b.quat.z, b.quat.w],
          material: b.material,
          team: b.team,
          key: b.key ?? undefined,
          level: b.level,
        },
      });
    };
    blocks.onPlace = broadcastPlace;
    build.onBlockReclaimed = (b) => {
      transport.broadcast({ kind: 'event', data: { type: 'block:break', pos: [b.center.x, b.center.y, b.center.z] } });
    };
    blocks.onDamage = (b) => {
      transport.broadcast({
        kind: 'event',
        data: { type: 'block:damage', id: b.id, hp: b.hp, pos: [b.center.x, b.center.y, b.center.z] },
      });
    };
    const prevOnBreak = blocks.onBreak;
    blocks.onBreak = (b) => {
      prevOnBreak?.(b);
      transport.broadcast({ kind: 'event', data: { type: 'block:break', pos: [b.center.x, b.center.y, b.center.z] } });
    };
    const prevPropBreak = props.onBreak;
    props.onBreak = (i, pos, up, kind) => {
      prevPropBreak?.(i, pos, up, kind);
      transport.broadcast({ kind: 'event', data: { type: 'prop:break', idx: i } });
    };
    props.consumeNetDirty();

    transport.events.onPeerLeave = (peerId) => {
      const rc = this.remoteClients.get(peerId);
      if (!rc) return;
      rc.disconnected = true;
      rc.out = true;
      rc.target.alive = false;
      const ti = combat.targets.indexOf(rc.target);
      if (ti >= 0) combat.targets.splice(ti, 1);
      combat.removeCharacter(rc.sim.mover.collider);
      const ci = blocks.characters.indexOf(rc.sim.mover.collider);
      if (ci >= 0) blocks.characters.splice(ci, 1);
      this.targetToClient.delete(rc.target.id);
      this.remoteClients.delete(peerId);
      this.deps.hud.killfeed(`${this.teamBadge(rc.team, rc.name)} вышел из матча`);
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'combat:kill',
          victimId: peerId,
          attackerId: '',
          weapon: '',
          dist: 0,
          isHead: false,
          cause: 'quit',
          final: true,
          victimTeam: rc.team,
        },
      });
    };

    transport.events.onMessage = (peerId, packet) => {
      const rc = this.remoteClients.get(peerId);
      if (!rc || rc.disconnected) return;
      if (packet.kind === 'input') {
        this.applyClientInput(rc, packet.data);
      } else if (packet.kind === 'action') {
        this.handleClientAction(rc, packet.data);
      }
    };
  }

  private createRemoteClientSim(seat: HumanLobbySeat) {
    const { R, world, map, combat, blocks } = this.deps;
    const sim = new PlayerSim(R, world, map, seat.team);
    sim.gravity.blocks = () => blocks.blocks.values();
    sim.respawn('manual');
    sim.events.length = 0;
    combat.addCharacter(sim.mover.collider);
    blocks.characters.push(sim.mover.collider);

    const targetId = this.nextClientTargetId++;
    const target: Target = {
      id: targetId,
      team: seat.team,
      center: sim.state.pos,
      up: upOf(sim.state.frame),
      vel: sim.state.vel,
      hp: MAX_HP,
      alive: true,
      respawnIn: -1,
      regen: true,
      isHuman: true,
      airborne: () => !sim.state.onGround,
      crouched: false,
      quiet: false,
      onImpulse: (v) => sim.applyImpulse(v),
    };
    combat.targets.push(target);

    const weapons = createWeaponState();
    const wallet = { cash: 0, crystal: 0 };
    const blocksInv: Record<BlockMaterial, number> = { ...START_BLOCKS, wood: 0 };
    const eco = new Economy(wallet, { inventory: blocksInv }, weapons);

    const rc: RemoteClientSim = {
      peerId: seat.id,
      name: seat.name,
      team: seat.team,
      sim,
      target,
      weapons,
      wallet,
      blocksInv,
      eco,
      input: emptyInput(),
      yaw: sim.state.yaw,
      pitch: 0,
      lastSeq: 0,
      firing: false,
      reloadT: 0,
      reloadW: null,
      respawnT: 0,
      out: false,
      disconnected: false,
      dirtySync: true,
    };
    this.remoteClients.set(seat.id, rc);
    this.targetToClient.set(targetId, rc);
  }

  private applyClientInput(rc: RemoteClientSim, inp: PlayerInputPacket) {
    const seq = inp.seq ?? rc.lastSeq + 1;
    if (seq <= rc.lastSeq) return;
    rc.lastSeq = seq;
    rc.input.forward = Math.max(-1, Math.min(1, inp.forward));
    rc.input.right = Math.max(-1, Math.min(1, inp.right));
    rc.input.up = Math.max(-1, Math.min(1, inp.up));
    rc.input.jump = !!inp.jump;
    rc.input.sprint = !!inp.sprint;
    rc.input.crouch = !!inp.crouch;
    rc.input.yaw = inp.yaw;
    rc.input.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, inp.pitch));
    rc.yaw = rc.input.yaw;
    rc.pitch = rc.input.pitch;
    if (inp.weapon && (inp.weapon === 'fists' || rc.weapons.owned[inp.weapon as WeaponId])) {
      rc.weapons.current = inp.weapon as WeaponId;
    }
  }

  private handleClientAction(rc: RemoteClientSim, act: ClientAction) {
    const { combat, blocks, match, pickups, throws, transport } = this.deps;
    if (act.type === 'select_slot') {
      const w = act.weapon as WeaponId | undefined;
      if (w && (w === 'fists' || rc.weapons.owned[w])) rc.weapons.current = w;
      return;
    }
    if (act.type === 'hook') {
      if (act.release) rc.sim.releaseHook();
      else if (rc.target.alive && !rc.out) rc.sim.throwHook(new Vector3(...act.eye), new Vector3(...act.dir), combat.notCharacter);
      return;
    }
    if (rc.out || !rc.target.alive) return;

    if (act.type === 'fire') {
      const w = act.weapon as WeaponId;
      if (w !== 'fists' && !rc.weapons.owned[w]) { rc.dirtySync = true; return; }
      if (isGun(w)) {
        if (rc.weapons.ammo[w] <= 0) { rc.dirtySync = true; return; }
        rc.weapons.ammo[w]--;
      }
      rc.firing = true;
      const o = new Vector3(...act.origin);
      const d = new Vector3(...act.dir).normalize();
      combat.use(w, rc.target.id, o, d, rc.sim.state.vel, rc.sim.gravityDown(), act.chargeT ?? 0);
      this.deps.remotePlayers.triggerFire(rc.peerId);
      transport.broadcast({
        kind: 'event',
        data: { type: 'combat:bullet', ownerId: rc.peerId, origin: act.origin, dir: [d.x, d.y, d.z], weapon: w, chargeT: act.chargeT },
      }, rc.peerId);
    } else if (act.type === 'reload') {
      const w = rc.weapons.current;
      if (!isGun(w) || !rc.weapons.owned[w] || rc.weapons.reserve[w] <= 0) { rc.dirtySync = true; return; }
      if (rc.weapons.ammo[w] >= WEAPONS[w].mag) return;
      rc.reloadW = w;
      rc.reloadT = WEAPONS[w].reload;
    } else if (act.type === 'kick') {
      combat.kick(rc.target.id, new Vector3(...act.eye), new Vector3(...act.dir), rc.target.up);
      this.deps.remotePlayers.triggerKick(rc.peerId);
      transport.broadcast({
        kind: 'event',
        data: { type: 'combat:kick', ownerId: rc.peerId, eye: act.eye, dir: act.dir },
      }, rc.peerId);
    } else if (act.type === 'throw') {
      const kind = act.kind as ItemId;
      if ((kind !== 'apple' && kind !== 'bottle') || !rc.eco.take(kind)) { rc.dirtySync = true; return; }
      throws.throw(kind, rc.target.id, new Vector3(...act.origin), new Vector3(...act.dir), rc.sim.state.vel, rc.sim.gravityDown());
      rc.dirtySync = true;
      transport.broadcast({
        kind: 'event',
        data: { type: 'combat:throw', ownerId: rc.peerId, itemKind: kind, origin: act.origin, dir: act.dir },
      }, rc.peerId);
    } else if (act.type === 'build_place') {
      const mat = act.material as BlockMaterial;
      const c = new Vector3(...act.center);
      const h = new Vector3(...act.half);
      const q = new Quaternion(...act.quat);
      const plan = {
        kind: (act.kind === 'block' ? 'wall' : act.kind) as PieceKind,
        center: c,
        half: h,
        quat: q,
        key: act.key ?? `${act.kind}:${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}`,
        level: act.level ?? 0,
      };
      const cost = blocks.costOf(plan);
      const tooFar = c.distanceTo(rc.sim.state.pos) > 15;
      if (act.team !== rc.team || tooFar || rc.blocksInv[mat] < cost || blocks.validate(plan, mat, true) !== 'ok') {
        transport.sendTo(rc.peerId, { kind: 'event', data: { type: 'block:break', pos: act.center } });
        rc.dirtySync = true;
        return;
      }
      rc.blocksInv[mat] -= cost;
      blocks.insertPiece(act.kind as BlockKind, c, h, q, mat, rc.team, act.key, act.level);
      rc.dirtySync = true;
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'block:place', kind: act.kind, center: act.center, half: act.half, quat: act.quat,
          material: mat, team: rc.team, key: act.key, level: act.level,
        },
      }, rc.peerId);
    } else if (act.type === 'build_remove') {
      const p = new Vector3(...act.pos);
      const found = blocks.findByPos(p, 0.35);
      if (!found || found.team !== rc.team || !blocks.removeByPos(p, 0.35)) return;
      rc.blocksInv[found.material] += found.cost;
      rc.dirtySync = true;
      transport.broadcast({ kind: 'event', data: { type: 'block:break', pos: act.pos } }, rc.peerId);
    } else if (act.type === 'buy') {
      if (!match.nearShop(rc.sim.state.pos)) { rc.dirtySync = true; return; }
      const item = SHOP.find((s) => s.id === act.itemId);
      if (!item) return;
      const res = rc.eco.buy(item);
      if (res === 'ok') {
        rc.pendingNotice = { text: `Куплено: ${item.label}`, color: '#9dff9e' };
        rc.pendingSound = 'coins';
      } else {
        rc.pendingNotice = { text: res === 'money' ? 'Недостаточно средств' : 'Нельзя купить больше', color: '#ffb49e' };
        rc.pendingSound = 'reject';
      }
      rc.dirtySync = true;
    } else if (act.type === 'sell') {
      if (!match.nearShop(rc.sim.state.pos)) { rc.dirtySync = true; return; }
      const got = act.kind === 'all' ? rc.eco.sellAll() : rc.eco.sell(act.kind as ItemId);
      if (got > 0) {
        rc.pendingNotice = { text: `+${got}$`, color: '#ffd966' };
        rc.pendingSound = 'coins';
      }
      rc.dirtySync = true;
    } else if (act.type === 'interact') {
      this.handleClientInteract(rc, act, pickups);
    }
  }

  private handleClientInteract(
    rc: RemoteClientSim,
    act: Extract<ClientAction, { type: 'interact' }>,
    pickups: Pickups,
  ) {
    if (act.target === 'pickup') {
      const p = (act.targetId !== undefined ? pickups.items.find((it) => it.id === act.targetId && it.alive) : null)
        ?? pickups.nearest(rc.sim.state.pos);
      if (!p || !p.alive || p.pos.distanceTo(rc.sim.state.pos) > 4.5) return;
      const { kind, amount } = p;
      pickups.take(p);
      this.applyPickupReward(rc, kind, amount);
    } else if (act.target === 'pickup_front') {
      const up = upOf(rc.sim.state.frame);
      const pos = act.pos ? new Vector3(...act.pos) : rc.sim.state.pos;
      if (pos.distanceTo(rc.sim.state.pos) > 3) return;
      const fwd = act.dir
        ? new Vector3(...act.dir).normalize()
        : new Vector3(-Math.sin(rc.yaw), 0, -Math.cos(rc.yaw)).applyQuaternion(rc.sim.state.frame);
      const list = pickups.inFrontRadius(pos, fwd, up, 1.5);
      for (const p of list) {
        if (!p.alive) continue;
        const { kind, amount } = p;
        pickups.take(p);
        this.applyPickupReward(rc, kind, amount);
      }
    } else if (act.target === 'consume_apple') {
      if (rc.eco.take('apple')) {
        rc.target.hp = Math.min(MAX_HP, rc.target.hp + 35);
        rc.pendingNotice = { text: '+35 HP', color: '#9dff9e' };
        rc.pendingSound = 'eat';
        rc.dirtySync = true;
      }
    } else if (act.target === 'consume_medkit') {
      if (rc.eco.take('medkit')) {
        rc.target.hp = MAX_HP;
        rc.pendingNotice = { text: 'Здоровье восстановлено', color: '#9dff9e' };
        rc.pendingSound = 'patch';
        rc.dirtySync = true;
      }
    } else if (act.target === 'fish_catch') {
      const roll = Math.random();
      if (roll < 0.45) {
        rc.eco.items.fish++;
        rc.pendingNotice = { text: 'Поймана рыба!', color: '#7ce8ff' };
        rc.pendingSound = 'pickup';
      } else if (roll < 0.7) {
        rc.eco.items.apple++;
        rc.pendingNotice = { text: 'Выловлено: яблоко', color: '#9dff9e' };
        rc.pendingSound = 'pickup';
      } else if (roll < 0.85) {
        rc.eco.items.bottle++;
        rc.pendingNotice = { text: 'Выловлена бутылка', color: '#9dff9e' };
        rc.pendingSound = 'pickup';
      } else {
        rc.wallet.cash += 3;
        rc.pendingNotice = { text: 'Кошелёк: +3$', color: '#ffd966' };
        rc.pendingSound = 'coins';
      }
      rc.dirtySync = true;
    }
  }

  private applyPickupReward(rc: RemoteClientSim, kind: PickupKind, amount: number) {
    if (kind === 'cash') {
      rc.wallet.cash += amount;
      rc.pendingSound = 'coins';
    } else if (kind === 'ammo') {
      refillAmmo(rc.weapons, amount);
      rc.pendingSound = 'pickup';
    } else if (kind === 'wood' || kind === 'stone' || kind === 'metal') {
      rc.blocksInv[kind] += amount;
      rc.pendingSound = 'pickup';
    } else {
      rc.eco.items[kind] = (rc.eco.items[kind] ?? 0) + Math.max(1, amount);
      rc.pendingSound = 'pickup';
    }
    rc.dirtySync = true;
  }

  /** Forward an authoritative CombatEvent from Host to connected peers. */
  onHostCombatEvent(e: CombatEvent) {
    if (!this.isHost) return;
    const { combat, match, transport } = this.deps;
    if (e.type === 'explode') {
      transport.broadcast({
        kind: 'event',
        data: { type: 'combat:explode', pos: [e.pos.x, e.pos.y, e.pos.z], radius: e.radius },
      });
      return;
    }
    if (e.type === 'hit') {
      const victimId = this.ownerIdForTarget(e.target);
      const attackerId = this.ownerIdForTarget(e.owner);
      const vt = combat.target(e.target);
      const victimTeam = this.playerTeam(victimId);
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'combat:hit',
          victimId,
          attackerId,
          damage: e.damage,
          isHead: e.head,
          killed: e.killed,
          weapon: e.weapon,
          cause: e.cause,
          victimTeam,
          isNpc: !!vt?.npc,
          pos: [e.pos.x, e.pos.y, e.pos.z],
        },
      });
      if (e.killed) {
        const final = e.target === 0
          ? !match.bed(this.hostTeam).alive
          : e.target >= 2000
          ? !match.bed(this.targetToClient.get(e.target)?.team ?? this.hostTeam).alive
          : false;
        const killerTarget = e.owner !== e.target ? combat.target(e.owner) : undefined;
        const killerId = killerTarget ? attackerId : '';
        const killerTeam = this.playerTeam(killerId);
        const dist = killerTarget ? Math.round(killerTarget.center.distanceTo(e.pos)) : 0;
        transport.broadcast({
          kind: 'event',
          data: {
            type: 'combat:kill',
            victimId,
            attackerId: killerId,
            weapon: e.weapon ?? '',
            dist,
            isHead: e.head,
            cause: e.cause,
            final,
            attackerTeam: killerTeam,
            victimTeam,
          },
        });
        const rc = this.targetToClient.get(e.target);
        if (rc) {
          this.handleRemoteClientDeath(
            rc,
            killerTarget ? 'killed' : e.cause === 'fall' ? 'fall' : 'self',
            killerId || undefined,
            e.weapon,
            e.head,
            final,
          );
        }
      }
    }
  }

  /** Forward an authoritative MatchEvent (crystal hit / stage blast / broken) from Host to clients. */
  onHostMatchEvent(e: MatchEvent) {
    if (!this.isHost) return;
    if (e.type === 'bedHit') {
      this.deps.transport.broadcast({
        kind: 'event',
        data: { type: 'match:event', kind: 'bed_hit', team: e.team, hp: e.hp },
      });
    } else if (e.type === 'bedStage1Broken') {
      this.deps.transport.broadcast({
        kind: 'event',
        data: { type: 'match:event', kind: 'bed_stage1', team: e.team, byId: e.byPlayer ? this.myId : undefined },
      });
    } else if (e.type === 'bedStageBlast') {
      this.deps.transport.broadcast({
        kind: 'event',
        data: { type: 'match:event', kind: 'bed_blast', team: e.team, blastPos: [e.pos.x, e.pos.y, e.pos.z] },
      });
    } else if (e.type === 'bedBroken') {
      this.deps.transport.broadcast({
        kind: 'event',
        data: { type: 'match:event', kind: 'bed_broken', team: e.team, byId: e.byPlayer ? this.myId : undefined },
      });
    }
  }

  private handleRemoteClientDeath(
    rc: RemoteClientSim,
    cause: 'killed' | 'fall' | 'self' | 'void',
    killerId?: string,
    weapon?: string,
    head?: boolean,
    final = false,
  ) {
    rc.target.alive = false;
    rc.sim.releaseHook();
    rc.reloadT = 0;
    rc.reloadW = null;
    rc.respawnT = final ? 0 : DEATH_TIME;
    rc.out = final;
    rc.deathInfo = { cause, killerId, weapon, head, final };
    const dropPos = rc.sim.state.pos.clone();
    const dropUp = upOf(rc.sim.state.frame).clone();
    const lost = rc.eco.spill();
    for (const p of lost) this.deps.pickups.drop(p.kind, dropPos, dropUp, p.amount);
    rc.dirtySync = true;
  }

  private reviveRemoteClient(rc: RemoteClientSim) {
    rc.out = false;
    rc.deathInfo = undefined;
    rc.target.alive = true;
    rc.target.hp = MAX_HP;
    rc.sim.respawn('manual');
    rc.sim.events.length = 0;
    rc.target.guard = { t: SPAWN_GUARD.time, from: rc.sim.state.pos.clone() };
    rc.dirtySync = true;
  }

  private finishRemoteReload(rc: RemoteClientSim) {
    const w = rc.reloadW;
    if (!w) return;
    const spec = WEAPONS[w];
    const need = spec.mag - rc.weapons.ammo[w];
    const give = Math.min(need, rc.weapons.reserve[w]);
    rc.weapons.ammo[w] += give;
    rc.weapons.reserve[w] -= give;
    rc.reloadW = null;
    rc.reloadT = 0;
    rc.dirtySync = true;
  }

  /** Step all remote client sims on the Host (called at fixed 64Hz rate from local.onTick). */
  tickHostClients(dt: number) {
    if (!this.isHost) return;
    const { combat, match, player, transport } = this.deps;
    if (!player.me.alive && !match.bed(this.hostTeam).alive) this.hostOut = true;
    else if (player.me.alive) this.hostOut = false;

    for (const rc of this.remoteClients.values()) {
      if (rc.disconnected) continue;
      if (!rc.out && !rc.target.alive) {
        rc.respawnT -= dt;
        if (rc.respawnT <= 0) {
          if (match.bed(rc.team).alive) this.reviveRemoteClient(rc);
          else rc.out = true;
        }
      }
      if (rc.target.alive) {
        rc.sim.tick(rc.input, dt);
        for (const ev of rc.sim.events.splice(0)) {
          if (ev.type === 'land') combat.fall(rc.target, ev.speed);
          else if (ev.type === 'respawn' && ev.reason === 'void') {
            const final = !match.bed(rc.team).alive;
            this.handleRemoteClientDeath(rc, 'void', undefined, undefined, false, final);
            transport.broadcast({
              kind: 'event',
              data: {
                type: 'combat:kill',
                victimId: rc.peerId,
                attackerId: '',
                weapon: '',
                dist: 0,
                isHead: false,
                cause: 'void',
                final,
                victimTeam: rc.team,
              },
            });
          }
        }
        if (rc.reloadT > 0) {
          rc.reloadT -= dt;
          if (rc.reloadT <= 0) this.finishRemoteReload(rc);
        }
        upOf(rc.sim.state.frame, rc.target.up);
        rc.target.crouched = rc.input.crouch;
        const vUp = rc.sim.state.vel.dot(rc.target.up);
        const planar = Math.sqrt(Math.max(0, rc.sim.state.vel.lengthSq() - vUp * vUp));
        rc.target.quiet = rc.input.crouch || (!rc.input.sprint && planar < 4.5);

        const crystalCount = match.collect(rc.sim.state.pos);
        if (crystalCount > 0) {
          rc.wallet.crystal += crystalCount;
          rc.pendingNotice = { text: `+${crystalCount} крист.`, color: '#7ce8ff' };
          rc.pendingSound = 'pickup';
          rc.dirtySync = true;
        }
        const ownBed = match.bed(rc.team);
        if (ownBed.alive && rc.sim.state.pos.distanceToSquared(ownBed.pos) < 64 && refillAmmo(rc.weapons, 2)) {
          rc.dirtySync = true;
        }
      }
      if (rc.dirtySync) {
        rc.dirtySync = false;
        const di = rc.deathInfo;
        transport.sendTo(rc.peerId, {
          kind: 'event',
          data: {
            type: 'player:sync',
            cash: rc.wallet.cash,
            crystal: rc.wallet.crystal,
            items: { ...rc.eco.items },
            blocksInv: { ...rc.blocksInv },
            ownedWeapons: WEAPON_ORDER.filter((w) => rc.weapons.owned[w]),
            ammo: { ...rc.weapons.ammo },
            reserve: { ...rc.weapons.reserve },
            doneTools: [...rc.eco.done],
            activeWeapon: rc.weapons.current,
            reloadT: rc.reloadT,
            isFinalDeath: rc.out,
            deathCause: di?.cause,
            killerId: di?.killerId,
            killerWeapon: di?.weapon,
            deathHead: di?.head,
            notice: rc.pendingNotice?.text,
            noticeColor: rc.pendingNotice?.color,
            soundKind: rc.pendingSound,
          },
        });
        rc.pendingNotice = undefined;
        rc.pendingSound = undefined;
      }
    }
  }

  private resolveWinnerTeam(): TeamId | 'draw' | null {
    const { match, map } = this.deps;
    if (!match.result) return null;
    if (match.result === 'win') return match.team;
    const surviving = (map.teams as TeamId[]).filter((t) => !match.isOut(t));
    return surviving.length === 1 ? surviving[0] : 'draw';
  }

  private broadcastWorldSnapshot() {
    const { sim, player, match, bots, npcs, pickups, props, combat, transport, remotePlayers } = this.deps;
    this.snapTick++;

    const players: RemotePlayerSnapshot[] = [
      {
        id: this.myId,
        name: this.humansById.get(this.myId)?.name ?? 'Хост',
        team: this.hostTeam,
        pos: [sim.state.pos.x, sim.state.pos.y, sim.state.pos.z],
        vel: [sim.state.vel.x, sim.state.vel.y, sim.state.vel.z],
        frame: [sim.state.frame.x, sim.state.frame.y, sim.state.frame.z, sim.state.frame.w],
        yaw: sim.state.yaw,
        pitch: sim.state.pitch,
        hp: player.me.hp,
        maxHp: MAX_HP,
        alive: player.me.alive,
        onGround: sim.state.onGround,
        activeWeapon: player.weapons.current,
        crouching: sim.state.crouched,
        isFiring: false,
        guard: !!player.me.guard,
        stun: player.me.stun ?? 0,
        out: this.hostOut,
        hookPos: sim.hook ? [sim.hook.anchor.x, sim.hook.anchor.y, sim.hook.anchor.z] : null,
        hookPhase: sim.hook?.phase,
      },
    ];

    for (const rc of this.remoteClients.values()) {
      if (rc.disconnected) continue;
      players.push({
        id: rc.peerId,
        name: rc.name,
        team: rc.team,
        pos: [rc.sim.state.pos.x, rc.sim.state.pos.y, rc.sim.state.pos.z],
        vel: [rc.sim.state.vel.x, rc.sim.state.vel.y, rc.sim.state.vel.z],
        frame: [rc.sim.state.frame.x, rc.sim.state.frame.y, rc.sim.state.frame.z, rc.sim.state.frame.w],
        yaw: rc.yaw,
        pitch: rc.pitch,
        hp: rc.target.hp,
        maxHp: MAX_HP,
        alive: rc.target.alive,
        onGround: rc.sim.state.onGround,
        activeWeapon: rc.weapons.current,
        crouching: rc.sim.state.crouched,
        isFiring: rc.firing,
        guard: !!rc.target.guard,
        stun: rc.target.stun ?? 0,
        out: rc.out,
        ackSeq: rc.lastSeq,
        hookPos: rc.sim.hook ? [rc.sim.hook.anchor.x, rc.sim.hook.anchor.y, rc.sim.hook.anchor.z] : null,
        hookPhase: rc.sim.hook?.phase,
      });
      rc.firing = false;
    }

    const crystals = {} as Record<TeamId, CrystalSnapshot>;
    for (const b of match.beds) {
      crystals[b.team] = {
        team: b.team,
        stage: b.stage,
        hp: b.hp,
        maxHp: BED_HP,
        invulnerable: b.invulnT > 0,
        invulnT: b.invulnT,
        broken: !b.alive,
      };
    }

    const dirtyProps = props.consumeNetDirty();
    const includePickups = pickups.version !== this.lastPickupsVersion || this.snapTick % PICKUP_RESYNC_TICKS === 0;
    if (includePickups) this.lastPickupsVersion = pickups.version;

    const snap: WorldSnapshot = {
      tick: this.snapTick,
      serverTime: performance.now(),
      matchTime: match.time,
      windTime: combat.time,
      winnerTeam: this.resolveWinnerTeam(),
      generators: match.generators.map((g) => g.stored),
      players,
      crystals,
      bots: bots.bots.map((b) => ({
        id: b.id,
        team: b.team,
        pos: [b.sim.state.pos.x, b.sim.state.pos.y, b.sim.state.pos.z],
        vel: [b.sim.state.vel.x, b.sim.state.vel.y, b.sim.state.vel.z],
        frame: [b.sim.state.frame.x, b.sim.state.frame.y, b.sim.state.frame.z, b.sim.state.frame.w],
        yaw: b.sim.state.yaw,
        pitch: b.sim.state.pitch,
        hp: b.target.hp,
        alive: b.target.alive,
        out: b.out,
        onGround: b.sim.state.onGround,
        weapon: b.weapons.current,
        shotsTotal: b.shotsTotal,
        kicksTotal: b.kicksTotal,
        fishing: b.fishing,
        status: b.status,
        guard: !!b.target.guard,
        stun: b.target.stun ?? 0,
      })),
      npcs: npcs.npcs.map((n) => ({
        id: n.id,
        kind: n.kind,
        alive: n.target.alive,
        hp: n.target.hp,
        pos: [n.sim.state.pos.x, n.sim.state.pos.y, n.sim.state.pos.z],
        vel: [n.sim.state.vel.x, n.sim.state.vel.y, n.sim.state.vel.z],
        frame: [n.sim.state.frame.x, n.sim.state.frame.y, n.sim.state.frame.z, n.sim.state.frame.w],
        yaw: n.sim.state.yaw,
        state: n.state,
        fire: n.fire !== 'free',
        stun: n.target.stun ?? 0,
        weapon: n.weapons.current,
        shotsTotal: n.shotsTotal,
        throwsTotal: n.throwsTotal,
      })),
      cars: npcs.cars.map((c) => ({
        id: c.id,
        alive: c.target.alive,
        hp: c.target.hp,
        pos: [c.pos.x, c.pos.y, c.pos.z],
        vel: [c.vel.x, c.vel.y, c.vel.z],
        quat: [c.quat.x, c.quat.y, c.quat.z, c.quat.w],
        up: [c.up.x, c.up.y, c.up.z],
        yaw: c.yaw,
        scale: c.scale,
        color: c.color,
        state: c.state,
        crashT: c.crashT,
      })),
      props: dirtyProps.length ? dirtyProps : undefined,
      pickupsVersion: pickups.version,
      pickups: includePickups
        ? pickups.items.filter((p) => p.alive).map((p) => ({
          id: p.id, kind: p.kind, amount: p.amount, once: p.once,
          pos: [p.pos.x, p.pos.y, p.pos.z], up: [p.up.x, p.up.y, p.up.z], alive: p.alive,
        }))
        : undefined,
    };

    remotePlayers.applySnapshot(players.filter((p) => p.id !== this.myId), this.myId);
    transport.broadcast({ kind: 'snapshot', data: snap });
  }

  // --- CLIENT SETUP & RECONCILIATION -------------------------------------------------------------

  private setupClient() {
    const {
      transport, lobby, combat, match, player, hands, pockets, build, ui,
    } = this.deps;

    combat.visualOnly = true;
    match.remoteClientMode = true;
    player.remoteAuthoritative = true;
    hands.remoteAuthoritative = true;
    pockets.remoteAuthoritative = true;

    match.otherHumansAlive = (team) => {
      if (this.latestSnapshot) {
        return this.latestSnapshot.players.filter((p) => p.id !== this.myId && p.team === team && !p.out).length;
      }
      return lobbyHumans(lobby, this.hostId).filter((h) => h.id !== this.myId && h.team === team).length;
    };

    const sendAct = (act: ClientAction) => transport.sendToHost({ kind: 'action', data: act });

    player.onFire = (weapon, origin, dir, chargeT) => {
      sendAct({ type: 'fire', weapon, origin: [origin.x, origin.y, origin.z], dir: [dir.x, dir.y, dir.z], chargeT });
    };
    player.onReload = () => sendAct({ type: 'reload' });
    player.onSelectWeapon = (weapon) => sendAct({ type: 'select_slot', slot: 0, weapon });
    player.onKick = (eye, dir) => sendAct({ type: 'kick', eye: [eye.x, eye.y, eye.z], dir: [dir.x, dir.y, dir.z] });

    hands.onThrow = (kind, origin, dir) => {
      sendAct({ type: 'throw', kind, origin: [origin.x, origin.y, origin.z], dir: [dir.x, dir.y, dir.z] });
    };
    const prevOnHook = hands.onHook;
    hands.onHook = (thrown, eye, dir) => {
      prevOnHook(thrown, eye, dir);
      if (!thrown || !eye || !dir) sendAct({ type: 'hook', release: true, eye: [0, 0, 0], dir: [0, 0, 0] });
      else sendAct({ type: 'hook', release: false, eye: [eye.x, eye.y, eye.z], dir: [dir.x, dir.y, dir.z] });
    };

    build.onBlockPlaced = (b) => {
      sendAct({
        type: 'build_place',
        kind: b.kind,
        center: [b.center.x, b.center.y, b.center.z],
        half: [b.half.x, b.half.y, b.half.z],
        quat: [b.quat.x, b.quat.y, b.quat.z, b.quat.w],
        material: b.material,
        team: b.team ?? match.team,
        key: b.key ?? undefined,
        level: b.level,
      });
    };
    build.onBlockReclaimed = (b) => {
      sendAct({ type: 'build_remove', pos: [b.center.x, b.center.y, b.center.z] });
    };

    ui.onRemoteBuy = (itemId) => sendAct({ type: 'buy', itemId });
    ui.onRemoteSell = (kind) => sendAct({ type: 'sell', kind });

    pockets.onInteractPickup = (pickupId) => sendAct({ type: 'interact', target: 'pickup', targetId: pickupId });
    pockets.onPickupFront = (pos, dir) => sendAct({
      type: 'interact', target: 'pickup_front', pos: [pos.x, pos.y, pos.z], dir: [dir.x, dir.y, dir.z],
    });
    pockets.onConsume = (itemId) => sendAct({
      type: 'interact', target: itemId === 'apple' ? 'consume_apple' : 'consume_medkit',
    });
    pockets.onFishCatch = () => sendAct({ type: 'interact', target: 'fish_catch' });

    transport.events.onPeerLeave = (peerId) => {
      if (peerId === this.hostId && !this.clientHostDisconnected) {
        this.clientHostDisconnected = true;
        this.deps.onHostDisconnect?.();
      }
    };

    transport.events.onMessage = (_peerId, packet: NetPacket) => {
      if (packet.kind === 'snapshot') {
        this.handleClientSnapshot(packet.data);
      } else if (packet.kind === 'event') {
        this.handleClientEvent(packet.data);
      }
    };
  }

  /** Capture predicted local movement state & stream input packets at 64Hz on non-host client. */
  onLocalTick() {
    if (this.isHost) return;
    const { sim, local, player, hands, transport } = this.deps;
    const seq = ++this.localSeq;
    this.predictedHistory.push({
      seq,
      pos: sim.state.pos.clone(),
      vel: sim.state.vel.clone(),
      frame: sim.state.frame.clone(),
    });
    if (this.predictedHistory.length > HISTORY_LIMIT) this.predictedHistory.shift();

    transport.sendToHost({
      kind: 'input',
      data: {
        seq,
        tick: seq,
        forward: local.input.forward,
        right: local.input.right,
        up: local.input.up,
        jump: local.input.jump,
        sprint: local.input.sprint,
        crouch: local.input.crouch,
        yaw: local.input.yaw,
        pitch: local.input.pitch,
        slot: hands.tool ? -1 : WEAPON_ORDER.indexOf(player.weapons.current),
        weapon: hands.tool ? undefined : player.weapons.current,
      },
    });
  }

  private ensureClientProxyTarget(snap: RemotePlayerSnapshot): Target {
    let t = this.remoteProxyTargets.get(snap.id);
    if (!t) {
      const id = this.nextClientTargetId++;
      t = {
        id,
        team: snap.team,
        center: new Vector3(...snap.pos),
        up: upOf(new Quaternion(...snap.frame)),
        vel: new Vector3(...snap.vel),
        hp: snap.hp,
        alive: snap.alive,
        respawnIn: -1,
        isHuman: true,
        crouched: snap.crouching,
      };
      this.remoteProxyTargets.set(snap.id, t);
      this.deps.combat.targets.push(t);
    }
    t.team = snap.team;
    t.center.set(...snap.pos);
    t.vel?.set(...snap.vel);
    upOf(_tmpQ.set(...snap.frame), t.up);
    t.hp = snap.hp;
    t.alive = snap.alive;
    t.crouched = snap.crouching;
    return t;
  }

  private handleClientSnapshot(snap: WorldSnapshot) {
    this.latestSnapshot = snap;
    const { match, combat, pickups, props, mapView, remotePlayers, bots, npcs } = this.deps;
    if (snap.matchTime !== undefined) match.time = snap.matchTime;
    if (snap.windTime !== undefined) combat.time = snap.windTime;

    for (const cs of Object.values(snap.crystals)) {
      const b = match.bed(cs.team);
      const wasAlive = b.alive;
      b.hp = cs.hp;
      b.alive = !cs.broken;
      b.stage = cs.stage === 2 ? 2 : 1;
      b.invulnT = cs.invulnT ?? 0;
      mapView.setBedStage(b.team, b.stage, b.invulnT);
      if (wasAlive && !b.alive) mapView.setBedAlive(b.team, false);
    }

    if (snap.generators) {
      for (let i = 0; i < snap.generators.length && i < match.generators.length; i++) {
        match.generators[i].stored = snap.generators[i];
      }
    }

    if (snap.pickups) {
      pickups.applySync(snap.pickups);
    }
    if (snap.props?.length) props.applySync(snap.props);

    if (snap.winnerTeam && !match.result) {
      const won = snap.winnerTeam === match.team;
      match.result = won ? 'win' : 'lose';
      match.events.push(won ? { type: 'win', time: match.time } : { type: 'lose' });
    }

    if (snap.bots) {
      for (const bs of snap.bots) {
        this.botTargets.set(bs.id, bs);
        const b = bots.bots.find((it) => it.id === bs.id);
        if (b) {
          b.out = bs.out;
          b.fishing = bs.fishing;
          b.status = bs.status;
          b.target.hp = bs.hp;
          b.target.alive = bs.alive;
          b.weapons.current = bs.weapon as WeaponId;
          b.shotsTotal = bs.shotsTotal;
          b.kicksTotal = bs.kicksTotal;
          b.target.guard = bs.guard ? { t: 1, from: b.sim.state.pos } : undefined;
        }
      }
    }
    if (snap.npcs) {
      for (const ns of snap.npcs) {
        this.npcTargets.set(ns.id, ns);
        const n = npcs.npcs.find((it) => it.id === ns.id);
        if (n) {
          n.state = ns.state as NpcState;
          n.target.hp = ns.hp;
          n.target.alive = ns.alive;
          if (ns.shotsTotal !== undefined) n.shotsTotal = ns.shotsTotal;
          if (ns.throwsTotal !== undefined) n.throwsTotal = ns.throwsTotal;
        }
      }
    }
    if (snap.cars) {
      for (const cs of snap.cars) {
        this.carTargets.set(cs.id, cs);
        const c = npcs.cars.find((it) => it.id === cs.id);
        if (c) {
          c.state = cs.state as 'drive' | 'crashing' | 'dead';
          c.target.alive = cs.alive;
          if (cs.hp !== undefined) c.target.hp = cs.hp;
        }
      }
    }

    const others: RemotePlayerSnapshot[] = [];
    for (const ps of snap.players) {
      if (ps.id === this.myId) {
        this.reconcileLocalPlayer(ps);
      } else {
        others.push(ps);
        this.ensureClientProxyTarget(ps);
      }
    }
    remotePlayers.applySnapshot(others, this.myId);
  }

  private reconcileLocalPlayer(ps: RemotePlayerSnapshot) {
    const { sim, local, player, match, hud } = this.deps;
    player.me.hp = ps.hp;
    hud.setHp(ps.hp);
    player.me.guard = ps.guard ? { t: SPAWN_GUARD.time, from: sim.state.pos } : undefined;
    player.me.stun = ps.stun ? ps.stun : undefined;

    if (ps.out && !this.clientOut) {
      this.clientOut = true;
      player.die('killed', undefined, undefined, false, true);
      return;
    }
    if (!ps.alive && player.me.alive) {
      player.die('killed', undefined, undefined, false, !match.bed(match.team).alive);
      return;
    }
    if (ps.alive && !player.me.alive && !ps.out) {
      this.clientOut = false;
      player.reset();
      sim.state.pos.set(...ps.pos);
      sim.state.vel.set(...ps.vel);
      sim.state.frame.set(...ps.frame);
      sim.mover.place(sim.state);
      local.snap();
      this.predictedHistory.length = 0;
      return;
    }
    if (!ps.alive) return;

    let refPos = sim.state.pos;
    if (ps.ackSeq) {
      while (this.predictedHistory.length && this.predictedHistory[0].seq < ps.ackSeq) {
        this.predictedHistory.shift();
      }
      if (this.predictedHistory.length && this.predictedHistory[0].seq === ps.ackSeq) {
        refPos = this.predictedHistory[0].pos;
      }
    }

    const serverPos = _tmpV.set(...ps.pos);
    const delta = _tmpV2.copy(serverPos).sub(refPos);
    const err = delta.length();
    if (err > 3.5) {
      sim.state.pos.copy(serverPos);
      sim.state.vel.set(...ps.vel);
      sim.state.frame.set(...ps.frame);
      sim.mover.place(sim.state);
      local.snap();
      this.predictedHistory.length = 0;
    } else if (err > 0.12) {
      const k = 0.25;
      sim.state.pos.addScaledVector(delta, k);
      local.prevPos.addScaledVector(delta, k);
      sim.mover.place(sim.state);
    }
  }

  private handleClientEvent(e: WorldEvent) {
    const {
      combat, blocks, props, throws, fx, audio, hud, stats, match, mapView, ui, player, eco, sim, map,
    } = this.deps;
    switch (e.type) {
      case 'combat:bullet': {
        const w = e.weapon as WeaponId;
        const o = new Vector3(...e.origin);
        const d = new Vector3(...e.dir);
        const faction = e.attackerTeam ?? this.entityFaction(e.ownerId);
        combat.use(w, -1, o, d, new Vector3(), sim.gravityDown(), e.chargeT ?? 0, faction);
        this.playRemoteGunAudio(w, o);
        if (!e.ownerId.startsWith('bot:') && !e.ownerId.startsWith('npc:')) {
          this.deps.remotePlayers.triggerFire(e.ownerId);
        }
        break;
      }
      case 'combat:kick': {
        if (!e.ownerId.startsWith('bot:')) this.deps.remotePlayers.triggerKick(e.ownerId);
        break;
      }
      case 'combat:throw': {
        const o = new Vector3(...e.origin);
        const d = new Vector3(...e.dir);
        throws.throw(e.itemKind as ItemId, -1, o, d, new Vector3(), sim.gravityDown());
        if (o.distanceTo(this.deps.camera.position) < 25) audio.toss();
        break;
      }
      case 'combat:explode': {
        const pos = new Vector3(...e.pos);
        combat.visualExplode(pos, e.radius);
        if (pos.distanceTo(this.deps.camera.position) < 55) audio.explosion();
        break;
      }
      case 'combat:hit': {
        if (e.attackerId === this.myId && e.victimId !== this.myId) {
          hud.hitmarker(e.isHead, !!e.killed);
        }
        if (e.victimId === this.myId) {
          hud.hurt(e.damage);
          if (e.cause === 'fall') audio.fallHurt();
        }
        break;
      }
      case 'combat:kill': {
        this.handleClientKillEvent(e);
        break;
      }
      case 'block:place': {
        const c = new Vector3(...e.center);
        if (!blocks.findByPos(c, 0.2)) {
          blocks.insertPiece(
            e.kind as BlockKind, c, new Vector3(...e.half), new Quaternion(...e.quat),
            e.material as BlockMaterial, e.team, e.key, e.level,
          );
          if (c.distanceTo(this.deps.camera.position) < 28) audio.place();
        }
        break;
      }
      case 'block:damage': {
        if (e.pos) blocks.syncDamageAtPos(new Vector3(...e.pos), e.hp, 0.25);
        break;
      }
      case 'block:break': {
        const pos = new Vector3(...e.pos);
        if (blocks.removeByPos(pos, 0.25) && pos.distanceTo(this.deps.camera.position) < 28) audio.remove();
        break;
      }
      case 'prop:break': {
        if (props.present(e.idx)) {
          const p = props.pos(e.idx);
          const k = map.crates[e.idx]?.kind ?? 'crate';
          fx.crateBreak(p, k);
          audio.blockBreak(k === 'crate' ? 'wood' : 'metal', p.distanceTo(this.deps.camera.position));
          props.applySync([{ idx: e.idx, pos: [p.x, p.y, p.z], quat: [0, 0, 0, 1], hp: 0, present: false }]);
        }
        break;
      }
      case 'match:event': {
        if (e.kind === 'bed_hit') {
          const bed = match.bed(e.team);
          if (e.hp !== undefined) bed.hp = e.hp;
          ui.onEvent({ type: 'bedHit', team: e.team, hp: e.hp ?? bed.hp, byPlayer: false });
        } else if (e.kind === 'bed_stage1') {
          const bed = match.bed(e.team);
          bed.stage = 2;
          bed.invulnT = CRYSTAL_INVULN_TIME;
          mapView.setBedStage(e.team, 2, CRYSTAL_INVULN_TIME);
          ui.onEvent({ type: 'bedStage1Broken', team: e.team, byPlayer: e.byId === this.myId });
        } else if (e.kind === 'bed_blast') {
          const bed = match.bed(e.team);
          fx.handle({ type: 'explode', pos: bed.pos.clone(), radius: 10 });
          audio.crystalBlast(bed.pos.distanceTo(this.deps.camera.position));
          ui.onEvent({ type: 'bedStageBlast', team: e.team, pos: bed.pos });
        } else if (e.kind === 'bed_broken') {
          const bed = match.bed(e.team);
          bed.alive = false;
          bed.hp = 0;
          mapView.setBedAlive(e.team, false);
          fx.handle({ type: 'explode', pos: bed.pos.clone(), radius: 3 });
          audio.explosion();
          if (e.byId === this.myId) stats.crystals++;
          ui.onEvent({ type: 'bedBroken', team: e.team, byPlayer: e.byId === this.myId });
        }
        break;
      }
      case 'player:sync': {
        match.wallet.cash = e.cash;
        match.wallet.crystal = e.crystal;
        for (const [k, v] of Object.entries(e.items)) eco.items[k as ItemId] = v ?? 0;
        for (const [k, v] of Object.entries(e.blocksInv)) blocks.inventory[k as BlockMaterial] = v ?? 0;
        if (e.doneTools) {
          eco.done.clear();
          for (const d of e.doneTools) eco.done.add(d as Step);
        }
        for (const w of WEAPON_ORDER) player.weapons.owned[w] = e.ownedWeapons.includes(w);
        for (const [k, v] of Object.entries(e.reserve)) player.weapons.reserve[k as WeaponId] = v ?? 0;
        for (const [k, v] of Object.entries(e.ammo)) {
          const w = k as WeaponId;
          const serverAmmo = v ?? 0;
          if (Math.abs(player.weapons.ammo[w] - serverAmmo) > 2 || serverAmmo > player.weapons.ammo[w] || serverAmmo === 0) {
            player.weapons.ammo[w] = serverAmmo;
          }
        }
        if (e.notice) hud.toast(e.notice, e.noticeColor ?? '#9dff9e', 1.4);
        if (e.soundKind === 'pickup') audio.pickup();
        else if (e.soundKind === 'coins') audio.coins();
        else if (e.soundKind === 'reject') audio.reject();
        else if (e.soundKind === 'eat') audio.eat();
        else if (e.soundKind === 'patch') audio.patch();
        if (e.isFinalDeath && player.me.alive) {
          this.clientOut = true;
          const kt = e.killerId ? this.remoteProxyTargets.get(e.killerId) : undefined;
          player.die((e.deathCause as 'killed' | 'fall' | 'self' | 'void') ?? 'killed', kt, e.killerWeapon as WeaponId, e.deathHead, true);
        }
        break;
      }
    }
  }

  private handleClientKillEvent(e: Extract<WorldEvent, { type: 'combat:kill' }>) {
    const { hud, player, stats } = this.deps;
    const victimTeam = e.victimTeam ?? this.playerTeam(e.victimId);
    const killerTeam = e.attackerTeam ?? this.playerTeam(e.attackerId);
    const vSpan = victimTeam ? this.teamBadge(victimTeam, e.victimId === this.myId ? 'Ты' : this.playerLabel(e.victimId)) : escapeHtml(this.playerLabel(e.victimId));
    const kSpan = killerTeam ? this.teamBadge(killerTeam, e.attackerId === this.myId ? 'Ты' : this.playerLabel(e.attackerId)) : escapeHtml(this.playerLabel(e.attackerId));
    if (e.cause === 'quit') {
      hud.killfeed(`${vSpan} вышел`);
      return;
    }
    if (e.cause === 'void') hud.killfeed(`${vSpan} улетел в бездну`);
    else if (!e.attackerId || e.attackerId === e.victimId) hud.killfeed(`${vSpan} погиб`);
    else hud.killfeed(`${kSpan}${killIcon(e.weapon ? (e.weapon as any) : undefined)}${vSpan}`);

    if (e.attackerId === this.myId && victimTeam && victimTeam !== this.deps.match.team) {
      const vt = this.remoteProxyTargets.get(e.victimId) ?? player.me;
      stats.frag(player.me, vt, e.isHead);
    }
    if (e.victimId === this.myId) {
      if (e.final) this.clientOut = true;
      const kt = e.attackerId ? this.remoteProxyTargets.get(e.attackerId) : undefined;
      player.die(e.cause === 'fall' ? 'fall' : e.cause === 'void' ? 'void' : e.attackerId ? 'killed' : 'self', kt, (e.weapon || undefined) as any, e.isHead, e.final);
    }
  }

  // --- PER-FRAME INTERPOLATION & SNAPSHOT CADENCE ------------------------------------------------

  updateFrame(dt: number, _time: number) {
    const { R, world, combat, camera, match, remotePlayers, bots, npcs } = this.deps;

    if (this.isHost) {
      this.snapAccum += dt;
      if (this.snapAccum >= SNAPSHOT_INTERVAL) {
        this.snapAccum = Math.min(this.snapAccum - SNAPSHOT_INTERVAL, SNAPSHOT_INTERVAL);
        this.broadcastWorldSnapshot();
      }
    } else {
      this.interpolateEntities(dt, bots, npcs);
    }

    remotePlayers.update(dt, camera, match.team, (pos) => hasLineOfSight(R, world, camera.position, pos, combat.notCharacter));
  }

  private interpolateEntities(dt: number, bots: BotManager, npcs: NpcManager) {
    const k = Math.min(1, dt * 18);

    for (const b of bots.bots) {
      const target = this.botTargets.get(b.id);
      if (!target) continue;
      const s = b.sim.state;
      if (!target.alive || target.out) {
        s.pos.set(0, -5000 - b.id * 5, 0);
        b.prevPos.copy(s.pos);
        b.sim.mover.place(s);
        continue;
      }
      _tmpV.set(...target.pos);
      if (s.pos.distanceToSquared(_tmpV) > 25) s.pos.copy(_tmpV);
      else s.pos.lerp(_tmpV, k);
      b.prevPos.copy(s.pos);
      s.vel.set(...target.vel);
      s.frame.set(...target.frame);
      s.yaw = target.yaw;
      b.sim.mover.place(s);
    }

    for (const n of npcs.npcs) {
      const target = this.npcTargets.get(n.id);
      if (!target) continue;
      const s = n.sim.state;
      if (!target.alive || target.state === 'dead') {
        s.pos.set(0, -5500 - n.id * 5, 0);
        n.prevPos.copy(s.pos);
        n.sim.mover.place(s);
        continue;
      }
      _tmpV.set(...target.pos);
      if (s.pos.distanceToSquared(_tmpV) > 25) s.pos.copy(_tmpV);
      else s.pos.lerp(_tmpV, k);
      n.prevPos.copy(s.pos);
      s.vel.set(...target.vel);
      s.frame.set(...target.frame);
      s.yaw = target.yaw;
      n.sim.mover.place(s);
    }

    for (const c of npcs.cars) {
      const target = this.carTargets.get(c.id);
      if (!target) continue;
      if (!target.alive || target.state === 'dead') {
        c.pos.set(0, -6500 - c.id * 5, 0);
        c.prevPos.copy(c.pos);
        continue;
      }
      _tmpV.set(...target.pos);
      if (c.pos.distanceToSquared(_tmpV) > 36) c.pos.copy(_tmpV);
      else c.pos.lerp(_tmpV, k);
      c.prevPos.copy(c.pos);
      if (target.vel) c.vel.set(...target.vel);
      if (target.quat) c.quat.set(...target.quat);
    }
  }
}
