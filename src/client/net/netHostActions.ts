import { Vector3 } from 'three';
import { MAX_HP } from '../../shared/combat';
import { EAT_COOLDOWN, healAmountForItem, ItemId, Pickups, PickupKind, SHOP } from '../../shared/economy';
import { MATCH_RULES } from '../../shared/lobby';
import { scaleReward } from '../../shared/match';
import { upOf } from '../../shared/math';
import {
  commandToMoveInput, IN_DUCK, IN_JUMP, IN_SPEED, sanitizeUserCommand, type UserCommand,
} from '../../shared/net/pmove';
import type { ClientAction, PlayerInputPacket } from '../../shared/net/protocol';
import {
  BUILD_REACH, KICK_INTERVAL, MAX_CHARGE_T, MIN_FISH_INTERVAL,
  clampNum, cleanBuildPlace, eyeNear, fireInterval, isDir, isItemId, isVec3, isWeaponId, nearPond,
} from '../../shared/net/validate';
import { KICK, WEAPONS, crossbowSpec, isGun, refillAmmo } from '../../shared/weapons';
import type { NetMatchDeps, RemoteClientSim } from './netTypes';

const _tmpV2 = new Vector3();

export function clearReloadState(rc: RemoteClientSim) {
  rc.reloadW = null;
  rc.reloadT = 0;
  rc.reloadCap = 0;
  rc.reloadTotal = 0;
  rc.reloadEmpty = false;
}

export function finishRemoteReload(rc: RemoteClientSim) {
  const w = rc.reloadW;
  if (!w) return;
  const spec = WEAPONS[w];
  const cap = rc.reloadCap || spec.mag;
  const need = Math.max(0, cap - rc.weapons.ammo[w]);
  const give = Math.min(need, rc.weapons.reserve[w]);
  rc.weapons.ammo[w] += give;
  rc.weapons.reserve[w] -= give;
  clearReloadState(rc);
  rc.dirtySync = true;
}

export function applyClientInput(rc: RemoteClientSim, inp: PlayerInputPacket) {
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
}

function applyPickupReward(rc: RemoteClientSim, kind: PickupKind, amount: number) {
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

function handleClientInteract(
  deps: NetMatchDeps,
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
    applyPickupReward(rc, kind, amount);
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
      applyPickupReward(rc, kind, amount);
    }
  } else if (act.target === 'consume_apple' || act.target === 'consume_fish' || act.target === 'consume_medkit') {
    const itemId: ItemId = act.target === 'consume_apple' ? 'apple' : act.target === 'consume_fish' ? 'fish' : 'medkit';
    const now = performance.now() / 1000;
    const maxHp = rc.target.maxHp ?? Math.round(MAX_HP * MATCH_RULES.playerHp);
    if (rc.target.hp >= maxHp || !rc.limiter.allow('consume', EAT_COOLDOWN, now) || !rc.eco.take(itemId)) {
      rc.dirtySync = true;
      return;
    }
    const heal = healAmountForItem(itemId, maxHp);
    rc.target.hp = Math.min(maxHp, rc.target.hp + heal);
    rc.pendingNotice = { text: itemId === 'medkit' ? 'Здоровье восстановлено' : `+${heal} HP`, color: '#9dff9e' };
    rc.pendingSound = itemId === 'medkit' ? 'patch' : 'eat';
    rc.dirtySync = true;
  } else if (act.target === 'fish_catch') {
    // The fishing minigame runs on the client, so the host bounds it: a rod, a pond in reach and no faster than a cast cycle.
    const now = performance.now() / 1000;
    if (!rc.eco.has('rod') || !nearPond(rc.sim.state.pos, deps.map.ponds)) return;
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
      const cash = scaleReward(3);
      rc.wallet.cash += cash;
      rc.pendingNotice = { text: `Кошелёк: +${cash}$`, color: '#ffd966' };
      rc.pendingSound = 'coins';
    }
    rc.dirtySync = true;
  }
}

export function handleClientAction(deps: NetMatchDeps, rc: RemoteClientSim, act: ClientAction) {
  const { combat, blocks, match, pickups, throws, transport } = deps;
  if (!act || typeof act !== 'object' || typeof act.type !== 'string') return;
  const now = performance.now() / 1000;
  const st = rc.sim.state;
  const plausibleEye = (eye: unknown): eye is [number, number, number] => isVec3(eye) && eyeNear(eye, st.pos, rc.target.up, st.vel);

  if (act.type === 'select_slot') {
    const w = act.weapon;
    if (isWeaponId(w) && (w === 'fists' || rc.weapons.owned[w]) && w !== rc.weapons.current) {
      rc.weapons.current = w;
      clearReloadState(rc);
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
    if (!isWeaponId(w) || (w !== 'fists' && !rc.weapons.owned[w]) || w !== rc.weapons.current) { rc.dirtySync = true; return; }
    if (!plausibleEye(act.origin) || !isDir(act.dir)) { rc.dirtySync = true; return; }
    const chargeT = w === 'crossbow' ? clampNum(act.chargeT, 0, MAX_CHARGE_T) : 0;
    if (w === 'crossbow') {
      if (now < rc.crossbowReadyAt) return;
      if (rc.weapons.reserve.crossbow > 0) rc.weapons.reserve.crossbow--;
      rc.weapons.ammo.crossbow = 1;
      rc.crossbowReadyAt = now + crossbowSpec(chargeT).reload * 0.8;
    } else {
      if (rc.reloadT > 0 && rc.reloadW === w) {
        const elapsed = rc.reloadTotal - rc.reloadT;
        if (w === 'shotgun' && (rc.weapons.ammo.shotgun > 0 || elapsed >= 0.4)) {
          if (rc.weapons.ammo.shotgun <= 0) {
            rc.weapons.ammo.shotgun = 1;
            if (rc.weapons.reserve.shotgun > 0) rc.weapons.reserve.shotgun--;
          }
          clearReloadState(rc);
        } else if (rc.reloadTotal > 0 && elapsed >= rc.reloadTotal * 0.55) {
          finishRemoteReload(rc);
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
    deps.remotePlayers.triggerFire(rc.peerId);
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
    deps.remotePlayers.triggerKick(rc.peerId);
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
    handleClientInteract(deps, rc, act, pickups);
  } else if (act.type === 'chat') {
    if (typeof act.text !== 'string' || !rc.limiter.allow('chat', 0.4, now)) return;
    const text = act.text.replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!text) return;
    transport.broadcast({ kind: 'event', data: { type: 'chat', sender: rc.name, team: rc.team, text } });
    deps.onChat?.(rc.name, text, rc.team);
  }
}
