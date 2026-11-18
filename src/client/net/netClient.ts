import { Quaternion, Vector3 } from 'three';
import { BlockKind, BlockMaterial, PieceVariant } from '../../shared/blocks';
import { BotManager } from '../../shared/bots';
import { SPAWN_GUARD, Target } from '../../shared/combat';
import { TICK_DT } from '../../shared/constants';
import { ItemId, Step } from '../../shared/economy';
import { escapeHtml } from '../../shared/escape';
import { holdables } from '../../shared/inventory';
import { CRYSTAL_INVULN_TIME } from '../../shared/match';
import { upOf } from '../../shared/math';
import { cloneUserCommand, type PMoveServerState } from '../../shared/net/pmove';
import {
  ClientAction, NetPacket, RemoteBotSnapshot, RemoteCarSnapshot, RemoteNpcSnapshot, RemotePlayerSnapshot, WorldEvent,
  WorldSnapshot,
} from '../../shared/net/protocol';
import { NpcManager, NpcState } from '../../shared/npcs';
import { WEAPON_ORDER, WeaponId } from '../../shared/weapons';
import { killIcon } from '../playerCombat';
import {
  HumanLobbySeat, NetMatchDeps, SpectatorTarget, lobbyHumans, playRemoteGunAudio, resolveEntityFaction,
  resolvePlayerLabel, resolvePlayerTeam, teamBadge,
} from './netTypes';
import { PMoveClient } from './pmoveClient';

const _tmpV = new Vector3();
const _tmpQ = new Quaternion();

/** Client-side prediction/reconciliation, snapshot entity interpolation, and authoritative event application. */
export class ClientMatchSession {
  private readonly remoteProxyTargets = new Map<string, Target>();
  private readonly pmoveClient = new PMoveClient();
  private nextClientTargetId = 2000;
  private clientOut = false;
  private latestSnapshot: WorldSnapshot | null = null;
  private readonly botTargets = new Map<number, RemoteBotSnapshot>();
  private readonly npcTargets = new Map<number, RemoteNpcSnapshot>();
  private readonly carTargets = new Map<number, RemoteCarSnapshot>();
  private clientHostDisconnected = false;
  private suppressBlockNet = false;

  constructor(
    private readonly deps: NetMatchDeps,
    private readonly myId: string,
    private readonly hostId: string,
    private readonly humansById: ReadonlyMap<string, HumanLobbySeat>,
  ) {
    this.setupClient();
  }

  getSpectatorTargets(): SpectatorTarget[] {
    return this.deps.remotePlayers.list().map((rp) => ({
      id: rp.id,
      name: rp.name,
      team: rp.team,
      pos: rp.pos,
      up: rp.up,
      frame: rp.frame,
      yaw: rp.yaw,
      pitch: rp.pitch,
      alive: rp.alive,
      hp: rp.hp,
      weapon: rp.weapon,
    }));
  }

