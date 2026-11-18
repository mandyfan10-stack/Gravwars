import { Vector3 } from 'three';
import { Block, BlockMaterial, START_BLOCKS } from '../../shared/blocks';
import { CombatEvent, MAX_HP, SPAWN_GUARD, Target } from '../../shared/combat';
import { EAT_COOLDOWN, Economy, ITEMS, ItemId, Pickups, PickupKind, SHOP } from '../../shared/economy';
import { MATCH_RULES } from '../../shared/lobby';
import { killRewardFor, MatchEvent, maxCrystalHp, SKIRMISH_WOOD_PER_SEC } from '../../shared/match';
import { upOf } from '../../shared/math';
import {
  commandToMoveInput, emptyUserCommand, IN_DUCK, IN_JUMP, IN_SPEED, sanitizeUserCommand, SimulateMovement, type UserCommand,
} from '../../shared/net/pmove';
import { emptyInput } from '../../shared/movement';
import {
  ClientAction, CrystalSnapshot, PlayerInputPacket, RemotePlayerSnapshot, WorldSnapshot,
} from '../../shared/net/protocol';
import {
  BUILD_REACH, KICK_INTERVAL, MAX_CHARGE_T, MIN_FISH_INTERVAL, RateLimiter,
  clampNum, cleanBuildPlace, eyeNear, fireInterval, isDir, isItemId, isVec3, isWeaponId, nearPond,
} from '../../shared/net/validate';
import { PlayerSim } from '../../shared/sim';
import { TeamId } from '../../shared/teams';
import {
  KICK, WEAPONS, WEAPON_ORDER, WeaponId, createWeaponState, crossbowSpec, isGun, refillAmmo,
} from '../../shared/weapons';
import { DEATH_TIME } from '../playerCombat';
import {
  HumanLobbySeat, NetMatchDeps, PICKUP_RESYNC_TICKS, RemoteClientSim, SNAPSHOT_INTERVAL, SpectatorTarget,
  resolvePlayerTeam, teamBadge,
} from './netTypes';

const _tmpV2 = new Vector3();

/** Authoritative Host simulation, anti-cheat packet validation, and 25 Hz snapshot broadcaster. */
export class HostMatchSession {
  readonly remoteClients = new Map<string, RemoteClientSim>();
  private readonly targetToClient = new Map<number, RemoteClientSim>();
  private nextClientTargetId = 2000;
  private hostOut = false;
  private snapAccum = 0;
  private snapTick = 0;
  private lastPickupsVersion = -1;

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

  private clearReloadState(rc: RemoteClientSim) {
    rc.reloadW = null;
    rc.reloadT = 0;
    rc.reloadCap = 0;
    rc.reloadTotal = 0;
    rc.reloadEmpty = false;
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
    this.remoteClients.set(seat.id, rc);
    this.targetToClient.set(targetId, rc);
  }

  private applyClientInput(rc: RemoteClientSim, inp: PlayerInputPacket) {
    if (!inp || typeof inp !== 'object') return;
    const seq = typeof inp.seq === 'number' && Number.isFinite(inp.seq) ? inp.seq : rc.lastSeq + 1;
    if (seq <= rc.lastSeq) return;
    rc.lastSeq = seq;
    let rawCmd: UserCommand;
    if (inp.cmd) {
      rawCmd = inp.cmd;
    } else {
      let buttons = 0;
      if (inp.jump) buttons |= IN_JUMP;
      if (inp.crouch) buttons |= IN_DUCK;
      if (inp.sprint) buttons |= IN_SPEED;
      rawCmd = {
        tick: typeof inp.tick === 'number' && Number.isFinite(inp.tick) ? inp.tick : 0,
        forwardmove: clampNum(inp.forward, -1, 1),
        sidemove: clampNum(inp.right, -1, 1),
        upmove: clampNum(inp.up, -1, 1),
        viewangles: [clampNum(inp.yaw, -1e6, 1e6, rc.yaw), clampNum(inp.pitch, -Math.PI / 2, Math.PI / 2, rc.pitch)],
        buttons,
      };
    }
    rc.cmd = sanitizeUserCommand(rawCmd);
    rc.lastTick = rc.cmd.tick;
    commandToMoveInput(rc.cmd, rc.input);
    rc.yaw = rc.cmd.viewangles[0];
    rc.pitch = rc.cmd.viewangles[1];
    if (isWeaponId(inp.weapon) && (inp.weapon === 'fists' || rc.weapons.owned[inp.weapon])) {
      if (rc.weapons.current !== inp.weapon) {
        rc.weapons.current = inp.weapon;
        this.clearReloadState(rc);
      }
    }
  }

