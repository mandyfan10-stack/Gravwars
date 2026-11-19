import { Block, BlockMaterial, START_BLOCKS } from '../../shared/blocks';
import { CombatEvent, MAX_HP, SPAWN_GUARD, Target } from '../../shared/combat';
import { Economy } from '../../shared/economy';
import { MATCH_RULES } from '../../shared/lobby';
import { killRewardFor, MatchEvent, SKIRMISH_WOOD_PER_SEC } from '../../shared/match';
import { upOf } from '../../shared/math';
import {
  applyRemoteClientJetpackEvents, syncRemoteClientJetpack, wireRemoteClientArmor,
} from '../../shared/net/hostGear';
import { emptyUserCommand, SimulateMovement } from '../../shared/net/pmove';
import { emptyInput } from '../../shared/movement';
import { RateLimiter } from '../../shared/net/validate';
import { PlayerSim } from '../../shared/sim';
import { TeamId } from '../../shared/teams';
import { WEAPON_ORDER, createWeaponState, refillAmmo } from '../../shared/weapons';
import { DEATH_TIME } from '../playerCombat';
import { applyClientInput, clearReloadState, finishRemoteReload, handleClientAction } from './netHostActions';
import { HostSnapshotBuilder } from './netHostSnapshot';
import {
  HumanLobbySeat, NetMatchDeps, RemoteClientSim, SNAPSHOT_INTERVAL, SpectatorTarget, resolvePlayerTeam, teamBadge,
} from './netTypes';

export { applyRemoteClientJetpackEvents, syncRemoteClientJetpack, wireRemoteClientArmor };

/** Authoritative Host simulation, anti-cheat packet validation, and 25 Hz snapshot broadcaster. */
export class HostMatchSession {
  readonly remoteClients = new Map<string, RemoteClientSim>();
  private readonly targetToClient = new Map<number, RemoteClientSim>();
  private readonly snapshots = new HostSnapshotBuilder();
  private nextClientTargetId = 2000;
  private hostOut = false;
  private snapAccum = 0;

  constructor(
    private readonly deps: NetMatchDeps,
    private readonly myId: string,
    private readonly hostTeam: TeamId,
    private readonly humansById: ReadonlyMap<string, HumanLobbySeat>,
    seats: HumanLobbySeat[],
  ) {
    this.setupHost(seats);
  }

  getSpectatorTargets(): SpectatorTarget[] {
    const list: SpectatorTarget[] = [];
    for (const rc of this.remoteClients.values()) {
      if (rc.disconnected) continue;
      list.push({
        id: rc.peerId,
        name: rc.name,
        team: rc.team,
        pos: rc.sim.state.pos,
        up: upOf(rc.sim.state.frame).clone(),
        frame: rc.sim.state.frame,
        yaw: rc.yaw,
        pitch: rc.pitch,
        alive: rc.target.alive && !rc.out,
        hp: rc.target.hp,
        weapon: rc.weapons.current,
      });
    }
    return list;
  }

