import { Quaternion, Vector3 } from 'three';
import { PMoveClient } from '../../src/client/net/pmoveClient';
import { EntitySnapshotEntry, INTERP_DELAY_MS, sampleEntityInterpolation } from '../../src/client/net/remotePlayerManager';
import { BlockSystem, piecePlan } from '../../src/shared/blocks';
import { Combat, MAX_HP, Target } from '../../src/shared/combat';
import { TICK_DT, WORLD } from '../../src/shared/constants';
import { Pickups } from '../../src/shared/economy';
import {
  canSeatPlayer, defaultLobby, firstFreeSeat, humanTeams, sanitizeLocalLobby, seatPlayer,
} from '../../src/shared/lobby';
import { Match } from '../../src/shared/match';
import {
  capturePMoveState, IN_DUCK, IN_JUMP, IN_SPEED, sanitizeUserCommand, SimulateMovement,
} from '../../src/shared/net/pmove';
import { peerIdToRoom, roomToPeerId } from '../../src/shared/net/protocol';
import {
  clampNum, cleanBuildPlace, EYE_SLACK, eyeNear, fireInterval, isDir, isItemId, isPieceVariant, isQuat, isVec3,
  isWeaponId, MIN_FISH_INTERVAL, nearPond, RateLimiter,
} from '../../src/shared/net/validate';
import { buildPhysicsWorld } from '../../src/shared/physics';
import { PlayerSim } from '../../src/shared/sim';
import { TEAMS } from '../../src/shared/teams';
import { WEAPONS } from '../../src/shared/weapons';
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
}