  private handleClientAction(rc: RemoteClientSim, act: ClientAction) {
    const { combat, blocks, match, pickups, throws, transport } = this.deps;
    if (!act || typeof act !== 'object' || typeof act.type !== 'string') return;
    const now = performance.now() / 1000;
    const st = rc.sim.state;
    /** A client-claimed eye / muzzle must sit at the host-side player (no shots / hooks / kicks from across the map). */
    const plausibleEye = (eye: unknown): eye is [number, number, number] => isVec3(eye) && eyeNear(eye, st.pos, rc.target.up, st.vel);

    if (act.type === 'select_slot') {
      const w = act.weapon;
      if (isWeaponId(w) && (w === 'fists' || rc.weapons.owned[w]) && w !== rc.weapons.current) {
        rc.weapons.current = w;
        this.clearReloadState(rc);
      }
      return;
    }
    if (act.type === 'hook') {
      if (act.release) rc.sim.releaseHook();
      else if (rc.target.alive && !rc.out && rc.eco.has('hook') && plausibleEye(act.eye) && isDir(act.dir)
        && rc.limiter.allow('hook', 0.25, now)) {
        rc.sim.throwHook(new Vector3(...act.eye), new Vector3(...act.dir), combat.notCharacter);
      }
      return;
    }
    if (rc.out || !rc.target.alive) return;

    if (act.type === 'fire') {
      const w = act.weapon;
      if (!isWeaponId(w) || (w !== 'fists' && !rc.weapons.owned[w])) { rc.dirtySync = true; return; }
      if (!plausibleEye(act.origin) || !isDir(act.dir)) { rc.dirtySync = true; return; }
      const chargeT = w === 'crossbow' ? clampNum(act.chargeT, 0, MAX_CHARGE_T) : 0;
      if (w === 'crossbow') {
        if (now < rc.crossbowReadyAt) return;
        if (rc.weapons.reserve.crossbow > 0) rc.weapons.reserve.crossbow--;
        rc.weapons.ammo.crossbow = 1;
        rc.crossbowReadyAt = now + crossbowSpec(chargeT).reload * 0.8;
      } else {
        if (rc.reloadT > 0 && rc.reloadW === w) {
          // Interruptible reloads: shotgun shell-by-shell (if a shell is loaded or >=0.4s elapsed) and active-reload early finish (>=55% elapsed)
          const elapsed = rc.reloadTotal - rc.reloadT;
          if (w === 'shotgun' && (rc.weapons.ammo.shotgun > 0 || elapsed >= 0.4)) {
            if (rc.weapons.ammo.shotgun <= 0) {
              rc.weapons.ammo.shotgun = 1;
              if (rc.weapons.reserve.shotgun > 0) rc.weapons.reserve.shotgun--;
            }
            this.clearReloadState(rc);
          } else if (rc.reloadTotal > 0 && elapsed >= rc.reloadTotal * 0.55) {
            this.finishRemoteReload(rc);
          } else {
            rc.dirtySync = true;
            return;
          }
        }
        if (!rc.limiter.allow(`fire:${w}`, fireInterval(w), now)) return;
        if (isGun(w) || w === 'grenade') {
          if (rc.weapons.ammo[w] <= 0) { rc.dirtySync = true; return; }
          rc.weapons.ammo[w]--;
          if (w === 'grenade') rc.dirtySync = true;
        }
      }
      rc.firing = true;
      const o = new Vector3(...act.origin);
      const d = new Vector3(...act.dir).normalize();
      combat.use(w, rc.target.id, o, d, st.vel, rc.sim.gravityDown(), chargeT, rc.team);
      this.deps.remotePlayers.triggerFire(rc.peerId);
      transport.broadcast({
        kind: 'event',
        data: { type: 'combat:bullet', ownerId: rc.peerId, attackerTeam: rc.team, origin: act.origin, dir: [d.x, d.y, d.z], weapon: w, chargeT },
      }, rc.peerId);
    } else if (act.type === 'reload') {
      const w = rc.weapons.current;
      if (!isGun(w) || w === 'crossbow' || !rc.weapons.owned[w] || rc.weapons.reserve[w] <= 0) { rc.dirtySync = true; return; }
      const tactical = w !== 'shotgun' && rc.weapons.ammo[w] > 0;
      const cap = WEAPONS[w].mag + (tactical ? 1 : 0);
      if (rc.weapons.ammo[w] >= cap) return;
      if (rc.reloadT > 0 && rc.reloadW === w) return;
      const rawDur = w === 'shotgun'
        ? Math.max(0.45, Math.min(cap - rc.weapons.ammo[w], rc.weapons.reserve[w]) * 0.45 + (rc.weapons.ammo[w] === 0 ? 0.45 : 0))
        : (tactical ? WEAPONS[w].reload : WEAPONS[w].reloadEmpty);
      rc.reloadW = w;
      rc.reloadCap = cap;
      rc.reloadEmpty = rc.weapons.ammo[w] === 0;
      rc.reloadTotal = rawDur;
      rc.reloadT = rawDur * 0.85;
    } else if (act.type === 'kick') {
      if (!plausibleEye(act.eye) || !isDir(act.dir)) return;
      if (now < rc.kickCdUntil || !rc.limiter.allow('kick', KICK_INTERVAL, now)) return;
      const hits = combat.kick(rc.target.id, new Vector3(...act.eye), new Vector3(...act.dir).normalize(), rc.target.up);
      rc.kickCdUntil = now + (hits > 0 ? KICK.cdHit : KICK.cdMiss) * 0.8;
      this.deps.remotePlayers.triggerKick(rc.peerId);
      transport.broadcast({
        kind: 'event',
        data: { type: 'combat:kick', ownerId: rc.peerId, eye: act.eye, dir: act.dir },
      }, rc.peerId);
    } else if (act.type === 'throw') {
      if (!isItemId(act.kind) || (act.kind !== 'apple' && act.kind !== 'bottle')) { rc.dirtySync = true; return; }
      const kind = act.kind;
      if (!plausibleEye(act.origin) || !isDir(act.dir) || !rc.limiter.allow('throw', 0.3, now)) { rc.dirtySync = true; return; }
      if (!rc.eco.take(kind)) { rc.dirtySync = true; return; }
      throws.throw(kind, rc.target.id, new Vector3(...act.origin), new Vector3(...act.dir).normalize(), st.vel, rc.sim.gravityDown());
      rc.dirtySync = true;
      transport.broadcast({
        kind: 'event',
        data: { type: 'combat:throw', ownerId: rc.peerId, itemKind: kind, origin: act.origin, dir: act.dir },
      }, rc.peerId);
    } else if (act.type === 'build_place') {
      const clean = cleanBuildPlace(act);
      const reject = () => {
        if (isVec3(act.center)) transport.sendTo(rc.peerId, { kind: 'event', data: { type: 'block:break', pos: act.center } });
        rc.dirtySync = true;
      };
      if (!clean || act.team !== rc.team || !rc.limiter.allow('build', 0.08, now)) { reject(); return; }
      const { kind, variant, center: c, half: h, quat: q, material: mat } = clean;
      const plan = {
        kind,
        center: c,
        half: h,
        quat: q,
        key: clean.key ?? `${kind}:${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}`,
        level: clean.level,
      };
      const cost = blocks.costOf(plan);
      const tooFar = c.distanceTo(st.pos) > BUILD_REACH;
      if (tooFar || rc.blocksInv[mat] < cost || blocks.validate(plan, mat, true, true) !== 'ok') { reject(); return; }
      rc.blocksInv[mat] -= cost;
      blocks.insertPiece(kind, c, h, q, mat, rc.team, clean.key ?? null, clean.level, variant);
      rc.dirtySync = true;
      transport.broadcast({
        kind: 'event',
        data: {
          type: 'block:place', kind, variant, center: [c.x, c.y, c.z], half: [h.x, h.y, h.z], quat: [q.x, q.y, q.z, q.w],
          material: mat, team: rc.team, key: clean.key, level: clean.level,
        },
      }, rc.peerId);
    } else if (act.type === 'build_remove') {
      if (!isVec3(act.pos)) return;
      const p = new Vector3(...act.pos);
      if (p.distanceTo(st.pos) > BUILD_REACH) return;
      const found = blocks.findByPos(p, 0.35);
      if (!found || found.team !== rc.team || !blocks.removeByPos(p, 0.35)) {
        if (found) {
          transport.sendTo(rc.peerId, {
            kind: 'event',
            data: {
              type: 'block:place',
              kind: found.kind,
              variant: found.variant,
              center: [found.center.x, found.center.y, found.center.z],
              half: [found.half.x, found.half.y, found.half.z],
              quat: [found.quat.x, found.quat.y, found.quat.z, found.quat.w],
              material: found.material,
              team: found.team,
              key: found.key ?? undefined,
              level: found.level,
            },
          });
        }
        rc.dirtySync = true;
        return;
      }
      rc.blocksInv[found.material] += found.cost;
      rc.dirtySync = true;
      transport.broadcast({ kind: 'event', data: { type: 'block:break', pos: act.pos } }, rc.peerId);
    } else if (act.type === 'block_door') {
      if (!isVec3(act.pos) || typeof act.open !== 'boolean') return;
      const found = blocks.findByPos(new Vector3(...act.pos), 0.35);
      if (found && found.variant === 'door' && (!found.team || found.team === rc.team) && found.center.distanceTo(st.pos) < 8) {
        blocks.setDoorState(found, act.open);
      }
    } else if (act.type === 'drop_item') {
      if (typeof act.holdable !== 'string' || act.holdable.length > 32 || !isVec3(act.dir)) return;
      if (!rc.limiter.allow('drop', 0.15, now)) { rc.dirtySync = true; return; }
      const dropRes = rc.eco.dropFromSlot(act.holdable);
      if (dropRes) {
        const up = upOf(st.frame).clone();
        const dir = _tmpV2.set(...act.dir);
        if (dir.lengthSq() > 1e-4) dir.normalize();
        else dir.set(-Math.sin(rc.yaw), 0, -Math.cos(rc.yaw)).applyQuaternion(st.frame);
        const dropPos = st.pos.clone().addScaledVector(dir, 1.5);
        pickups.drop(dropRes.kind, dropPos, up, dropRes.amount);
        rc.pendingSound = 'pickup';
      }
      rc.dirtySync = true;
    } else if (act.type === 'buy') {
      if (!match.nearShop(st.pos)) { rc.dirtySync = true; return; }
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
      if (!match.nearShop(st.pos)) { rc.dirtySync = true; return; }
      if (act.kind !== 'all' && !isItemId(act.kind)) return;
      const got = act.kind === 'all' ? rc.eco.sellAll() : rc.eco.sell(act.kind);
      if (got > 0) {
        rc.pendingNotice = { text: `+${got}$`, color: '#ffd966' };
        rc.pendingSound = 'coins';
      }
      rc.dirtySync = true;
    } else if (act.type === 'interact') {
      this.handleClientInteract(rc, act, pickups);
    } else if (act.type === 'chat') {
      if (typeof act.text !== 'string' || !rc.limiter.allow('chat', 0.4, now)) return;
      const text = act.text.replace(/\s+/g, ' ').trim().slice(0, 140);
      if (!text) return;
      transport.broadcast({ kind: 'event', data: { type: 'chat', sender: rc.name, team: rc.team, text } });
      this.deps.onChat?.(rc.name, text, rc.team);
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
      if ((act.pos !== undefined && !isVec3(act.pos)) || (act.dir !== undefined && !isDir(act.dir))) return;
      const up = upOf(rc.sim.state.frame);
      const pos = act.pos ? new Vector3(...act.pos) : rc.sim.state.pos;
      if (!(pos.distanceTo(rc.sim.state.pos) <= 3)) return;
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
    } else if (act.target === 'consume_apple' || act.target === 'consume_fish' || act.target === 'consume_medkit') {
      const itemId: ItemId = act.target === 'consume_apple' ? 'apple' : act.target === 'consume_fish' ? 'fish' : 'medkit';
      const now = performance.now() / 1000;
      const maxHp = rc.target.maxHp ?? Math.round(MAX_HP * MATCH_RULES.playerHp);
      if (rc.target.hp >= maxHp || !rc.limiter.allow('consume', EAT_COOLDOWN, now) || !rc.eco.take(itemId)) {
        rc.dirtySync = true;
        return;
      }
      const heal = ITEMS[itemId].heal;
      rc.target.hp = Math.min(maxHp, rc.target.hp + heal);
      rc.pendingNotice = { text: itemId === 'medkit' ? 'Здоровье восстановлено' : `+${heal} HP`, color: '#9dff9e' };
      rc.pendingSound = itemId === 'medkit' ? 'patch' : 'eat';
      rc.dirtySync = true;
    } else if (act.target === 'fish_catch') {
      // The fishing minigame runs on the client, so the host can only bound it: a rod, a pond in reach and no
      // faster than one full cast → wait cycle. Without this a modified client farms items / cash in a loop.
      const now = performance.now() / 1000;
      if (!rc.eco.has('rod') || !nearPond(rc.sim.state.pos, this.deps.map.ponds)) return;
      if (now - rc.lastFishAt < MIN_FISH_INTERVAL) return;
      rc.lastFishAt = now;
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
    this.clearReloadState(rc);
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

  private finishRemoteReload(rc: RemoteClientSim) {
    const w = rc.reloadW;
    if (!w) return;
    const spec = WEAPONS[w];
    const cap = rc.reloadCap || spec.mag;
    const need = Math.max(0, cap - rc.weapons.ammo[w]);
    const give = Math.min(need, rc.weapons.reserve[w]);
    rc.weapons.ammo[w] += give;
    rc.weapons.reserve[w] -= give;
    this.clearReloadState(rc);
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
        SimulateMovement(rc.sim, rc.cmd, dt);
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
        ackTick: rc.lastTick,
        stamina: rc.sim.state.stamina,
        exhausted: rc.sim.state.exhausted,
        restT: rc.sim.state.restT,
        airT: rc.sim.state.airT,
        jumpHold: rc.sim.state.jumpHold,
        jumpReleased: rc.sim.state.jumpReleased,
        jetpackHeat: rc.sim.jetpackHeat,
        jetpackOverheatCd: rc.sim.jetpackOverheatCd,
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
        maxHp: maxCrystalHp(),
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

    remotePlayers.applySnapshot(players.filter((p) => p.id !== this.myId), this.myId, snap.serverTime);
    transport.broadcast({ kind: 'snapshot', data: snap });
  }
}
