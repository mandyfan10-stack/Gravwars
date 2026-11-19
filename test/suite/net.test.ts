import { Quaternion, Vector3 } from 'three';
import { HostSnapshotBuilder } from '../../src/client/net/netHostSnapshot';
import { playRemoteGunAudio } from '../../src/client/net/netTypes';
import { PMoveClient } from '../../src/client/net/pmoveClient';
import { EntitySnapshotEntry, INTERP_DELAY_MS, sampleEntityInterpolation } from '../../src/client/net/remotePlayerManager';
import { BlockSystem, piecePlan } from '../../src/shared/blocks';
import { Combat, MAX_HP, Target } from '../../src/shared/combat';
import { TICK_DT, WORLD } from '../../src/shared/constants';
import { Economy, Pickups, SHOP } from '../../src/shared/economy';
import {
  canSeatPlayer, defaultLobby, firstFreeSeat, humanTeams, sanitizeLocalLobby, seatPlayer,
} from '../../src/shared/lobby';
import { Match } from '../../src/shared/match';
import {
  applyRemoteClientJetpackEvents, syncRemoteClientJetpack, wireRemoteClientArmor,
} from '../../src/shared/net/hostGear';
import {
  capturePMoveState, IN_DUCK, IN_JUMP, IN_SPEED, sanitizeUserCommand, SimulateMovement,
} from '../../src/shared/net/pmove';
import { peerIdToRoom, roomToPeerId } from '../../src/shared/net/protocol';
import {
  ENTITY_FAR_STRIDE, ENTITY_FULL_RESYNC_TICKS, ENTITY_NEAR_DIST, ENTITY_NEAR_STRIDE,
  q1, q3, qQuat, qVec3, SnapshotScheduler,
} from '../../src/shared/net/snapshot';
import {
  clampNum, cleanBuildPlace, EYE_SLACK, eyeNear, fireInterval, isDir, isItemId, isPieceVariant, isQuat, isVec3,
  isWeaponId, MIN_FISH_INTERVAL, nearPond, RateLimiter,
} from '../../src/shared/net/validate';
import { buildPhysicsWorld } from '../../src/shared/physics';
import { JETPACK, PlayerSim } from '../../src/shared/sim';
import { TEAMS } from '../../src/shared/teams';
import { createWeaponState, giveWeapon, totalFuelAmmo, WEAPONS } from '../../src/shared/weapons';
import type { SimHarness } from '../harness';

