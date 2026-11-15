import { Quaternion, Vector3 } from 'three';
import { BlockKind, BlockMaterial, BlockSystem } from '../../shared/blocks';
import type { BotManager } from '../../shared/bots';
import { Combat, CombatEvent, HitSource, MAX_HP, Target } from '../../shared/combat';
import { TICK_DT } from '../../shared/constants';
import type { ItemId } from '../../shared/economy';
import { LobbyConfig, playerTeam } from '../../shared/lobby';
import type { MapData } from '../../shared/map';
import { KILL_REWARD, Match } from '../../shared/match';
import { upOf } from '../../shared/math';
import { emptyInput, MoveInput } from '../../shared/movement';
import type {
  CrystalSnapshot,
  NetPacket,
  PlayerInputPacket,
  RemoteBotSnapshot,
  RemotePlayerSnapshot,
  WorldSnapshot,
} from '../../shared/net/protocol';
import type { PhysicsWorld, Rapier } from '../../shared/physics';
import { PlayerSim } from '../../shared/sim';
import type { TeamId } from '../../shared/teams';
import type { Throws } from '../../shared/throwables';
import { WEAPON_ORDER, WeaponId } from '../../shared/weapons';
import type { BlockController } from '../blockController';
import type { Hands } from '../hands';
import type { Hud } from '../hud';
import { icon } from '../icons';
import type { Input } from '../input';
import type { LocalPlayer } from '../localPlayer';
import { killIcon, PlayerCombat, teamSpan } from '../playerCombat';
import type { NetLobbyController } from './netLobby';
import type { P2PTransport } from './p2p';
import type { RemotePlayerManager } from './remotePlayerManager';

interface RemoteClientSim {
  id: string;
  team: TeamId;
  sim: PlayerSim;
  target: Target;
  input: MoveInput;
  yaw: number;
  pitch: number;
  activeWeapon: string;
  isFiring: boolean;
  respawnT: number;
}

export interface NetMatchDeps {
  isHost: boolean;
  myNetworkId: string;
  myTeam: TeamId;
  transport: P2PTransport;
  netLobby: NetLobbyController | null;
  lobbyConfig: LobbyConfig;
  R: Rapier;
  world: PhysicsWorld;
  map: MapData;
  sim: PlayerSim;
  combat: Combat;
  blocks: BlockSystem;
  match: Match;
  bots: BotManager;
  throws: Throws;
  player: PlayerCombat;
  hands: Hands;
  build: BlockController;
  hud: Hud;
  remotePlayers: RemotePlayerManager;
  input: Input;
  local: LocalPlayer;
}

/**
 * Coordinates in-match P2P synchronization between the authoritative host and connected clients.
 */
export class NetMatchController {
  private readonly remoteClients = new Map<string, RemoteClientSim>();
  private snapshotTimer = 0;
  private inputTimer = 0;

  constructor(private readonly deps: NetMatchDeps) {
    if (deps.isHost) {
      this.setupHost();
    } else {
      this.setupClient();
    }
  }

  private findClientByTargetId(targetId: number): RemoteClientSim | undefined {
    for (const rc of this.remoteClients.values()) {
      if (rc.target.id === targetId) return rc;
    }
    return undefined;
  }

  private peerIdOfTarget(targetId: number): string | undefined {
    if (targetId === 0) return this.deps.myNetworkId;
    return this.findClientByTargetId(targetId)?.id;
  }