  private setupClient() {
    const {
      transport, lobby, combat, blocks, match, player, hands, pockets, build, ui, invUi, local,
    } = this.deps;

    local.pmove = this.pmoveClient;
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
        variant: b.variant,
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
    const prevDoor = blocks.onDoorToggle;
    blocks.onDoorToggle = (b) => {
      prevDoor?.(b);
      if (!this.suppressBlockNet) {
        sendAct({ type: 'block_door', pos: [b.center.x, b.center.y, b.center.z], open: b.open });
      }
    };
    if (invUi) {
      invUi.onDropRemote = (holdable, dir) => sendAct({ type: 'drop_item', holdable, dir: [dir.x, dir.y, dir.z] });
    }

    ui.onRemoteBuy = (itemId) => sendAct({ type: 'buy', itemId });
    ui.onRemoteSell = (kind) => sendAct({ type: 'sell', kind });

    pockets.onInteractPickup = (pickupId) => sendAct({ type: 'interact', target: 'pickup', targetId: pickupId });
    pockets.onPickupFront = (pos, dir) => sendAct({
      type: 'interact', target: 'pickup_front', pos: [pos.x, pos.y, pos.z], dir: [dir.x, dir.y, dir.z],
    });
    pockets.onConsume = (itemId) => sendAct({
      type: 'interact', target: itemId === 'apple' ? 'consume_apple' : itemId === 'fish' ? 'consume_fish' : 'consume_medkit',
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

  /** Stream predicted `UserCommand` (`usercmd_t`) to host at 64Hz on non-host client. */
  onLocalTick() {
    const { local, player, hands, transport } = this.deps;
    const cmd = cloneUserCommand(local.lastCmd);

    transport.sendToHost({
      kind: 'input',
      data: {
        cmd,
        seq: cmd.tick,
        tick: cmd.tick,
        forward: cmd.forwardmove,
        right: cmd.sidemove,
        up: cmd.upmove,
        jump: local.input.jump,
        sprint: local.input.sprint,
        crouch: local.input.crouch,
        yaw: cmd.viewangles[0],
        pitch: cmd.viewangles[1],
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
    remotePlayers.applySnapshot(others, this.myId, snap.serverTime);
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
      this.pmoveClient.clear();
      return;
    }
    if (!ps.alive) return;

    const ackTick = ps.ackTick ?? ps.ackSeq ?? 0;
    if (ackTick <= 0) return;

    const serverState: PMoveServerState = {
      ackTick,
      pos: ps.pos,
      vel: ps.vel,
      frame: ps.frame,
      yaw: ps.yaw,
      pitch: ps.pitch,
      onGround: ps.onGround,
      crouched: ps.crouching,
      stamina: ps.stamina ?? sim.state.stamina,
      exhausted: ps.exhausted ?? sim.state.exhausted,
      restT: ps.restT ?? sim.state.restT,
      airT: ps.airT ?? sim.state.airT,
      jumpHold: ps.jumpHold ?? sim.state.jumpHold,
      jumpReleased: ps.jumpReleased ?? sim.state.jumpReleased,
      jetpackHeat: ps.jetpackHeat ?? sim.jetpackHeat,
      jetpackOverheatCd: ps.jetpackOverheatCd ?? sim.jetpackOverheatCd,
    };
    const res = this.pmoveClient.reconcile(sim, serverState, TICK_DT);
    if (res.corrected) {
      // Snap local prevPos on large teleports (> 3.5 m) so interpolation doesn't smear across map
      if (res.errorDist > 3.5) local.snap();
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
        const faction = e.attackerTeam ?? resolveEntityFaction(e.ownerId, this.myId, this.deps, this.humansById);
        combat.use(w, -1, o, d, new Vector3(), sim.gravityDown(), e.chargeT ?? 0, faction);
        playRemoteGunAudio(w, o, this.deps);
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
          this.suppressBlockNet = true;
          try {
            blocks.insertPiece(
              e.kind as BlockKind, c, new Vector3(...e.half), new Quaternion(...e.quat),
              e.material as BlockMaterial, e.team, e.key, e.level, (e.variant as PieceVariant | undefined) ?? 'plain',
            );
          } finally {
            this.suppressBlockNet = false;
          }
          if (c.distanceTo(this.deps.camera.position) < 28) audio.place();
        }
        break;
      }
      case 'block:door': {
        const found = blocks.findByPos(new Vector3(...e.pos), 0.35);
        if (found) {
          this.suppressBlockNet = true;
          try {
            blocks.setDoorState(found, e.open);
          } finally {
            this.suppressBlockNet = false;
          }
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
        this.deps.hands.bar.sync(holdables(eco));
        player.me.armor = eco.has('armor');
        hud.setArmor(player.me.armor);
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
      case 'chat': {
        this.deps.onChat?.(e.sender, e.text, e.team);
        break;
      }
    }
  }

  private handleClientKillEvent(e: Extract<WorldEvent, { type: 'combat:kill' }>) {
    const { hud, player, stats } = this.deps;
    const victimTeam = e.victimTeam ?? resolvePlayerTeam(e.victimId, this.myId, this.deps, this.humansById);
    const killerTeam = e.attackerTeam ?? resolvePlayerTeam(e.attackerId, this.myId, this.deps, this.humansById);
    const vLabel = e.victimId === this.myId ? 'Ты' : resolvePlayerLabel(e.victimId, this.deps, this.humansById);
    const kLabel = e.attackerId === this.myId ? 'Ты' : resolvePlayerLabel(e.attackerId, this.deps, this.humansById);
    const vSpan = victimTeam ? teamBadge(victimTeam, vLabel) : escapeHtml(vLabel);
    const kSpan = killerTeam ? teamBadge(killerTeam, kLabel) : escapeHtml(kLabel);
    if (e.cause === 'quit') {
      hud.killfeed(`${vSpan} вышел`);
      return;
    }
    if (e.cause === 'void') hud.killfeed(`${vSpan} улетел в бездну`);
    else if (!e.attackerId || e.attackerId === e.victimId) hud.killfeed(`${vSpan} погиб`);
    else hud.killfeed(`${kSpan}${killIcon(e.weapon ? (e.weapon as WeaponId) : undefined)}${vSpan}`);

    if (e.attackerId === this.myId && victimTeam && victimTeam !== this.deps.match.team) {
      const vt = this.remoteProxyTargets.get(e.victimId) ?? player.me;
      stats.frag(player.me, vt, e.isHead);
    }
    if (e.victimId === this.myId) {
      if (e.final) this.clientOut = true;
      const kt = e.attackerId ? this.remoteProxyTargets.get(e.attackerId) : undefined;
      player.die(e.cause === 'fall' ? 'fall' : e.cause === 'void' ? 'void' : e.attackerId ? 'killed' : 'self', kt, (e.weapon || undefined) as WeaponId | undefined, e.isHead, e.final);
    }
  }

  updateFrame(dt: number, bots: BotManager, npcs: NpcManager) {
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
      s.pitch = target.pitch;
      upOf(s.frame, b.target.up);
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