  private ownerIdForTarget(targetId: number): string {
    if (targetId === 0) return this.myId;
    if (targetId >= 2000) return this.targetToClient.get(targetId)?.peerId ?? `p:${targetId}`;
    if (targetId >= 500 && targetId < 1000) return `npc:${targetId}`;
    if (targetId >= 100 && targetId < 500) return `bot:${targetId}`;
    return String(targetId);
  }

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
        if (!rc.disconnected && !rc.out && !rc.target.alive && rc.team === crystalTeam) this.reviveRemoteClient(rc);
      }
    };

    const prevOnKill = combat.onKill;
    combat.onKill = (victim, owner) => {
      prevOnKill(victim, owner);
      const rc = this.targetToClient.get(owner);
      if (rc && !victim.npc && victim.team !== rc.team) {
        const reward = killRewardFor(this.deps.map.mode);
        rc.wallet.cash += reward;
        if (this.deps.map.mode === 'skirmish') {
          rc.pendingNotice = { text: `+${reward}$`, color: '#ffd966' };
          rc.pendingSound = 'coins';
        }
        rc.dirtySync = true;
      }
    };

    player.onFire = (weapon, origin, dir, chargeT) => {
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'combat:bullet',
          ownerId: this.myId,
          attackerTeam: match.team,
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
          attackerTeam: bots.bots.find((b) => b.id === botId)?.team,
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
          variant: b.variant,
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
    const prevDoor = blocks.onDoorToggle;
    blocks.onDoorToggle = (b) => {
      prevDoor?.(b);
      transport.broadcast({ kind: 'event', data: { type: 'block:door', pos: [b.center.x, b.center.y, b.center.z], open: b.open } });
    };
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
      this.deps.hud.killfeed(`${teamBadge(rc.team, rc.name)} вышел из матча`);
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
        applyClientInput(rc, packet.data);
      } else if (packet.kind === 'action') {
        handleClientAction(this.deps, rc, packet.data);
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
    const maxHp = Math.max(10, Math.round(MAX_HP * MATCH_RULES.playerHp));
    const target: Target = {
      id: targetId,
      team: seat.team,
      center: sim.state.pos,
      up: upOf(sim.state.frame),
      vel: sim.state.vel,
      hp: maxHp,
      maxHp,
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
    const blocksInv: Record<BlockMaterial, number> = { ...START_BLOCKS, wood: 16 };
    const eco = new Economy(wallet, { inventory: blocksInv }, weapons);
    eco.freeWeapons = map.mode === 'skirmish';

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
      cmd: emptyUserCommand(),
      yaw: sim.state.yaw,
      pitch: 0,
      lastSeq: 0,
      lastTick: 0,
      firing: false,
      reloadT: 0,
      reloadW: null,
      reloadCap: 0,
      reloadTotal: 0,
      reloadEmpty: false,
      respawnT: 0,
      woodRegenT: 0,
      out: false,
      disconnected: false,
      dirtySync: true,
      limiter: new RateLimiter(),
      kickCdUntil: 0,
      crossbowReadyAt: 0,
      lastFishAt: -Infinity,
    };
    wireRemoteClientArmor(rc);
    this.remoteClients.set(seat.id, rc);
    this.targetToClient.set(targetId, rc);
  }

  onCombatEvent(e: CombatEvent) {
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
      const victimTeam = resolvePlayerTeam(victimId, this.myId, this.deps, this.humansById, this.remoteClients);
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
        const killerTeam = resolvePlayerTeam(killerId, this.myId, this.deps, this.humansById, this.remoteClients);
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

  onMatchEvent(e: MatchEvent) {
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
    clearReloadState(rc);
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
    rc.crossbowReadyAt = 0;
    rc.target.alive = true;
    rc.target.hp = rc.target.maxHp ?? Math.round(MAX_HP * MATCH_RULES.playerHp);
    rc.sim.respawn('manual');
    rc.sim.events.length = 0;
    rc.target.guard = { t: SPAWN_GUARD.time, from: rc.sim.state.pos.clone() };
    rc.dirtySync = true;
  }

  /** Step all remote client sims on the Host (called at fixed 64Hz rate from local.onTick). */
  tick(dt: number) {
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
        syncRemoteClientJetpack(rc);
        SimulateMovement(rc.sim, rc.cmd, dt);
        for (const ev of rc.sim.events.splice(0)) {
          if (ev.type === 'land') combat.fall(rc.target, ev.speed);
          else if (applyRemoteClientJetpackEvents(rc, ev, combat)) continue;
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
          if (rc.reloadT <= 0) finishRemoteReload(rc);
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
        if (this.deps.map.mode === 'skirmish' && match.isInsideBaseHall(rc.sim.state.pos, rc.team)) {
          rc.woodRegenT += dt;
          if (rc.woodRegenT >= 1) {
            const gain = Math.floor(rc.woodRegenT);
            rc.woodRegenT -= gain;
            rc.blocksInv.wood += gain * SKIRMISH_WOOD_PER_SEC;
            rc.dirtySync = true;
          }
        } else {
          rc.woodRegenT = 0;
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

  updateFrame(dt: number) {
    this.snapAccum += dt;
    if (this.snapAccum >= SNAPSHOT_INTERVAL) {
      this.snapAccum = Math.min(this.snapAccum - SNAPSHOT_INTERVAL, SNAPSHOT_INTERVAL);
      this.broadcastWorldSnapshot();
    }
  }

  private broadcastWorldSnapshot() {
    const { transport, remotePlayers } = this.deps;
    const { snap, players, reliable } = this.snapshots.build(
      this.deps, this.myId, this.hostTeam, this.hostOut, this.humansById, this.remoteClients,
    );
    remotePlayers.applySnapshot(players.filter((p) => p.id !== this.myId), this.myId, snap.serverTime);
    if (reliable) transport.broadcast({ kind: 'snapshot', data: snap });
    else transport.broadcastFast({ kind: 'snapshot', data: snap });
  }
}