  private setupHost() {
    const {
      transport, netLobby, lobbyConfig, R, world, map, combat, blocks, player, hands, build, remotePlayers, myNetworkId,
    } = this.deps;

    if (netLobby) {
      let nextNetTargetId = 1000;
      for (const p of netLobby.players) {
        if (p.id === myNetworkId) continue;
        const team = playerTeam(lobbyConfig, p.id) || p.team;
        const cSim = new PlayerSim(R, world, map, team);
        cSim.gravity.blocks = () => blocks.blocks.values();
        const target: Target = {
          id: nextNetTargetId++,
          team,
          center: cSim.state.pos,
          up: upOf(cSim.state.frame),
          hp: MAX_HP,
          alive: true,
          respawnIn: -1,
          regen: true,
          airborne: () => !cSim.state.onGround,
          onImpulse: (v) => {
            cSim.applyImpulse(v);
            transport.sendTo(p.id, {
              kind: 'event',
              data: { type: 'player:impulse', targetId: p.id, vec: [v.x, v.y, v.z] },
            });
          },
        };
        combat.targets.push(target);
        combat.guard(target);
        blocks.characters.push(cSim.mover.collider);
        this.remoteClients.set(p.id, {
          id: p.id,
          team,
          sim: cSim,
          target,
          input: emptyInput(),
          yaw: cSim.state.yaw,
          pitch: cSim.state.pitch,
          activeWeapon: 'fists',
          isFiring: false,
          respawnT: 0,
        });
      }
    }

    const prevOnFire = player.onFire;
    player.onFire = (weapon, origin, dir, chargeT) => {
      prevOnFire?.(weapon, origin, dir, chargeT);
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'combat:bullet',
          ownerId: myNetworkId,
          origin: [origin.x, origin.y, origin.z],
          dir: [dir.x, dir.y, dir.z],
          weapon,
          chargeT,
        },
      });
    };

    const prevOnKick = player.onKick;
    player.onKick = (eye, dir) => {
      prevOnKick?.(eye, dir);
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'combat:kick',
          ownerId: myNetworkId,
          eye: [eye.x, eye.y, eye.z],
          dir: [dir.x, dir.y, dir.z],
        },
      });
    };

    const prevOnThrow = hands.onThrow;
    hands.onThrow = (kind, origin, dir) => {
      prevOnThrow?.(kind, origin, dir);
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'combat:throw',
          ownerId: myNetworkId,
          itemKind: kind,
          origin: [origin.x, origin.y, origin.z],
          dir: [dir.x, dir.y, dir.z],
        },
      });
    };

    const prevOnCombatEvent = player.onCombatEvent;
    player.onCombatEvent = (e) => {
      prevOnCombatEvent?.(e);
      this.handleHostCombatEvent(e);
    };

    const prevOnBlockPlaced = build.onBlockPlaced;
    build.onBlockPlaced = (b) => {
      prevOnBlockPlaced?.(b);
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
        },
      });
    };

    const prevOnBlockReclaimed = build.onBlockReclaimed;
    build.onBlockReclaimed = (b) => {
      prevOnBlockReclaimed?.(b);
      transport.broadcast({
        kind: 'event',
        data: { type: 'block:break', pos: [b.center.x, b.center.y, b.center.z] },
      });
    };

    const prevOnBreak = blocks.onBreak;
    blocks.onBreak = (b) => {
      prevOnBreak?.(b);
      transport.broadcast({
        kind: 'event',
        data: { type: 'block:break', pos: [b.center.x, b.center.y, b.center.z] },
      });
    };

    transport.events.onPeerLeave = (peerId: string) => {
      const rc = this.remoteClients.get(peerId);
      if (!rc) return;
      const ti = combat.targets.indexOf(rc.target);
      if (ti >= 0) combat.targets.splice(ti, 1);
      const ci = blocks.characters.indexOf(rc.sim.mover.collider);
      if (ci >= 0) blocks.characters.splice(ci, 1);
      this.remoteClients.delete(peerId);
    };

    transport.events.onMessage = (peerId: string, packet: NetPacket) => {
      const rc = this.remoteClients.get(peerId);
      if (!rc) return;
      if (packet.kind === 'input') {
        const inp: PlayerInputPacket = packet.data;
        rc.input.forward = inp.forward;
        rc.input.right = inp.right;
        rc.input.up = inp.up;
        rc.input.jump = inp.jump;
        rc.input.sprint = inp.sprint;
        rc.input.crouch = inp.crouch;
        rc.input.yaw = inp.yaw;
        rc.input.pitch = inp.pitch;
        rc.yaw = inp.yaw;
        rc.pitch = inp.pitch;
        if (inp.weapon) rc.activeWeapon = inp.weapon;
      } else if (packet.kind === 'action') {
        const act = packet.data;
        if (act.type === 'fire') {
          const o = new Vector3(...act.origin);
          const d = new Vector3(...act.dir);
          combat.use(act.weapon as WeaponId, rc.target.id, o, d, rc.sim.state.vel, rc.sim.gravityDown(), act.chargeT);
          remotePlayers.triggerFire(peerId);
          transport.broadcast({
            kind: 'event',
            data: { type: 'combat:bullet', ownerId: peerId, origin: act.origin, dir: act.dir, weapon: act.weapon, chargeT: act.chargeT },
          }, peerId);
        } else if (act.type === 'kick') {
          const eye = new Vector3(...act.eye);
          const dir = new Vector3(...act.dir);
          combat.kick(rc.target.id, eye, dir, rc.target.up);
          remotePlayers.triggerKick(peerId);
          transport.broadcast({
            kind: 'event',
            data: { type: 'combat:kick', ownerId: peerId, eye: act.eye, dir: act.dir },
          }, peerId);
        } else if (act.type === 'hook') {
          if (act.release) {
            rc.sim.releaseHook();
          } else {
            rc.sim.throwHook(new Vector3(...act.eye), new Vector3(...act.dir), combat.notCharacter);
          }
        } else if (act.type === 'throw') {
          this.deps.throws.throw(
            act.kind as ItemId,
            rc.target.id,
            new Vector3(...act.origin),
            new Vector3(...act.dir),
            rc.sim.state.vel,
            rc.sim.gravityDown(),
          );
          transport.broadcast({
            kind: 'event',
            data: { type: 'combat:throw', ownerId: peerId, itemKind: act.kind, origin: act.origin, dir: act.dir },
          }, peerId);
        } else if (act.type === 'build_place') {
          blocks.insertPiece(
            act.kind as BlockKind,
            new Vector3(...act.center),
            new Vector3(...act.half),
            new Quaternion(...act.quat),
            act.material as BlockMaterial,
            act.team,
          );
          transport.broadcast({
            kind: 'event',
            data: {
              type: 'block:place',
              kind: act.kind,
              center: act.center,
              half: act.half,
              quat: act.quat,
              material: act.material,
              team: act.team,
            },
          }, peerId);
        } else if (act.type === 'build_remove') {
          const removed = blocks.removeByPos(new Vector3(...act.pos));
          if (removed) {
            transport.broadcast({
              kind: 'event',
              data: { type: 'block:break', pos: act.pos },
            }, peerId);
          }
        }
      }
    };
  }

  private handleHostCombatEvent(e: CombatEvent) {
    if (e.type !== 'hit') return;
    const { combat, transport } = this.deps;
    const victimTg = combat.target(e.target);
    const killerTg = combat.target(e.owner);
    const attackerPeerId = this.peerIdOfTarget(e.owner);
    const victimPeerId = this.peerIdOfTarget(e.target);

    if (e.owner !== 0 && attackerPeerId && e.target !== e.owner) {
      transport.sendTo(attackerPeerId, {
        kind: 'event',
        data: {
          type: 'combat:hit',
          victimId: victimPeerId ?? String(e.target),
          attackerId: attackerPeerId,
          damage: e.damage,
          isHead: e.head,
          killed: e.killed,
          weapon: e.weapon,
          victimTeam: victimTg && !victimTg.npc ? (victimTg.team as TeamId) : undefined,
          isNpc: !!victimTg?.npc,
        },
      });
    }

    if (e.killed && victimTg && !victimTg.npc && !killerTg?.npc) {
      const dist = killerTg ? Math.round(killerTg.center.distanceTo(victimTg.center)) : 0;
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'combat:kill',
          victimId: victimPeerId ?? String(e.target),
          attackerId: attackerPeerId ?? String(e.owner),
          weapon: e.weapon ?? 'fists',
          dist,
          isHead: e.head,
          attackerTeam: killerTg ? (killerTg.team as TeamId) : undefined,
          victimTeam: victimTg.team as TeamId,
        },
      });
    }
  }

  private setupClient() {
    const {
      transport, myNetworkId, myTeam, sim, combat, blocks, match, bots, throws, player, hands, build, hud, remotePlayers,
    } = this.deps;

    const prevOnFire = player.onFire;
    player.onFire = (weapon, origin, dir, chargeT) => {
      prevOnFire?.(weapon, origin, dir, chargeT);
      transport.sendToHost({
        kind: 'action',
        data: {
          type: 'fire',
          weapon,
          origin: [origin.x, origin.y, origin.z],
          dir: [dir.x, dir.y, dir.z],
          chargeT,
        },
      });
    };

    const prevOnKick = player.onKick;
    player.onKick = (eye, dir) => {
      prevOnKick?.(eye, dir);
      transport.sendToHost({
        kind: 'action',
        data: {
          type: 'kick',
          eye: [eye.x, eye.y, eye.z],
          dir: [dir.x, dir.y, dir.z],
        },
      });
    };

    const prevOnHook = hands.onHook;
    hands.onHook = (thrown, eye, dir) => {
      prevOnHook(thrown, eye, dir);
      if (thrown && eye && dir) {
        transport.sendToHost({
          kind: 'action',
          data: {
            type: 'hook',
            eye: [eye.x, eye.y, eye.z],
            dir: [dir.x, dir.y, dir.z],
          },
        });
      } else if (!thrown) {
        transport.sendToHost({
          kind: 'action',
          data: {
            type: 'hook',
            eye: [0, 0, 0],
            dir: [0, 0, -1],
            release: true,
          },
        });
      }
    };

    const prevOnThrow = hands.onThrow;
    hands.onThrow = (kind, origin, dir) => {
      prevOnThrow?.(kind, origin, dir);
      transport.sendToHost({
        kind: 'action',
        data: {
          type: 'throw',
          kind,
          origin: [origin.x, origin.y, origin.z],
          dir: [dir.x, dir.y, dir.z],
        },
      });
    };

    const prevOnBlockPlaced = build.onBlockPlaced;
    build.onBlockPlaced = (b) => {
      prevOnBlockPlaced?.(b);
      transport.sendToHost({
        kind: 'action',
        data: {
          type: 'build_place',
          kind: b.kind,
          center: [b.center.x, b.center.y, b.center.z],
          half: [b.half.x, b.half.y, b.half.z],
          quat: [b.quat.x, b.quat.y, b.quat.z, b.quat.w],
          material: b.material,
          team: b.team ?? myTeam,
        },
      });
    };

    const prevOnBlockReclaimed = build.onBlockReclaimed;
    build.onBlockReclaimed = (b) => {
      prevOnBlockReclaimed?.(b);
      transport.sendToHost({
        kind: 'action',
        data: { type: 'build_remove', pos: [b.center.x, b.center.y, b.center.z] },
      });
    };

    transport.events.onMessage = (_peerId: string, packet: NetPacket) => {
      if (packet.kind === 'snapshot') {
        remotePlayers.applySnapshot(packet.data.players, myNetworkId);
        const mySnap = packet.data.players.find((p) => p.id === myNetworkId);
        if (mySnap) {
          if (mySnap.hp !== player.me.hp) {
            if (mySnap.hp < player.me.hp) hud.hurt(player.me.hp - mySnap.hp);
            player.me.hp = mySnap.hp;
            hud.setHp(mySnap.hp);
          }
          if (!mySnap.alive && player.me.alive) {
            player.die('killed');
          } else if (mySnap.alive && !player.me.alive) {
            sim.respawn('killed');
            player.reset();
          }
        }
        const entries = Object.entries(packet.data.crystals) as [TeamId, CrystalSnapshot][];
        for (const [teamId, cr] of entries) {
          const bed = match.bed(teamId);
          if (bed) {
            bed.hp = cr.hp;
            bed.stage = cr.stage as 1 | 2;
            bed.alive = !cr.broken;
            if (cr.invulnT !== undefined) bed.invulnT = cr.invulnT;
          }
        }
        if (packet.data.bots) {
          for (const bSnap of packet.data.bots) {
            const bot = bots.bots.find((b) => b.id === bSnap.id);
            if (!bot) continue;
            bot.prevPos.copy(bot.sim.state.pos);
            bot.sim.state.pos.set(...bSnap.pos);
            bot.sim.state.vel.set(...bSnap.vel);
            bot.sim.state.frame.set(...bSnap.frame);
            bot.sim.state.yaw = bSnap.yaw;
            bot.sim.state.pitch = bSnap.pitch;
            bot.sim.state.onGround = bSnap.onGround;
            bot.sim.mover.place(bot.sim.state);
            bot.target.hp = bSnap.hp;
            bot.target.alive = bSnap.alive;
            upOf(bot.sim.state.frame, bot.target.up);
            bot.out = bSnap.out;
            bot.weapons.current = bSnap.weapon as WeaponId;
            bot.shotsTotal = bSnap.shotsTotal;
            bot.kicksTotal = bSnap.kicksTotal;
            bot.fishing = bSnap.fishing;
            bot.status = bSnap.status;
          }
        }
      } else if (packet.kind === 'event') {
        const ev = packet.data;
        if (ev.type === 'combat:bullet' && ev.ownerId !== myNetworkId) {
          remotePlayers.triggerFire(ev.ownerId);
          combat.use(ev.weapon as WeaponId, -1, new Vector3(...ev.origin), new Vector3(...ev.dir), new Vector3(), sim.gravityDown(), ev.chargeT);
        } else if (ev.type === 'combat:kick' && ev.ownerId !== myNetworkId) {
          remotePlayers.triggerKick(ev.ownerId);
        } else if (ev.type === 'combat:throw' && ev.ownerId !== myNetworkId) {
          throws.throw(ev.itemKind as ItemId, -1, new Vector3(...ev.origin), new Vector3(...ev.dir), new Vector3(), sim.gravityDown());
        } else if (ev.type === 'combat:hit' && ev.attackerId === myNetworkId) {
          hud.hitmarker(!!ev.killed, ev.isHead);
          if (ev.killed && !ev.isNpc) {
            match.wallet.cash += KILL_REWARD;
          }
        } else if (ev.type === 'combat:kill' && ev.victimTeam) {
          const vLabel = ev.victimId === myNetworkId ? 'Ты' : undefined;
          const aLabel = ev.attackerId === myNetworkId ? 'Ты' : undefined;
          const killer = ev.attackerTeam ? teamSpan(ev.attackerTeam, aLabel) : '';
          const victim = teamSpan(ev.victimTeam, vLabel);
          const sep = killIcon(ev.weapon as HitSource);
          const html = killer && ev.attackerId !== ev.victimId
            ? `${killer}${sep}${victim}${ev.isHead ? ' · в голову' : ''}`
            : `${icon('skull')}${victim} погиб`;
          hud.killfeed(html);
        } else if (ev.type === 'player:impulse' && ev.targetId === myNetworkId) {
          sim.applyImpulse(new Vector3(...ev.vec));
        } else if (ev.type === 'block:place') {
          const pos = new Vector3(...ev.center);
          let exists = false;
          for (const b of blocks.blocks.values()) {
            if (b.center.distanceToSquared(pos) <= 0.01) { exists = true; break; }
          }
          if (!exists) {
            blocks.insertPiece(
              ev.kind as BlockKind,
              pos,
              new Vector3(...ev.half),
              new Quaternion(...ev.quat),
              ev.material as BlockMaterial,
              ev.team,
            );
          }
        } else if (ev.type === 'block:break') {
          blocks.removeByPos(new Vector3(...ev.pos));
        }
      }
    };
  }

  /** Step authoritative simulation of connected clients on the host (called at TICK_DT). */
  tickHostClients(dt: number = TICK_DT) {
    if (!this.deps.isHost) return;
    const { combat, match } = this.deps;
    for (const rc of this.remoteClients.values()) {
      if (!rc.target.alive) {
        if (rc.respawnT <= 0 && match.bed(rc.team).alive) rc.respawnT = 4;
        if (rc.respawnT > 0) {
          rc.respawnT -= dt;
          if (rc.respawnT <= 0 && match.bed(rc.team).alive) {
            rc.sim.respawn('killed');
            rc.target.hp = MAX_HP;
            rc.target.alive = true;
            combat.guard(rc.target);
          }
        }
      } else {
        rc.sim.tick(rc.input, dt);
        for (const e of rc.sim.events.splice(0)) {
          if (e.type === 'land') combat.fall(rc.target, e.speed);
          else if (e.type === 'respawn' && e.reason === 'void') {
            rc.target.alive = false;
            rc.target.hp = 0;
          }
        }
        upOf(rc.sim.state.frame, rc.target.up);
        rc.target.vel = rc.sim.state.vel;
        rc.target.quiet = rc.input.crouch;
        rc.target.crouched = rc.input.crouch;
      }
    }
  }

  /** Per-frame network send/interpolation update. */
  updateFrame(dt: number, time: number) {
    const {
      isHost, myNetworkId, transport, sim, input, player, hands, local, match, bots, remotePlayers,
    } = this.deps;

    if (isHost) {
      const allPlayersSnap: RemotePlayerSnapshot[] = [
        {
          id: myNetworkId,
          pos: [sim.state.pos.x, sim.state.pos.y, sim.state.pos.z],
          vel: [sim.state.vel.x, sim.state.vel.y, sim.state.vel.z],
          frame: [sim.state.frame.x, sim.state.frame.y, sim.state.frame.z, sim.state.frame.w],
          yaw: input.yaw,
          pitch: input.pitch,
          hp: player.me.hp,
          maxHp: MAX_HP,
          alive: player.me.alive,
          onGround: sim.state.onGround,
          team: sim.team.id,
          activeWeapon: hands.held ?? player.weapons.current,
          hookPos: sim.hook ? [sim.hook.anchor.x, sim.hook.anchor.y, sim.hook.anchor.z] : null,
          crouching: local.input.crouch,
          isFiring: input.locked && input.down('Mouse0'),
        },
        ...[...this.remoteClients.values()].map((rc): RemotePlayerSnapshot => ({
          id: rc.id,
          pos: [rc.sim.state.pos.x, rc.sim.state.pos.y, rc.sim.state.pos.z],
          vel: [rc.sim.state.vel.x, rc.sim.state.vel.y, rc.sim.state.vel.z],
          frame: [rc.sim.state.frame.x, rc.sim.state.frame.y, rc.sim.state.frame.z, rc.sim.state.frame.w],
          yaw: rc.yaw,
          pitch: rc.pitch,
          hp: rc.target.hp,
          maxHp: MAX_HP,
          alive: rc.target.alive,
          onGround: rc.sim.state.onGround,
          team: rc.team,
          activeWeapon: rc.activeWeapon,
          hookPos: rc.sim.hook ? [rc.sim.hook.anchor.x, rc.sim.hook.anchor.y, rc.sim.hook.anchor.z] : null,
          crouching: rc.input.crouch,
          isFiring: rc.isFiring,
        })),
      ];
      remotePlayers.applySnapshot(allPlayersSnap, myNetworkId);

      // Host broadcasts player, bot and crystal state snapshot at 30Hz
      this.snapshotTimer += dt;
      if (this.snapshotTimer >= 0.033) {
        this.snapshotTimer = 0;
        const crystalsSnap = Object.fromEntries(
          match.beds.map((b) => [b.team, {
            team: b.team,
            stage: b.stage,
            hp: b.hp,
            maxHp: 80,
            invulnerable: b.invulnT > 0,
            invulnT: b.invulnT,
            broken: !b.alive,
          }]),
        ) as WorldSnapshot['crystals'];

        const botsSnap: RemoteBotSnapshot[] = bots.bots.map((b) => ({
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
        }));

        transport.broadcast({
          kind: 'snapshot',
          data: {
            tick: Math.floor(time * 64),
            serverTime: performance.now(),
            players: allPlayersSnap,
            crystals: crystalsSnap,
            bots: botsSnap,
          },
        });
      }
    } else {
      // Client sends its local inputs to Host at ~60Hz
      this.inputTimer += dt;
      if (this.inputTimer >= 0.016) {
        this.inputTimer = 0;
        const activeW = hands.held ?? player.weapons.current;
        transport.sendToHost({
          kind: 'input',
          data: {
            tick: Math.floor(time * 64),
            forward: local.input.forward,
            right: local.input.right,
            up: local.input.up,
            jump: local.input.jump,
            sprint: local.input.sprint,
            crouch: local.input.crouch,
            yaw: local.input.yaw,
            pitch: local.input.pitch,
            slot: Math.max(0, WEAPON_ORDER.indexOf(player.weapons.current)),
            weapon: activeW,
          },
        });
      }
    }
    remotePlayers.update(dt);
  }
}