export function runNetTests(h: SimHarness) {
  const { R, map, check } = h;

  // P2P & co-op helpers: room ID parsing, lobby seat locking, symmetric bed forts, co-op/1v1 elimination, visualOnly & delta sync
  {
    check('roomToPeerId strips GW- prefixes without corrupting 5-char GW* room codes',
      roomToPeerId('gw-abcde') === 'gw-room-ABCDE'
      && roomToPeerId('GW_4KP2Z') === 'gw-room-4KP2Z'
      && roomToPeerId('  gw 99xyz  ') === 'gw-room-99XYZ'
      && roomToPeerId('GW4KP') === 'gw-room-GW4KP'
      && roomToPeerId('GW4KP2') === 'gw-room-4KP2'
      && roomToPeerId('gw-room-xy93m') === 'gw-room-XY93M'
      && peerIdToRoom('gw-room-GW4KP') === 'GW4KP');

    const lc = defaultLobby('normal');
    seatPlayer(lc, 'red', 0, 'host', 'Host');
    const s1 = firstFreeSeat(lc)!;
    check('lobby seating helpers track humanTeams, lock occupied seats, and find free slots',
      humanTeams(lc).join() === 'red'
      && !canSeatPlayer(lc, 'red', 0, 'p1')
      && canSeatPlayer(lc, 'red', 0, 'host')
      && s1.team === 'blue' && s1.seatIndex === 2);
    seatPlayer(lc, s1.team, s1.seatIndex, 'p1', 'Alice');
    check('humanTeams updates when remote player seats on another team', humanTeams(lc).join() === 'red,blue');
    // Fill every remaining empty + bot seat across all 5×5 seats (1 host + 1 Alice already seated → 23 left)
    let nextSeat = firstFreeSeat(lc);
    let steps = 0;
    while (nextSeat && steps < 30) {
      seatPlayer(lc, nextSeat.team, nextSeat.seatIndex, `p${steps + 2}`, `P${steps + 2}`);
      nextSeat = firstFreeSeat(lc);
      steps++;
    }
    check('firstFreeSeat returns null once all seats belong to humans', nextSeat === null && steps === TEAMS.length * 5 - 2);

    const sanitized = sanitizeLocalLobby(lc, 'p1');
    const remainingPlayers = Object.values(sanitized.seats).flat().filter((s) => s?.kind === 'player');
    check('sanitizeLocalLobby strips stale remote players and keeps only local player seat without network id',
      remainingPlayers.length === 1 && sanitized.seats.blue[2]?.kind === 'player' && !sanitized.seats.blue[2].id);

    // Match fortifySkipTeams + 2v2 co-op & 1v1 0-bot elimination
    const fw1 = buildPhysicsWorld(R, map);
    const bsSkip = new BlockSystem(R, fw1);
    const mCoop = new Match(R, fw1, map, bsSkip, 'red', undefined, ['red', 'blue']);
    const teamBlocks = (tm: string) => [...bsSkip.blocks.values()].filter((b) => b.team === tm).length;
    check('fortifySkipTeams skips all human teams while keeping bot crystal forts',
      teamBlocks('red') === 0 && teamBlocks('blue') === 0 && teamBlocks('green') > 0 && teamBlocks('yellow') > 0,
      `r=${teamBlocks('red')} b=${teamBlocks('blue')} g=${teamBlocks('green')} y=${teamBlocks('yellow')}`);

    let teammateAlive = 1;
    mCoop.membersAlive = (tm) => (tm === 'red' ? teammateAlive : tm === 'blue' ? 1 : 0);
    mCoop.destroyBed('green');
    mCoop.destroyBed('yellow');
    mCoop.destroyBed('red');
    mCoop.checkCoopEliminated(false);
    const stayedAliveForPartner = mCoop.result === null;
    teammateAlive = 0;
    mCoop.checkCoopEliminated(false);
    check('co-op team stays in match while partner lives and loses once last human falls',
      stayedAliveForPartner && mCoop.result === 'lose' && mCoop.events.some((e) => e.type === 'lose'));

    const fw2 = buildPhysicsWorld(R, map);
    const bsSolo = new BlockSystem(R, fw2);
    const m1v1 = new Match(R, fw2, map, bsSolo, 'red', undefined, ['red', 'blue']);
    let enemyAlive = 1;
    m1v1.membersAlive = (tm) => (tm === 'blue' ? enemyAlive : 0);
    for (const t of TEAMS) if (t.id !== 'red') m1v1.destroyBed(t.id);
    const waitLastEnemy = !m1v1.isOut('blue') && m1v1.result === null;
    enemyAlive = 0;
    m1v1.tick(TICK_DT, new Vector3());
    check('1v1 without bots waits for last enemy player death before ending',
      waitLastEnemy && m1v1.isOut('blue') && m1v1.result === 'win');

    // Combat.visualOnly + BlockSystem.syncDamageAtPos + Pickups.applySync
    const vw = new R.World({ x: 0, y: 0, z: 0 });
    vw.createCollider(R.ColliderDesc.cuboid(60, 1, 60).setTranslation(0, -1, 0));
    vw.createCollider(R.ColliderDesc.cuboid(10, 10, 0.5).setTranslation(0, 10, -20));
    vw.step();
    const bVis = new BlockSystem(R, vw);
    const blk = bVis.add(new Vector3(0, 1.5, -10), 'wood', 'blue', false);
    const blkHp0 = blk.hp;
    const cVis = new Combat(R, vw, map);
    cVis.visualOnly = true;
    cVis.windMul = 0;
    const Yvis = new Vector3(0, 1, 0);
    const vTarget: Target = {
      id: 1, team: 'blue', center: new Vector3(0, 1, -6), up: Yvis,
      hp: MAX_HP, alive: true, respawnIn: -1,
    };
    let crystalHits = 0;
    cVis.targets.push(
      { id: 0, team: 'red', center: new Vector3(0, 1, 0), up: Yvis, hp: MAX_HP, alive: true, respawnIn: -1 },
      vTarget,
    );
    cVis.crystals = [{ team: 'blue', pos: new Vector3(0, 1, -3), up: Yvis, alive: true }];
    cVis.onCrystal = () => { crystalHits++; };
    cVis.onWorldDamage = (h2d, d) => bVis.damageCollider(h2d, d);
    cVis.onExplosion = (pos, r, dmg) => bVis.explosion(pos, r, dmg);
    cVis.fire('rifle', 0, new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(), Yvis.clone().negate());
    cVis.fire('rocket', 0, new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(), Yvis.clone().negate());
    cVis.melee('fists', 0, new Vector3(0, 1, -1.5), new Vector3(0, 0, -1));
    for (let k = 0; k < 64; k++) cVis.tick(TICK_DT);
    const noLocalExplode = !cVis.events.some((e) => e.type === 'explode');
    cVis.visualExplode(new Vector3(0, 1, -10), 4);
    check('Combat.visualOnly skips authoritative damage while supporting visualExplode',
      vTarget.hp === MAX_HP && vTarget.alive && blk.hp === blkHp0 && crystalHits === 0
      && noLocalExplode && cVis.events.some((e) => e.type === 'explode'));

    let broke = 0;
    const blkPos = blk.center.clone();
    bVis.onBreak = () => { broke++; };
    const dmgOk = bVis.syncDamageAtPos(blkPos, blkHp0 - 15);
    const midHp = blk.hp;
    const breakOk = bVis.syncDamageAtPos(blkPos, 0);
    const missingOk = bVis.syncDamageAtPos(blkPos, 10);
    check('BlockSystem.syncDamageAtPos updates HP and breaks collider on 0 HP',
      dmgOk && midHp === blkHp0 - 15 && breakOk && broke === 1 && bVis.findByPos(blkPos) === null && !missingOk);

    const pk = new Pickups(R, vw, map);
    const ver0 = pk.version;
    pk.applySync([{ id: 901, kind: 'cash', amount: 42, once: true, pos: [1, 1, 1], up: [0, 1, 0], alive: true }]);
    const synced = pk.items[0];
    pk.applySync([{ id: 901, kind: 'cash', amount: 42, once: true, pos: [2, 1, 2], up: [0, 1, 0], alive: false }]);
    check('Pickups.applySync replaces list, reuses items by ID, and bumps version',
      pk.version >= ver0 + 2 && pk.items.length === 1 && pk.items[0] === synced
      && synced.pos.x === 2 && !synced.alive);
  }

  // GoldSrc / Source PMove: UserCommand anti-speedhack normalization, deterministic replay & 100ms Entity Interpolation
  {
    const hacked = sanitizeUserCommand({
      tick: 5,
      forwardmove: 50,
      sidemove: -50,
      upmove: 99,
      viewangles: [0.5, 99],
      buttons: IN_JUMP | IN_SPEED | (1 << 30),
    });
    const mag = Math.hypot(hacked.forwardmove, hacked.sidemove);
    check('sanitizeUserCommand normalizes anti-speedhack vectors and clamps pitch/buttons',
      Math.abs(mag - 1) < 1e-5 && hacked.upmove === 1 && hacked.viewangles[1] < Math.PI / 2
      && hacked.buttons === (IN_JUMP | IN_SPEED));

    // Deterministic parity & Client Reconciliation Replay
    const wClient = buildPhysicsWorld(R, map);
    const wServer = buildPhysicsWorld(R, map);
    const cSim = new PlayerSim(R, wClient, map, 'red');
    const sSim = new PlayerSim(R, wServer, map, 'red');
    cSim.surfaces = sSim.surfaces = false;
    cSim.state.pos.set(0, 1.0, 0);
    sSim.state.pos.set(0, 1.0, 0);
    cSim.state.vel.set(0, 0, 0);
    sSim.state.vel.set(0, 0, 0);
    cSim.mover.place(cSim.state);
    sSim.mover.place(sSim.state);

    const pm = new PMoveClient();
    let serverTick10State = capturePMoveState(sSim, 0);
    for (let t = 1; t <= 20; t++) {
      const raw = {
        forwardmove: 1,
        sidemove: t > 8 ? 0.5 : 0,
        upmove: 0,
        viewangles: [0.2, 0] as [number, number],
        buttons: (t === 5 ? IN_JUMP : 0) | IN_SPEED | (t > 14 ? IN_DUCK : 0),
      };
      const cmd = pm.predictStep(cSim, raw, TICK_DT);
      // Simulate server knockback/shove at tick 10 so client predicted state diverges cleanly from server
      if (t === 10) sSim.state.pos.x += 1.5;
      sSim.mover.place(sSim.state);
      SimulateMovement(sSim, cmd, TICK_DT);
      if (t === 10) serverTick10State = capturePMoveState(sSim, 10);
    }
    const divergeBefore = cSim.state.pos.distanceTo(sSim.state.pos);
    const rec = pm.reconcile(cSim, serverTick10State, TICK_DT);
    const errorAfterReplay = cSim.state.pos.distanceTo(sSim.state.pos);
    check('PMove reconciliation resets to server tick 10 and replays queued UserCommands identically to server at tick 20',
      rec.corrected && rec.replayedCount === 10 && divergeBefore > 1.0 && errorAfterReplay < 0.02,
      `diverge=${divergeBefore.toFixed(2)}m afterReplay=${errorAfterReplay.toFixed(4)}m replayed=${rec.replayedCount}`);

    // Entity Interpolation Buffer (100ms behind server stream)
    const buf: EntitySnapshotEntry[] = [
      { timeMs: 1000, pos: new Vector3(0, 0, 0), vel: new Vector3(10, 0, 0), frame: new Quaternion(), yaw: Math.PI - 0.2, pitch: 0 },
      { timeMs: 1040, pos: new Vector3(10, 0, 0), vel: new Vector3(10, 0, 0), frame: new Quaternion(), yaw: -Math.PI + 0.2, pitch: 0 },
      { timeMs: 1080, pos: new Vector3(60, 0, 0), vel: new Vector3(0, 0, 0), frame: new Quaternion(), yaw: 0, pitch: 0 }, // >18m teleport
    ];
    const outP = new Vector3();
    const outF = new Quaternion();
    const resMid = sampleEntityInterpolation(buf, 1120 - INTERP_DELAY_MS, outP, outF);
    const errPosMid = Math.abs(outP.x - 5.0);
    // Shortest angular lerp across ±pi at midpoint should pass right through Math.PI (abs ≈ PI)
    const wrappedPi = Math.abs(Math.abs(resMid.yaw) - Math.PI) < 0.01;
    const outTp = new Vector3();
    sampleEntityInterpolation(buf, 1160 - INTERP_DELAY_MS, outTp, outF); // halfway into teleport interval [1040..1080]
    check('Entity interpolation lerps cleanly with 100ms delay, wraps angles across ±pi, and snaps on teleports',
      INTERP_DELAY_MS === 100 && errPosMid < 0.01 && wrappedPi && outTp.x === 60,
      `midX=${outP.x.toFixed(2)} yaw=${resMid.yaw.toFixed(2)} tpX=${outTp.x.toFixed(1)}`);
  }

  // Host-side validation of untrusted P2P client packets (anti-cheat / crash guards)
  {
    check('validate: vectors reject NaN / Infinity / wrong length / absurd coordinates',
      isVec3([1, 2, 3]) && !isVec3([NaN, 0, 0]) && !isVec3([0, Infinity, 0]) && !isVec3([1, 2]) && !isVec3('1,2,3')
      && !isVec3([0, 0, 1e7]) && isDir([0, 0, 1]) && !isDir([0, 0, 0]) && isQuat([0, 0, 0, 1]) && !isQuat([0, 0, 0, 5]));

    check('validate: input clamp turns NaN into the fallback instead of passing it to physics',
      clampNum(NaN, -1, 1) === 0 && clampNum(5, -1, 1) === 1 && clampNum(-Infinity, -1, 1, 0.3) === 0.3
      && clampNum('1' as unknown, -1, 1) === 0 && clampNum(0.5, -1, 1) === 0.5);

    const up = new Vector3(0, 1, 0);
    const pos = new Vector3(10, -120, 5);
    const still = new Vector3();
    const eye = (dx: number): [number, number, number] => [pos.x + dx, pos.y + 0.71, pos.z];
    check('validate: shot / kick / hook origin must sit at the host-side player; slack grows with speed',
      eyeNear(eye(0), pos, up, still) && eyeNear(eye(EYE_SLACK - 0.1), pos, up, still)
      && !eyeNear(eye(EYE_SLACK + 0.5), pos, up, still) && !eyeNear(eye(80), pos, up, still)
      && eyeNear(eye(EYE_SLACK + 3), pos, up, new Vector3(12, 0, 0)));

    // every legit piece the client can build must pass, with the exact host-side size
    const legit = (['wall', 'floor', 'ramp'] as const).map((k) => piecePlan(k, up, 'x', 1, 9, 2.25, -WORLD.cubeHalf));
    const asAct = (p: { kind: string; center: Vector3; half: Vector3; quat: Quaternion; key: string; level: number }, extra: Record<string, unknown> = {}) => ({
      kind: p.kind, center: [p.center.x, p.center.y, p.center.z], half: [p.half.x, p.half.y, p.half.z],
      quat: [p.quat.x, p.quat.y, p.quat.z, p.quat.w], material: 'wood', key: p.key, level: p.level, ...extra,
    });
    const block = { kind: 'block', center: new Vector3(3.5, -125.5, 3.5), half: new Vector3(0.5, 0.5, 0.5), quat: new Quaternion(), key: 'b:1', level: 0 };
    const okAll = [...legit, block].every((p) => cleanBuildPlace(asAct(p)) !== null)
      && cleanBuildPlace(asAct(legit[0], { variant: 'door' }))?.variant === 'door'
      && cleanBuildPlace(asAct(legit[0], { variant: 'hole' }))?.variant === 'hole';
    check('validate: legit walls / floors / ramps / variants / 1x1 blocks pass build validation', okAll);

    const badMat = cleanBuildPlace(asAct(block, { material: 'xxx' }));
    const protoMat = cleanBuildPlace(asAct(block, { material: '__proto__' }));
    const badKind = cleanBuildPlace(asAct(block, { kind: 'mega' }));
    const badVar = cleanBuildPlace(asAct(block, { variant: 'hacked' }));
    const hugeWall = cleanBuildPlace(asAct(legit[0], { half: [50, 50, 50] }));
    const nanCenter = cleanBuildPlace(asAct(block, { center: [NaN, 0, 0] }));
    const badQuat = cleanBuildPlace(asAct(block, { quat: [0, 0, 0, 0] }));
    const longKey = cleanBuildPlace(asAct(block, { key: 'k'.repeat(500) }));
    check('validate: unknown material / variant, unknown kind, giant pieces, NaN, bad quat and huge keys are rejected',
      !badMat && !protoMat && !badKind && !badVar && !hugeWall && !nanCenter && !badQuat && !longKey && isPieceVariant('door'));

    const lim = new RateLimiter(3, 0.8);
    let burst = 0;
    for (let i = 0; i < 50; i++) if (lim.allow('fire:pistol', fireInterval('pistol'), 1)) burst++;
    let sustained = 0;
    for (let t = 0; t < 10; t += 0.001) if (lim.allow('fire:fists', fireInterval('fists'), 100 + t)) sustained++;
    const maxSustained = 3 + Math.ceil(10 / (WEAPONS.fists.interval * 0.8));
    let legitRifle = 0;
    for (let i = 0; i < 30; i++) if (lim.allow('fire:rifle', fireInterval('rifle'), 200 + i * WEAPONS.rifle.interval)) legitRifle++;
    check('validate: fire rate limiter blocks spam but lets a legit full-auto magazine through',
      burst === 3 && sustained <= maxSustained && legitRifle === 30,
      `burst=${burst} sustained=${sustained}/${maxSustained} rifle=${legitRifle}/30`);

    check('validate: weapon and item ids are whitelisted',
      isWeaponId('rifle') && isWeaponId('revolver') && isWeaponId('fists') && !isWeaponId('toString') && !isWeaponId('laser') && !isWeaponId(5)
      && isItemId('apple') && isItemId('fish') && isItemId('medkit') && !isItemId('toString') && !isItemId('gold')
      && fireInterval('crossbow') <= 0.375);

    const pond = map.ponds[0];
    const atPond = new Vector3(...pond.pos);
    check('validate: a fish catch only counts near a pond and no faster than a full cast cycle',
      nearPond(atPond, map.ponds) && !nearPond(new Vector3(0, 400, 0), map.ponds) && MIN_FISH_INTERVAL >= 2.5);
  }

  // P2P v0.3 regressions: remote client armor, jetpack flight/fuel/overheat, revolver audio, maxHp & snapshot optimization
  {
    const w = buildPhysicsWorld(R, map);
    const sim = new PlayerSim(R, w, map, 'blue');
    const combat = new Combat(R, w, map, [sim.mover.collider]);
    const weapons = createWeaponState();
    const wallet = { cash: 100, crystal: 50 };
    const inv = { wood: 16, stone: 0, metal: 0 };
    const eco = new Economy(wallet, { inventory: inv }, weapons);
    const target: Target = {
      id: 2001, team: 'blue', center: sim.state.pos, up: new Vector3(0, 1, 0),
      vel: sim.state.vel, hp: 180, maxHp: 180, alive: true, respawnIn: -1, isHuman: true,
    };
    combat.targets.push(target);
    const rc = {
      sim, target, weapons, eco, team: 'blue' as const,
      dirtySync: false,
      pendingNotice: undefined as { text: string; color: string } | undefined,
    };
    wireRemoteClientArmor(rc);

    const armorItem = SHOP.find((s) => s.id === 'armor')!;
    const buyArmorRes = eco.buy(armorItem);
    const armorActiveAfterBuy = target.armor === true && rc.dirtySync;
    rc.dirtySync = false;
    combat.damage(target, 999, 0, false, sim.state.pos, { raw: true, noPush: true });
    check('p2p host: remote client armor activates on purchase and saves from lethal damage',
      buyArmorRes === 'ok' && armorActiveAfterBuy && target.alive && target.hp === 90
      && !target.armor && !eco.has('armor') && rc.dirtySync && !!rc.pendingNotice,
      `hp=${target.hp} armor=${target.armor}`);

    // Jetpack flight, fuel drain, and overheat explosion on host remote client sim
    const jpItem = SHOP.find((s) => s.id === 'jetpack')!;
    eco.buy(jpItem);
    giveWeapon(weapons, 'pistol', 15);
    weapons.reserve.pistol = 60; // enough fuel for >12s continuous flight (48 rounds)
    const fuelBefore = totalFuelAmmo(weapons);
    sim.surfaces = false;
    sim.state.pos.set(0, -110, 0);
    sim.state.vel.set(0, 0, 0);
    sim.state.onGround = false;
    sim.state.jumpHold = 0;
    sim.mover.place(sim.state);
    let fuelEvents = 0;
    let exploded = false;
    const cmd = { tick: 1, forwardmove: 0, sidemove: 0, upmove: 0, viewangles: [0, 0.8] as [number, number], buttons: IN_JUMP };
    for (let k = 0; k < Math.ceil((JETPACK.maxFlight + 0.5) / TICK_DT); k++) {
      cmd.tick = k + 1;
      syncRemoteClientJetpack(rc);
      SimulateMovement(sim, cmd, TICK_DT);
      for (const ev of sim.events.splice(0)) {
        if (ev.type === 'jetpackFuel') fuelEvents++;
        if (ev.type === 'jetpackExplode') exploded = true;
        applyRemoteClientJetpackEvents(rc, ev, combat);
      }
      if (exploded) break;
    }
    const fuelAfter = totalFuelAmmo(weapons);
    check('p2p host: remote client jetpack flies, consumes fuel, and triggers overheat explosion',
      fuelEvents >= 40 && fuelAfter < fuelBefore && exploded && target.hp < 90
      && combat.events.some((e) => e.type === 'explode'),
      `fuel=${fuelBefore}->${fuelAfter} hp=${target.hp}`);

    // Remote gun audio includes revolver and forwards crossbow charge
    const calls: string[] = [];
    const fakeDeps = {
      camera: { position: new Vector3(0, 0, 0) } as never,
      audio: {
        shotgun: (d: number) => calls.push(`shotgun:${d.toFixed(0)}`),
        revolver: (d: number) => calls.push(`revolver:${d.toFixed(0)}`),
        rocket: (d: number) => calls.push(`rocket:${d.toFixed(0)}`),
        crossbowShot: (c: number, d: number) => calls.push(`crossbow:${c.toFixed(1)}:${d.toFixed(0)}`),
        shot: (p: boolean, d: number) => calls.push(`${p ? 'pistol' : 'rifle'}:${d.toFixed(0)}`),
      } as never,
    };
    playRemoteGunAudio('revolver', new Vector3(10, 0, 0), fakeDeps);
    playRemoteGunAudio('crossbow', new Vector3(5, 0, 0), fakeDeps, 2.5);
    check('p2p audio: playRemoteGunAudio plays revolver and forwards crossbow charge level',
      calls[0] === 'revolver:10' && calls[1] === 'crossbow:2.5:5', calls.join(', '));

    // Snapshot quantization & SnapshotScheduler relevancy / rate throttling
    const qv = qVec3(1.2345678, -9.8765432, NaN);
    const qq = qQuat(0.123456, 0, 0, 0.992351);
    check('snapshot quantization rounds vectors, quaternions, and scalars safely',
      qv[0] === 1.235 && qv[1] === -9.877 && qv[2] === 0 && qq[0] === 0.1235 && qq[3] === 0.9924
      && q1(99.94) === 99.9 && q3(0.1234) === 0.123);

    const sched = new SnapshotScheduler();
    const obs: [number, number, number][] = [[0, 0, 0]];
    let nearCount = 0, farCount = 0, deadCount = 0, urgentCount = 0;
    for (let tick = 1; tick <= ENTITY_FULL_RESYNC_TICKS; tick++) {
      if (sched.shouldSend('npc', 1, true, false, [10, 0, 0], obs, tick)) nearCount++;
      if (sched.shouldSend('npc', 2, true, false, [ENTITY_NEAR_DIST + 50, 0, 0], obs, tick)) farCount++;
      if (sched.shouldSend('npc', 3, tick <= 2, false, [10, 0, 0], obs, tick)) deadCount++;
      if (sched.shouldSend('car', 4, true, true, [ENTITY_NEAR_DIST + 80, 0, 0], obs, tick)) urgentCount++;
    }
    check('SnapshotScheduler throttles near/far entities, suppresses dead repeats, and keeps urgent entities at full rate',
      nearCount < ENTITY_FULL_RESYNC_TICKS && farCount < nearCount
      && nearCount <= Math.ceil(ENTITY_FULL_RESYNC_TICKS / ENTITY_NEAR_STRIDE) + 2
      && farCount <= Math.ceil(ENTITY_FULL_RESYNC_TICKS / ENTITY_FAR_STRIDE) + 2
      && deadCount <= 4 && urgentCount === ENTITY_FULL_RESYNC_TICKS,
      `near=${nearCount} far=${farCount} dead=${deadCount} urgent=${urgentCount}`);

    // HostSnapshotBuilder preserves scaled maxHp and marks routine snapshots as unreliable/fast
    const sb = new HostSnapshotBuilder();
    const bs = new BlockSystem(R, w);
    const m = new Match(R, w, map, bs, 'red');
    const pk = new Pickups(R, w, map);
    const dummyDeps = {
      sim,
      player: { me: { hp: 160, maxHp: 200, alive: true }, weapons },
      match: m,
      map,
      bots: { bots: [] },
      npcs: { npcs: [], cars: [] },
      pickups: pk,
      props: { consumeNetDirty: () => [] },
      combat,
    } as never;
    const rcMap = new Map([['peer-1', {
      peerId: 'peer-1', name: 'Guest', team: 'blue' as const, sim, target, weapons,
      yaw: 0, pitch: 0, firing: false, out: false, disconnected: false, lastSeq: 1, lastTick: 1,
    } as never]]);
    const first = sb.build(dummyDeps, 'host', 'red', false, new Map(), rcMap);
    const second = sb.build(dummyDeps, 'host', 'red', false, new Map(), rcMap);
    pk.version++;
    const third = sb.build(dummyDeps, 'host', 'red', false, new Map(), rcMap);
    check('HostSnapshotBuilder preserves custom maxHp and routes routine snapshots over fast channel',
      first.reliable === true && second.reliable === false && third.reliable === true
      && first.players[0].maxHp === 200 && first.players[1].maxHp === 180,
      `rel=${first.reliable},${second.reliable},${third.reliable} maxHp=${first.players[0].maxHp}/${first.players[1].maxHp}`);
  }
}
