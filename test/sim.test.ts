/* Headless checks of the shared simulation: run with `npm test`. */
import { Quaternion, Vector3 } from 'three';
import {
  BLOCK_MATERIALS, BlockSystem, BRIDGE_COST, PIECE_CELL, PIECE_COST, PIECE_HP_MUL, PIECE_LEVEL, PIECE_THICK, START_BLOCKS,
} from '../src/shared/blocks';
import { applyDifficulty, BOT, BotManager } from '../src/shared/bots';
import { activeTeams, botRoster, defaultLobby, lobbyProblem, parseLobby, playerTeam, seatPlayer } from '../src/shared/lobby';
import { GENERATORS, Match } from '../src/shared/match';
import { APPLE_HEAL, BUILDER_WOOD, Economy, ITEMS, MAX_MEDKITS, Pickups, PICKUPS, SHOP } from '../src/shared/economy';
import { holdables, Hotbar } from '../src/shared/inventory';
import { THROW, Throws } from '../src/shared/throwables';
import { Fishing, FISHING } from '../src/shared/fishing';
import { lobDirection, NPC, Npc, NpcManager } from '../src/shared/npcs';
import { upOf } from '../src/shared/math';
import { moveBasis } from '../src/shared/movement';
import { DEFAULT_MOVEMENT, HU, TICK_DT, WORLD } from '../src/shared/constants';
import { faceOfTeam, generateMap, HALL_H, HALL_HALF, SW, TILE, XZ } from '../src/shared/map';
import { CROUCH_SPEED, emptyInput, MoveInput, SPRINT_SPEED, STAMINA } from '../src/shared/movement';
import { buildPhysicsWorld, initRapier } from '../src/shared/physics';
import { PlayerSim } from '../src/shared/sim';
import { TEAMS } from '../src/shared/teams';

const R = await initRapier();
const map = generateMap();
const world = buildPhysicsWorld(R, map);
const sim = new PlayerSim(R, world, map, 'red');
const s = sim.state;
/** Ground of the red face: the player's team always gets the -Y face, its frame is the world frame shifted down. */
const G = -WORLD.cubeHalf;
const RED = faceOfTeam(map, 'red')!.id;
/** Centre line of the road east of the hall tile (no parked cars around the hall, no barrier where it meets the rim). */
const RX = TILE / 2;

let failed = 0;
function check(name: string, ok: boolean, info = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`);
  if (!ok) failed++;
}
function run(ticks: number, input: Partial<MoveInput> | ((i: number) => Partial<MoveInput>)) {
  for (let i = 0; i < ticks; i++) {
    const inp = { ...emptyInput(), yaw: s.yaw, pitch: s.pitch, ...(typeof input === 'function' ? input(i) : input) };
    sim.tick(inp, TICK_DT);
  }
}
const planarSpeed = () => {
  const up = new Vector3(0, 1, 0).applyQuaternion(s.frame);
  return s.vel.clone().addScaledVector(up, -s.vel.dot(up)).length();
};
function place(x: number, y: number, z: number, yaw = 0) {
  s.pos.set(x, y, z);
  s.vel.set(0, 0, 0);
  s.frame.identity();
  s.yaw = yaw;
  s.onGround = false;
  sim.mover.place(s);
}

// 1. spawn & stand: inside the base hall (the centre tile of the face)
run(64, {});
check('spawns inside the base hall', s.onGround && Math.abs(s.pos.y - (G + SW + 0.915)) < 0.1 && Math.abs(s.pos.z) < HALL_HALF && Math.abs(s.pos.x) < HALL_HALF,
  `pos=${s.pos.toArray().map((v) => v.toFixed(2))}`);

// 2. walk speed (along the road x = RX)
place(RX, G + 1, 20, 0);
run(30, {});
run(128, { forward: 1 });
check('ground speed ≈ maxSpeed', Math.abs(planarSpeed() - 300 * HU) < 0.05, `${(planarSpeed() / HU).toFixed(0)} u/s`);
run(128, { forward: 1, crouch: true });
check('crouch: slow walk', Math.abs(planarSpeed() - 300 * HU * CROUCH_SPEED) < 0.05 && s.crouched, `${(planarSpeed() / HU).toFixed(0)} u/s`);
run(10, {});
check('stand up again', !s.crouched);
// sprint: faster, runs dry after STAMINA.max seconds, refills after a rest
{
  place(RX, G + 1, -45, Math.PI); // the road x = RX, running towards +z
  run(30, {});
  s.stamina = STAMINA.max; s.exhausted = false;
  run(64, { forward: 1, sprint: true });
  const fast = planarSpeed();
  check('sprint is faster', Math.abs(fast - 300 * HU * SPRINT_SPEED) < 0.1 && s.sprinting, `${(fast / HU).toFixed(0)} u/s`);
  s.stamina = 0.5; // nearly dry (the road is not 60 m long)
  run(40, { forward: 1, sprint: true });
  const dry = planarSpeed();
  check('sprint stops when stamina runs out', s.exhausted && !s.sprinting && Math.abs(dry - 300 * HU) < 0.1, `${(dry / HU).toFixed(0)} u/s`);
  run(64 * 2, {});
  check('stamina refills after a rest, sprint allowed again', s.stamina > STAMINA.restart && !s.exhausted, `st=${s.stamina.toFixed(2)}`);
  check('8 seconds of sprint when full', STAMINA.max === 8);
}
// coyote time: a jump right after running off an edge still works, a late one does not
const airJump = (airT: number) => {
  place(0, -50, 0, 0); // mid-air inside the cube
  s.airT = airT;
  s.jumpReleased = true;
  run(1, { jump: true });
  return s.vel.y > 3;
};
check('coyote jump just after leaving the ground', airJump(0.05) && !airJump(0.3) && !airJump(-1));

// 3. bhop + air strafe gains speed (on a big empty floor of its own)
{
  const fw = new R.World({ x: 0, y: 0, z: 0 });
  fw.createCollider(R.ColliderDesc.cuboid(400, 1, 400).setTranslation(0, -1, 0));
  fw.step();
  const fs = new PlayerSim(R, fw, map, 'red');
  fs.surfaces = false;
  const st = fs.state;
  st.pos.set(0, 1, 0); st.vel.set(0, 0, 0); st.frame.identity(); st.yaw = 0; fs.mover.place(st);
  const go = (n: number, f: () => Partial<MoveInput>) => {
    for (let i = 0; i < n; i++) fs.tick({ ...emptyInput(), yaw: st.yaw, pitch: st.pitch, ...f() }, TICK_DT);
  };
  const sp = () => Math.hypot(st.vel.x, st.vel.z);
  go(30, () => ({}));
  go(40, () => ({ forward: 1 }));
  let maxSp = 0;
  go(320, () => {
    maxSp = Math.max(maxSp, sp());
    return { jump: true, right: 1, yaw: Math.atan2(-st.vel.x, -st.vel.z) };
  });
  check('air strafe + bhop gains speed', maxSp > 500 * HU, `max ${(maxSp / HU).toFixed(0)} u/s`);
  fs.mover.dispose();
}

// 4–5. stairs (0.3 m steps) and a 50° surf wedge, in a test world of their own
{
  const pw = new R.World({ x: 0, y: 0, z: 0 });
  pw.createCollider(R.ColliderDesc.cuboid(60, 1, 60).setTranslation(0, -1, 0));
  for (let i = 0; i < 8; i++) pw.createCollider(R.ColliderDesc.cuboid(0.3, (i + 1) * 0.15, 1.5).setTranslation(-7.3 - i * 0.6, (i + 1) * 0.15, 0));
  pw.createCollider(R.ColliderDesc.cuboid(2, 1.2, 1.5).setTranslation(-13.8, 1.2, 0));
  const wedge = [[-27.5, 0, -26], [-19.5, 0, -26], [-23.5, 4.8, -26], [-27.5, 0, -6], [-19.5, 0, -6], [-23.5, 4.8, -6]];
  pw.createCollider(R.ColliderDesc.convexHull(new Float32Array(wedge.flat()))!);
  pw.step();
  const ps = new PlayerSim(R, pw, map, 'red');
  ps.surfaces = false;
  const st = ps.state;
  const put = (x: number, y: number, z: number, yaw: number) => {
    st.pos.set(x, y, z); st.vel.set(0, 0, 0); st.frame.identity(); st.yaw = yaw; st.onGround = false; ps.mover.place(st);
  };
  const go = (n: number, inp: Partial<MoveInput>) => {
    for (let i = 0; i < n; i++) ps.tick({ ...emptyInput(), yaw: st.yaw, pitch: st.pitch, ...inp }, TICK_DT);
  };
  put(-5.5, 1, 0, Math.PI / 2); // facing -X
  go(30, {});
  go(200, { forward: 1 });
  check('climbs stairs', st.pos.y > 2.1 + 0.9, `y=${st.pos.y.toFixed(2)}`);
  // surf: drop onto the slope with speed along it
  put(-21.2, 4.85, -24, 0);
  st.vel.set(0, 0, 12);
  ps.mover.place(st);
  go(70, { right: -1 });
  check('surfs (not grounded on steep ramp, keeps speed)', !st.onGround || st.vel.length() > 8, `v=${st.vel.length().toFixed(1)} y=${st.pos.y.toFixed(2)}`);
  ps.mover.dispose();
}

// 6. the hall: the east ramp (x 8.5–11.5, rising towards +z) leads up onto the roof
place(10, G + 1, -11, Math.PI);
run(64 * 5, { forward: 1 });
check('hall ramp leads onto the roof', s.onGround && s.pos.y - G > SW + HALL_H + 0.9 - 0.15, `h=${(s.pos.y - G).toFixed(2)} z=${s.pos.z.toFixed(1)}`);

// 7. the cube: six faces, a bridge lane over every edge (25 pieces, the same grid the players build on)
check('six faces, a 25-piece bridge lane over each of the 12 edges', map.faces.length === 6 && map.lanes.length === 12
  && map.lanes.every((l) => l.pieces.length === 25), `faces=${map.faces.length} lanes=${map.lanes.length}`);
const upNow = () => upOf(s.frame);
/** Yaw whose forward is closest to the world direction `d` (in the current frame). */
const yawTo = (d: Vector3) => {
  let best = 0, bd = -2;
  const f = new Vector3(), r = new Vector3();
  for (let k = 0; k < 256; k++) {
    const y = (k / 256) * Math.PI * 2;
    moveBasis(s.frame, y, f, r);
    if (f.dot(d) > bd) { bd = f.dot(d); best = y; }
  }
  return best;
};
const faceDef = (id: string) => map.faces.find((f) => f.id === id)!;
/** World point of a face-local (x, z) at height h above its ground. */
const onFace = (id: string, [x, z]: XZ, h = 0) => {
  const f = faceDef(id);
  return new Vector3(x, h, z).applyQuaternion(new Quaternion(...f.quat)).add(new Vector3(...f.origin));
};
const heightOn = (id: string) => s.pos.clone().sub(new Vector3(...faceDef(id).origin)).dot(new Vector3(...faceDef(id).up));
/** Walk to a face-local point, steering in the current gravity; stops there, on a gravity switch (`stopOnTurn`) or a respawn. */
const walkTo = (id: string, p: XZ, stopOnTurn = false, maxSec = 20) => {
  const target = onFace(id, p);
  for (let i = 0; i < 64 * maxSec; i++) {
    const u = upNow();
    const d = target.clone().sub(s.pos);
    d.addScaledVector(u, -d.dot(u));
    if (d.length() < 0.8) return 'arrived';
    sim.events.length = 0;
    run(1, { forward: 1, yaw: yawTo(d.normalize()) });
    if (sim.events.some((e) => e.type === 'respawn')) return 'respawn';
    if (stopOnTurn && sim.events.some((e) => e.type === 'gravity')) return 'turned';
  }
  return 'timeout';
};
{
  const lane = map.lanes.find((l) => l.a === RED)!;
  const A = faceDef(lane.a), B = faceDef(lane.b);
  const bs = new BlockSystem(R, world, sim.mover.collider);
  sim.gravity.blocks = () => bs.blocks.values();
  // the first plate a player builds at the bridge start is the lane's first piece, for one unit of material
  sim.respawn();
  place(...onFace(A.id, lane.pathA[0], 1).toArray());
  run(20, {});
  s.yaw = yawTo(onFace(A.id, lane.pathA[1]).sub(onFace(A.id, lane.pathA[0])).normalize());
  const fwd = new Vector3();
  moveBasis(s.frame, s.yaw, fwd, new Vector3());
  const plan = bs.plan('floor', s.pos, upNow(), fwd)!;
  check('a player\'s first bridge plate is the first piece of the lane', plan.key === lane.pieces[0].key && bs.costOf(plan) === BRIDGE_COST
    && BRIDGE_COST === 1, `${plan.key} vs ${lane.pieces[0].key}`);
  // no bridge: walking off the rim at the bridge start falls into the void
  check('walking off the rim falls into the void', walkTo(A.id, lane.pathA[1]) === 'respawn');
  for (const p of lane.pieces) bs.place({ kind: p.kind, center: new Vector3(...p.center), half: new Vector3(...p.half),
    quat: new Quaternion(...p.quat), key: p.key, level: p.level }, 'wood', 'red', true);
  // along the floors to the corner, up the ramps on the next face's wall, off the landing onto that face
  place(...onFace(A.id, lane.pathA[0], 1).toArray());
  run(20, {});
  const legs = lane.pathA.map((p, i) => walkTo(A.id, p, i === lane.pathA.length - 1));
  run(40, {});
  check(`walking the lane ${lane.id} turns the gravity onto the next face`, legs.join() === 'arrived,arrived,arrived,turned'
    && upNow().dot(new Vector3(...B.up)) > 0.99 && s.onGround && Math.abs(heightOn(B.id) - 0.915) < 0.1,
    `${legs.join()} up=${upNow().toArray().map((v) => v.toFixed(2))} h=${heightOn(B.id).toFixed(2)}`);
  // and back: from that face into the landing (gravity of the lane again), down the ramps and floors home
  const legsB = [walkTo(B.id, lane.pathB[0]), walkTo(B.id, lane.pathB[1], true)];
  const turnedBack = upNow().dot(new Vector3(...A.up)) > 0.99;
  const legsBack = lane.back.map((p) => walkTo(A.id, p));
  run(40, {});
  check('from the far face into the landing turns the gravity back, the lane leads home', legsB.join() === 'arrived,turned' && turnedBack
    && legsBack.every((l) => l === 'arrived') && upNow().y > 0.99 && s.onGround && Math.abs(s.pos.y - (G + 0.915)) < 0.1,
    `${legsB.join()} ${legsBack.join()} pos=${s.pos.toArray().map((v) => v.toFixed(2))}`);
  sim.gravity.blocks = () => [];
  for (const b of [...bs.blocks.values()]) bs.damageCollider(b.collider.handle, b.hp);
}

// 8. gravity switch to green (down +X)
place(RX, G + 1, 0, 0);
run(10, {});
sim.setGravity(new Vector3(1, 0, 0));
const up2 = new Vector3(0, 1, 0).applyQuaternion(s.frame);
check('gravity switch rotates frame', up2.x < -0.99, up2.toArray().map((v) => v.toFixed(2)).join(','));

// 9. down the road to the rim, over the kerb and off the face → void death
sim.respawn();
sim.events.length = 0;
place(RX, G + 1, -84, 0);
run(30, {});
let died = false;
run(64 * 8, () => {
  if (sim.events.some((e) => e.type === 'respawn' && e.reason === 'void')) died = true;
  sim.events.length = 0;
  return died ? {} : { forward: 1 };
});
check('stepping over the kerb and off the face falls into the void', died);

// 10. every team spawns standing in its own hall, on its own face; a team without players gets no face
for (const team of TEAMS) {
  sim.team = team;
  sim.respawn();
  run(64, {});
  const u = upNow();
  const f = faceOfTeam(map, team.id)!;
  check(`${team.id} spawns on its face`, s.onGround && u.dot(new Vector3(...f.up)) > 0.99
    && Math.abs(s.pos.dot(u) + WORLD.cubeHalf - SW - 0.915) < 0.1, `${f.id} pos=${s.pos.toArray().map((v) => v.toFixed(1))}`);
}
sim.team = TEAMS[0];
sim.respawn();
{
  const m2 = generateMap(1337, 'red', ['red', 'blue']);
  check('teams without players get no face', m2.faces.length === 6 && m2.faces.filter((f) => f.team).length === 2
    && faceOfTeam(m2, 'red')!.id === 'ny' && !m2.statues.some((q) => q.team === 'green' || q.team === 'yellow')
    && m2.lanes.length === 12 && m2.teams.join() === 'red,blue');
  check('every team face has ponds; the neutral faces have shops and the crystal generators',
    TEAMS.every((t) => map.ponds.filter((p) => p.team === t.id).length >= 2)
    && map.bases.filter((b) => b.team === '').length >= 4 && map.crystalSpots.length === 4);
}

// 11. combat: rifle hits a dummy, wind/gravity bend bullets, grenade bounces + rocket-jumps
import { Combat, DAMAGE_SCALE, MAX_HP, SPAWN_GUARD, Target } from '../src/shared/combat';
import { createWeaponState, energyLeft, giveWeapon, hasAmmo, shotSpread, weaponTick, WEAPONS } from '../src/shared/weapons';
{
  sim.team = TEAMS[0];
  sim.respawn();
  const combat = new Combat(R, world, map, [sim.mover.collider]);
  const me: Target = { id: 0, team: 'red', center: s.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1,
    onImpulse: (v) => sim.applyImpulse(v) };
  const dummy: Target = { id: 1, team: 'blue', center: new Vector3(RX, G + 1.065, -10), up: new Vector3(0, 1, 0),
    hp: MAX_HP, alive: true, respawnIn: 0 };
  combat.targets.push(me, dummy);
  // shoot from the road at the dummy 10 m ahead (aim at chest)
  place(RX, G + 1, 0, 0);
  run(30, {});
  const eye = s.pos.clone().add(new Vector3(0, 0.71, 0));
  let hits = 0;
  let killed = false;
  const scaled = (d: number) => Math.round(d * DAMAGE_SCALE * 10) / 10;
  const toKill = Math.ceil(MAX_HP / scaled(WEAPONS.rifle.damage));
  for (let i = 0; i < toKill + 2; i++) {
    const dir = dummy.center.clone().sub(eye).normalize();
    combat.fire('rifle', 0, eye, dir, s.vel, new Vector3(0, -1, 0));
    for (let k = 0; k < 20; k++) combat.tick(TICK_DT);
    for (const e of combat.events.splice(0)) if (e.type === 'hit' && e.target === 1) { hits++; killed ||= e.killed; }
  }
  check(`rifle hits dummy at 10 m: ${toKill} rounds kill`, hits === toKill && killed, `hits=${hits} killed=${killed}`);
  check('dead dummy respawns', (() => { for (let k = 0; k < 64 * 3.2; k++) combat.tick(TICK_DT); return dummy.alive && dummy.hp === MAX_HP; })());

  // ballistics over 100 m (through the empty middle of the cube): drop with the shooter's gravity, drag
  const flight = (weapon: 'rifle' | 'pistol') => {
    const shot = combat.fire(weapon, 0, new Vector3(0, 0, 60), new Vector3(0, 0, -1), new Vector3(), new Vector3(0, -1, 0));
    let t = 0;
    for (let k = 0; k < 128; k++) {
      combat.tick(TICK_DT);
      t += TICK_DT;
      if (shot.pos.z < -40) break;
    }
    return { drop: -shot.pos.y, speed: shot.vel.length() / WEAPONS[weapon].speed, t };
  };
  const rf = flight('rifle');
  const pf = flight('pistol');
  check('rifle: flat and fast over 100 m', rf.drop > 0.04 && rf.drop < 0.3 && rf.speed > 0.88 && rf.speed < 0.97 && rf.t < 0.2,
    `drop=${rf.drop.toFixed(2)}m speed=${(rf.speed * 100).toFixed(0)}% t=${rf.t.toFixed(2)}s`);
  check('pistol: drops more and slows down', pf.drop > rf.drop * 3 && pf.speed < rf.speed && pf.speed > 0.7,
    `drop=${pf.drop.toFixed(2)}m speed=${(pf.speed * 100).toFixed(0)}%`);
  check('damage follows the energy left', energyLeft(WEAPONS.rifle, WEAPONS.rifle.speed) === 1
    && Math.abs(energyLeft(WEAPONS.pistol, WEAPONS.pistol.speed * 0.8) - 0.64) < 1e-9 && energyLeft(WEAPONS.pistol, 10) === WEAPONS.pistol.minEnergy);
  check('spread: steady first shot, bloom in a burst, worse on the move',
    shotSpread(WEAPONS.rifle, 1, 0) === WEAPONS.rifle.spread && shotSpread(WEAPONS.rifle, 8, 0) > 0.02 && shotSpread(WEAPONS.rifle, 1, 1) > 0.03);
  combat.events.length = 0;

  // weapon state: fists at the start, guns need ammo, pistol is semi-automatic, reload takes spare rounds
  const ws = createWeaponState();
  const tick = (fire: boolean, extra: Partial<{ reload: boolean; select: 'fists' | 'pistol' | 'rifle' | 'grenade' | null }> = {}) =>
    weaponTick(ws, { fire, reload: false, select: null, ...extra }, TICK_DT);
  check('start with fists only', ws.current === 'fists' && !ws.owned.pistol && !ws.owned.rifle && !ws.owned.grenade);
  check('fists swing without ammo', tick(true) === 'fists');
  tick(false, { select: 'rifle' });
  check('cannot pick a weapon you do not own', ws.current === 'fists');
  giveWeapon(ws, 'rifle');
  tick(false, { select: 'rifle' });
  for (let k = 0; k < 20; k++) tick(false);
  check('rifle auto-fire respects interval', (() => {
    let n = 0;
    for (let k = 0; k < 64; k++) if (tick(true)) n++;
    return n >= 10 && n <= 11;
  })());
  for (let k = 0; k < 64 * 4; k++) tick(true);
  check('empty gun without spare ammo does not fire or reload', ws.ammo.rifle === 0 && ws.reloadT === 0 && tick(true) === null && !hasAmmo(ws, 'rifle'));
  ws.reserve.rifle = 40;
  tick(false, { reload: true });
  check('empty reload takes longer (bolt)', ws.reloadT === WEAPONS.rifle.reloadEmpty);
  for (let k = 0; k < 64 * 3; k++) tick(false);
  check('reload moves spare rounds into the magazine', ws.ammo.rifle === 30 && ws.reserve.rifle === 10, `mag=${ws.ammo.rifle} spare=${ws.reserve.rifle}`);
  for (let k = 0; k < 5; k++) { tick(true); for (let j = 0; j < 8; j++) tick(false); }
  tick(false, { reload: true });
  check('tactical reload is faster', ws.reloadT === WEAPONS.rifle.reload);
  for (let k = 0; k < 64 * 3; k++) tick(false);
  check('tactical reload keeps one in the chamber: 30 + 1', ws.ammo.rifle === 31 && ws.reserve.rifle === 4, `mag=${ws.ammo.rifle} spare=${ws.reserve.rifle}`);
  ws.ammo.rifle = 0; ws.reserve.rifle = 0;
  for (let k = 0; k < 20; k++) tick(false);
  tick(true);
  check('empty gun clicks', ws.dry);
  giveWeapon(ws, 'pistol');
  tick(false, { select: 'pistol' });
  for (let k = 0; k < 20; k++) tick(false);
  check('pistol is semi-automatic', (() => {
    let n = 0;
    for (let k = 0; k < 64; k++) if (tick(true)) n++;
    return n === 1;
  })());
  check('pistol fires once per click', (() => {
    let n = 0;
    for (let k = 0; k < 20; k++) tick(false);
    for (let k = 0; k < 64; k++) if (tick(k % 16 < 8)) n++;
    return n === 4;
  })());
  giveWeapon(ws, 'grenade', 3);
  tick(false, { select: 'grenade' });
  for (let k = 0; k < 20; k++) tick(false);
  check('grenade selected', tick(true) === 'grenade' && ws.ammo.grenade === 2);

  // fists: a punch at 1.5 m hits, at 3 m it does not; a wall in between stops it
  const punchDummy: Target = { id: 2, team: 'blue', center: new Vector3(), up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1 };
  combat.targets.push(punchDummy);
  const punchAt = (dist: number) => {
    punchDummy.center.copy(eye).add(new Vector3(0, -0.3, -dist));
    punchDummy.hp = MAX_HP;
    combat.use('fists', 0, eye, new Vector3(0, 0, -1), new Vector3(), new Vector3(0, -1, 0));
    return MAX_HP - punchDummy.hp;
  };
  dummy.alive = false;
  dummy.respawnIn = 1e9;
  const near = punchAt(1.2);
  const far = punchAt(3.5);
  check('punch hits up close for small damage', Math.abs(near - Math.round(WEAPONS.fists.damage * DAMAGE_SCALE * 10) / 10) < 1e-6 && far === 0, `near=${near} far=${far}`);
  // spawn protection: no damage until 3 s pass, the target walks away or fires
  {
    const g: Target = { id: 7, team: 'green', center: new Vector3(RX, G + 1.065, -30), up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1 };
    combat.targets.push(g);
    combat.guard(g);
    combat.damage(g, 50, 0, false, g.center);
    check('spawn protection blocks damage', g.hp === MAX_HP && combat.events.some((e) => e.type === 'guarded'));
    for (let k = 0; k < 64 * 3.1; k++) combat.tick(TICK_DT);
    check('spawn protection ends after 3 s', !g.guard);
    combat.guard(g);
    g.center.z += SPAWN_GUARD.radius + 0.5;
    combat.tick(TICK_DT);
    check('spawn protection ends when walking away', !g.guard);
    combat.guard(g);
    combat.use('fists', 7, g.center.clone(), new Vector3(0, 0, 1), new Vector3(), new Vector3(0, -1, 0));
    check('spawn protection ends when attacking', !g.guard);
    g.alive = false;
    combat.events.length = 0;
  }
  punchDummy.alive = false;
  combat.events.length = 0;
  place(RX, G + 1, 6, 0);
  run(30, {});
  sim.events.length = 0;
  combat.events.length = 0;
  // throw at own feet (calm weather)
  combat.windMul = 0;
  combat.fire('grenade', 0, s.pos.clone().add(new Vector3(0, 0.7, 0)), new Vector3(0, -1, -0.02).normalize(), s.vel, new Vector3(0, -1, 0));
  let exploded = false;
  let bounced = false;
  let maxUp = 0;
  for (let k = 0; k < 64 * 3.5; k++) {
    combat.tick(TICK_DT);
    sim.tick({ ...emptyInput(), yaw: s.yaw }, TICK_DT);
    for (const e of combat.events.splice(0)) {
      if (e.type === 'explode') exploded = true;
      if (e.type === 'bounce') bounced = true;
    }
    if (exploded) maxUp = Math.max(maxUp, s.vel.y);
  }
  check('grenade bounces then explodes after fuse', bounced && exploded);
  check('grenade knockback (rocket jump)', maxUp > 8, `vy=${maxUp.toFixed(1)}`);
  check('self damage reduced', me.hp < MAX_HP && me.hp > MAX_HP - WEAPONS.grenade.damage * 0.5, `hp=${me.hp}`);
}


// Build pieces (shovel): grid placement, ramps you can walk up and chain, inventory, HP, pick-up.
{
  const up = new Vector3(0, 1, 0);
  const fwd = new Vector3(0, 0, -1);
  const w = new R.World({ x: 0, y: 0, z: 0 });
  w.createCollider(R.ColliderDesc.cuboid(30, 1, 30).setTranslation(0, -1, 0)); // ground, top at y = 0
  w.step();
  const ps = new PlayerSim(R, w, map, 'red');
  ps.surfaces = false; // a test world at the origin: the centre's gravity plate is not there
  const bs = new BlockSystem(R, w, ps.mover.collider);
  const stand = (x: number, y: number, z: number) => {
    ps.state.pos.set(x, y + 0.915 + 0.05, z); ps.state.vel.set(0, 0, 0); ps.state.frame.identity(); ps.mover.place(ps.state);
    for (let k = 0; k < 20; k++) ps.tick(emptyInput(), TICK_DT);
  };
  const near = (v: Vector3, x: number, y: number, z: number) => v.distanceTo(new Vector3(x, y, z)) < 1e-3;
  stand(1, 0, 1);
  const wall = bs.plan('wall', ps.state.pos, up, fwd)!;
  check('wall goes on the next grid line in front', near(wall.center, PIECE_CELL / 2, PIECE_LEVEL / 2, 0), wall.center.toArray().map((v) => v.toFixed(2)).join(','));
  const wallThick = new Vector3(1, 0, 0).applyQuaternion(wall.quat);
  check('wall faces the player', Math.abs(Math.abs(wallThick.z) - 1) < 1e-6, wallThick.toArray().map((v) => v.toFixed(2)).join(','));
  const floor = bs.plan('floor', ps.state.pos, up, fwd)!;
  check('floor fills the cell in front at feet level', near(floor.center, PIECE_CELL / 2, -PIECE_THICK / 2, -PIECE_CELL / 2));
  check('placing spends material', bs.place(floor, 'wood', 'red') === 'ok' && bs.inventory.wood === START_BLOCKS.wood - PIECE_COST);
  check('one piece per slot', bs.validate(bs.plan('floor', ps.state.pos, up, fwd)!, 'wood') === 'occupied');
  check('needs material', bs.validate(wall, 'stone') === 'resources');
  const piece = [...bs.blocks.values()][0];
  check('piece HP from material', piece.maxHp === BLOCK_MATERIALS.wood.hp * PIECE_HP_MUL);
  check('pick-up refunds the piece', bs.reclaim(piece.collider.handle, 'red') === piece && bs.inventory.wood === START_BLOCKS.wood);
  // a piece cannot go into a character
  stand(2, 0, 0.3);
  const blocked = bs.plan('wall', new Vector3(2, 0.965, 2.5), up, fwd)!;
  check('cannot build into the player', near(blocked.center, PIECE_CELL / 2, PIECE_LEVEL / 2, 0) && bs.validate(blocked, 'wood') === 'player');
  // ramp: walk up it, then the next ramp continues one level higher
  stand(1, 0, 1);
  const ramp = bs.plan('ramp', ps.state.pos, up, fwd)!;
  check('ramp placed', bs.place(ramp, 'wood', 'red') === 'ok');
  let top = 0;
  for (let k = 0; k < 64 * 2; k++) {
    ps.tick({ ...emptyInput(), forward: 1, yaw: 0 }, TICK_DT);
    if (ps.state.pos.z > -PIECE_CELL + 0.6) top = Math.max(top, ps.state.pos.y - 0.915);
    if (ps.state.pos.z < -PIECE_CELL + 1.2) break;
  }
  check('player walks up the ramp', top > PIECE_LEVEL * 0.6, `feet=${top.toFixed(2)}`);
  const ramp2 = bs.plan('ramp', ps.state.pos, up, fwd)!;
  check('next ramp chains one level up', near(ramp2.center, ramp.center.x, ramp.center.y + PIECE_LEVEL, ramp.center.z - PIECE_CELL),
    `${ramp2.center.toArray().map((v) => v.toFixed(2))} vs ${ramp.center.toArray().map((v) => v.toFixed(2))}`);
  // other gravity: the grid follows the player's up
  const side = bs.plan('wall', new Vector3(-10, 1, 1), new Vector3(1, 0, 0), new Vector3(0, 0, -1))!;
  const sideUp = new Vector3(0, 1, 0).applyQuaternion(side.quat);
  check('pieces follow sideways gravity', Math.abs(sideUp.x - 1) < 1e-6, sideUp.toArray().map((v) => v.toFixed(2)).join(','));
  // fortification blocks: material HP, explosions, rifle
  const bw = new R.World({ x: 0, y: 0, z: 0 });
  const fb = new BlockSystem(R, bw);
  const stone = fb.add(new Vector3(-3.5, 0.87, 0.5), 'stone', 'blue');
  fb.damageCollider(stone.collider.handle, 380);
  check('material determines HP', stone.maxHp === BLOCK_MATERIALS.stone.hp && stone.hp === BLOCK_MATERIALS.stone.hp - 380);
  fb.explosion(stone.center.clone().add(new Vector3(0, 1.5, 0)), 5.5, 75);
  check('explosion destroys a damaged block and its collider', !fb.byCollider(stone.collider.handle)
    && !bw.castRay(new R.Ray(new Vector3(-3.5, 3, 0.5), { x: 0, y: -1, z: 0 }), 1.8, true));
  const c = new Combat(R, bw, map);
  c.windMul = 0;
  c.onWorldDamage = (handle, damage) => { fb.damageCollider(handle, damage); };
  const wood = fb.add(new Vector3(-6.5, 1.37, -8), 'wood', 'blue');
  for (let n = 0; n < 3; n++) {
    c.fire('rifle', 99, new Vector3(-6.5, 1.37, -2), new Vector3(0, 0, -1), new Vector3(), new Vector3(0, -1, 0));
    for (let k = 0; k < 6; k++) c.tick(TICK_DT);
  }
  check('three close rifle hits chip a wood block (+100 % HP)', fb.byCollider(wood.collider.handle) === wood
    && wood.hp >= BLOCK_MATERIALS.wood.hp - 3 * WEAPONS.rifle.blockDamage && wood.hp <= BLOCK_MATERIALS.wood.hp - 3 * (WEAPONS.rifle.blockDamage - 1), `hp=${wood.hp}`);
  check('building HP: wood ×2, stone ×3, metal ×4.5', BLOCK_MATERIALS.wood.hp === 120 && BLOCK_MATERIALS.stone.hp === 420 && BLOCK_MATERIALS.metal.hp === 1350);
  // penetration: a wooden wall piece (0.25 m) stops a pistol round but not a rifle round; stone stops both
  c.materialOf = (h) => fb.byCollider(h)?.material ?? null;
  const wallAt = (material: 'wood' | 'stone', z: number) => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2); // thin along z
    return fb.insertPiece('wall', new Vector3(-20, 1.5, z), new Vector3(PIECE_THICK / 2, 1.5, 2), q, material);
  };
  const through = (weapon: 'rifle' | 'pistol', z: number) => {
    const target: Target = { id: 50, team: 'green', center: new Vector3(-20, 1.4, z - 3), up: new Vector3(0, 1, 0), hp: 1000, alive: true, respawnIn: -1 };
    c.targets.push(target);
    c.fire(weapon, 99, new Vector3(-20, 1.4, z + 5), new Vector3(0, 0, -1), new Vector3(), new Vector3(0, -1, 0));
    for (let k = 0; k < 32; k++) c.tick(TICK_DT);
    c.targets.splice(c.targets.indexOf(target), 1);
    return 1000 - target.hp;
  };
  wallAt('wood', -60);
  const rifleThrough = through('rifle', -60);
  const pistolThrough = through('pistol', -60);
  wallAt('stone', -80);
  const stoneThrough = through('rifle', -80);
  check('rifle goes through a wooden wall, weaker', rifleThrough > 0 && rifleThrough < WEAPONS.rifle.damage, `damage=${rifleThrough}`);
  check('pistol stays in the wooden wall; stone stops the rifle', pistolThrough === 0 && stoneThrough === 0, `pistol=${pistolThrough} stone=${stoneThrough}`);
  // ricochet: a shallow shot onto a stone floor glances off and flies on
  fb.insertPiece('floor', new Vector3(-20, 0, -100), new Vector3(2, PIECE_THICK / 2, 2), new Quaternion(), 'stone');
  c.events.length = 0;
  const glancing = c.fire('rifle', 99, new Vector3(-20, 0.5, -96.5), new Vector3(0, -0.12, -1).normalize(), new Vector3(), new Vector3(0, -1, 0));
  for (let k = 0; k < 4; k++) c.tick(TICK_DT);
  const ric = c.events.some((e) => e.type === 'ricochet');
  check('shallow hit on stone ricochets', ric && glancing.ricochets === 1, `events=${c.events.map((e) => e.type).join(',')}`);
}

// Building on the real map: pieces fit on the streets of the island.
{
  const w = buildPhysicsWorld(R, map);
  const ps = new PlayerSim(R, w, map, 'red');
  const bs = new BlockSystem(R, w, ps.mover.collider);
  const up = new Vector3(0, 1, 0);
  for (const [x, z] of [[RX, -8], [RX, 20], [-RX, 1]]) {
    ps.state.pos.set(x, G + 1.5, z); ps.state.vel.set(0, 0, 0); ps.state.frame.identity(); ps.mover.place(ps.state);
    for (let k = 0; k < 90; k++) ps.tick(emptyInput(), TICK_DT);
    const plan = bs.plan('floor', ps.state.pos, up, new Vector3(0, 0, -1))!;
    const feet = ps.state.pos.y - 0.915;
    const res = plan && bs.validate(plan, 'wood');
    check(`street floor at ${x},${z} is placeable at feet level`, res === 'ok' && Math.abs(plan.center.y + PIECE_THICK / 2 - feet) < 0.05,
      `${res} top-feet=${plan ? (plan.center.y + PIECE_THICK / 2 - feet).toFixed(2) : '-'}`);
  }
}

// Match: generators, shop, fortified enemy beds, win / lose.
{
  const w = buildPhysicsWorld(R, map);
  const ps = new PlayerSim(R, w, map, 'red');
  const bs = new BlockSystem(R, w, ps.mover.collider);
  const m = new Match(R, w, map, bs, 'red', ps.mover.collider);
  const fortOf = (team: string) => [...bs.blocks.values()].filter((b) => b.team === team).length;
  check('enemy beds are fortified, own bed is not', TEAMS.every((t) => t.id === 'red' ? fortOf(t.id) === 0 : fortOf(t.id) >= 30),
    TEAMS.map((t) => `${t.id}=${fortOf(t.id)}`).join(' '));
  const gen = m.generators[0];
  const away = new Vector3(0, 500, 0);
  check('no free money generator at the base', m.generators.every((g) => g.currency === 'crystal') && m.generators.length === map.crystalSpots.length);
  for (let k = 0; k < 64 * 31; k++) m.tick(TICK_DT, away);
  check('crystal generator accumulates', gen.stored === 2, `stored=${gen.stored}`);
  for (let k = 0; k < 64 * 100; k++) m.tick(TICK_DT, away);
  check('generator caps', gen.stored === GENERATORS.crystal.cap);
  m.tick(TICK_DT, gen.pos.clone().addScaledVector(gen.up, 0.95));
  check('walking onto the generator collects', m.wallet.crystal === GENERATORS.crystal.cap && gen.stored === 0 && m.events.some((e) => e.type === 'pickup'));
  check('player can stand at the shop', m.nearShop(new Vector3(...map.spawns.red.pos)) === false && m.shop !== null);
  // enemy bed: walled off from the roof, reachable after breaking the wall
  const blue = m.bed('blue');
  const st = map.statues.find((s) => s.team === 'blue')!;
  const bup = new Vector3(...st.up);
  const roofEye = blue.pos.clone().addScaledVector(bup, -4 + 1.625).add(new Vector3(3, 0, 0).applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), bup)));
  check('fortification blocks the enemy bed', m.reachableBed(roofEye) === null);
  for (const b of [...bs.blocks.values()]) if (b.team === 'blue') bs.damageCollider(b.collider.handle, b.hp);
  check('enemy bed reachable once the wall is gone', m.reachableBed(roofEye) === blue, `d=${roofEye.distanceTo(blue.pos).toFixed(2)}`);
  for (let k = 0; k < 64 * 2; k++) m.breakTick(TICK_DT, roofEye, true);
  check('holding E breaks the bed', !blue.alive && m.events.some((e) => e.type === 'bedBroken' && e.team === 'blue'));
  check('death with own bed = respawn', m.onDeath() === true && m.result === null);
  for (const t of TEAMS) if (t.id !== 'red') m.destroyBed(t.id);
  check('all enemy beds broken = win', m.result === 'win' && m.events.some((e) => e.type === 'win'));
  const m2 = new Match(R, w, map, new BlockSystem(R, w), 'red');
  m2.destroyBed('red');
  check('no bed = eliminated on death', m2.onDeath() === false && m2.result === 'lose');
}

// Economy: start broke, sell junk, everything on the shelf from the start, ammo per gun, pockets spill on death.
{
  const w = buildPhysicsWorld(R, map);
  const bs = new BlockSystem(R, w);
  bs.inventory.wood = 0;
  const ws = createWeaponState();
  const eco = new Economy({ cash: 0, crystal: 0 }, bs, ws);
  const item = (id: string) => SHOP.find((i) => i.id === id)!;
  const shelf = () => eco.offers().map((o) => `${o.item.id}:${o.state}`).join(' ');
  check('start with no money and no tools', eco.wallet.cash === 0 && !eco.has('rod') && ws.current === 'fists');
  check('everything is on the shelf from the start', eco.offers().length === SHOP.length && eco.buy(item('rifle')) === 'money', shelf());
  check('prices: tools, guns and block packs', item('rod').price === 5 && item('builder').price === 11 && item('pistol').price === 19
    && item('rifle').price === 41 && item('wood').price === 4 && item('stone').price === 8 && item('metal').price === 2);
  eco.items.bottle = 4; eco.items.apple = 1; eco.items.fish = 1;
  const value = eco.sellValue;
  check('selling pays per item, cheaply', eco.sellAll() === value && value === 4 * ITEMS.bottle.sell + ITEMS.apple.sell + ITEMS.fish.sell
    && eco.wallet.cash === value && eco.items.bottle === 0, `got ${value}`);
  eco.wallet.cash = 1000;
  eco.buy(item('rifle'));
  check('a rifle can be the first purchase', ws.owned.rifle && ws.ammo.rifle === WEAPONS.rifle.mag && !ws.owned.pistol);
  for (const id of ['rod', 'builder', 'pistol', 'grenade']) eco.buy(item(id));
  check('build tool comes with some wood', bs.inventory.wood === BUILDER_WOOD);
  const wood = item('wood') as Extract<typeof SHOP[number], { kind: 'blocks' }>;
  const woodPacks = Math.ceil(Math.max(0, 25 - BUILDER_WOOD) / wood.count);
  check('a bridge (25 plates, 1 wood each) costs under 20 money', item('builder').price + woodPacks * item('wood').price < 20,
    `${item('builder').price} + ${woodPacks}×${item('wood').price}`);
  check('weapons from the shop come loaded, no spare ammo', ws.owned.pistol && ws.ammo.pistol === WEAPONS.pistol.mag && ws.reserve.pistol === 0
    && ws.owned.rifle && ws.ammo.grenade === 2);
  check('bought tools and guns leave the shelf', !eco.offers().some((o) => ['rod', 'builder', 'pistol', 'rifle'].includes(o.item.id)), shelf());
  eco.buy(item('ammo-pistol'));
  check('ammo is bought per gun: a magazine of pistol rounds', ws.reserve.pistol === WEAPONS.pistol.mag && ws.reserve.rifle === 0);
  eco.buy(item('grenade'));
  check('grenades are capped', eco.buy(item('grenade')) === 'full' && ws.ammo.grenade === WEAPONS.grenade.mag);
  for (let k = 0; k < MAX_MEDKITS; k++) eco.buy(item('medkit'));
  check('medkits go to the pockets, capped', eco.items.medkit === MAX_MEDKITS && eco.buy(item('medkit')) === 'full');
  check('a medkit is not sold back', eco.sell('medkit') === 0 && eco.items.medkit === MAX_MEDKITS);
  eco.items.apple = 1;
  check('eating takes an apple', eco.eat() && eco.items.apple === 0 && !eco.eat() && APPLE_HEAL > 0);
  eco.items.apple = 3; eco.items.bottle = 2; eco.wallet.cash = 11;
  const piles = eco.spill();
  const pile = (k: string) => piles.find((p) => p.kind === k)?.amount ?? 0;
  check('death spills the items and half of the cash', pile('apple') === 3 && pile('bottle') === 2 && pile('medkit') === MAX_MEDKITS
    && pile('cash') === 5 && eco.wallet.cash === 6 && eco.items.apple === 0 && eco.items.medkit === 0, JSON.stringify(piles));
  check('guns and tools stay after death', ws.owned.rifle && eco.has('builder'));

  // hotbar: new things fill free slots in order, keep their slot when they run out and come back
  const bar = new Hotbar();
  bar.sync(holdables(eco));
  check('hotbar: guns, grenades, tools in order', bar.bar.slice(0, 5).join() === 'pistol,rifle,grenade,build,rod', bar.bar.join());
  bar.swap({ where: 'bar', i: 0 }, { where: 'bar', i: 8 });
  eco.items.apple = 2;
  bar.sync(holdables(eco));
  const appleAt = bar.slotOf('apple');
  eco.items.apple = 0;
  bar.sync(holdables(eco));
  bar.sel = 0; // an empty slot in hand: a new item must not jump into it
  eco.items.apple = 1;
  bar.sync(holdables(eco));
  check('hotbar: a stack that ran out comes back to its slot', bar.slotOf('apple') === appleAt && bar.bar[8] === 'pistol' && !bar.bar[0],
    bar.bar.join());
}

// Thrown items: a bottle breaks on an NPC and dazes it for 2 s, an apple lands and can be picked up again.
{
  const w = buildPhysicsWorld(R, map);
  const combat = new Combat(R, w, map);
  combat.windMul = 0;
  const pk = new Pickups(R, w, map);
  const npcs = new NpcManager(R, w, map, combat, pk);
  const throws = new Throws(combat, pk);
  const bum = npcs.npcs.find((n) => n.island === RED && n.kind === 'bum')!;
  const me: Target = { id: 0, team: 'red', center: bum.sim.state.pos.clone().add(new Vector3(3, 0, 0)), up: new Vector3(0, 1, 0), hp: MAX_HP,
    alive: true, respawnIn: -1, vel: new Vector3(), quiet: true };
  combat.targets.push(me);
  const step = (sec: number) => {
    for (let k = 0; k < 64 * sec; k++) { npcs.tick(TICK_DT); throws.tick(TICK_DT); combat.tick(TICK_DT); }
  };
  step(0.5);
  me.center.copy(bum.sim.state.pos).add(new Vector3(3, 0, 0));
  const eye = me.center.clone().add(new Vector3(0, 0.6, 0));
  throws.throw('bottle', 0, eye, bum.sim.state.pos.clone().sub(eye).normalize(), new Vector3(), new Vector3(0, -1, 0));
  for (let k = 0; k < 64 && !throws.events.some((e) => e.type === 'shatter'); k++) { throws.tick(TICK_DT); combat.tick(TICK_DT); }
  const hit = throws.events.find((e) => e.type === 'shatter');
  check('a thrown bottle breaks on the NPC and dazes it', !!hit && hit.type === 'shatter' && hit.target === bum.id && hit.stunned
    && Math.abs((bum.target.stun ?? 0) - THROW.stun) < 0.1 && Math.abs(bum.target.hp - (NPC.bum.hp - Math.round(THROW.bottleDamage * DAMAGE_SCALE * 10) / 10)) < 1e-6, JSON.stringify(hit));
  step(0.3); // it was walking: slides to a stop
  const at = bum.sim.state.pos.clone();
  step(1.2);
  check('a dazed NPC stands still', bum.sim.state.pos.distanceTo(at) < 0.15 && bum.status === 'оглушён', `moved ${bum.sim.state.pos.distanceTo(at).toFixed(2)}`);
  step(0.6);
  check('the daze wears off after 2 s and it goes for the thrower', !bum.target.stun && bum.foe === me);

  throws.events.length = 0;
  const before = pk.items.length;
  const fwd = new Vector3(0, -0.4, -1).normalize();
  throws.throw('apple', 0, eye, fwd, new Vector3(), new Vector3(0, -1, 0));
  for (let k = 0; k < 64 * 3 && !throws.events.some((e) => e.type === 'land'); k++) throws.tick(TICK_DT);
  const landed = pk.items.slice(before).find((i) => i.kind === 'apple');
  check('a thrown apple lands on the street as a pickup', !!landed && landed.once && Math.abs(landed.pos.y - G) < 0.3,
    landed ? `y=${(landed.pos.y - G).toFixed(2)}` : 'none');
}

// Pickups: apples under trees, bottles on the streets of every base island; taken items come back later.
{
  const w = buildPhysicsWorld(R, map);
  const p = new Pickups(R, w, map);
  const apples = p.items.filter((i) => i.kind === 'apple');
  const bottles = p.items.filter((i) => i.kind === 'bottle');
  const trees = map.trees.filter((t) => t.kind === 'tree').length;
  check('an apple under (almost) every tree', apples.length >= trees * 0.9, `${apples.length}/${trees}`);
  check('bottles on every team face', TEAMS.every((t) => bottles.filter((b) => b.up.dot(new Vector3(...faceOfTeam(map, t.id)!.up)) > 0.99).length === PICKUPS.bottlesPerIsland),
    `${bottles.length} bottles`);
  const onRed = bottles.find((b) => b.up.y > 0.99)!;
  check('bottles lie on the street level', Math.abs(onRed.pos.y - G) < 0.3, `y=${(onRed.pos.y - G).toFixed(2)}`);
  check('nearest item within reach', p.nearest(onRed.pos.clone().add(new Vector3(0, 0.9, 0))) === onRed);
  p.take(onRed);
  check('taken item is gone', !onRed.alive && p.nearest(onRed.pos) !== onRed);
  for (let k = 0; k < 64 * (PICKUPS.bottleRespawn + 1); k++) p.tick(TICK_DT);
  check('bottle comes back somewhere on the same island', onRed.alive && onRed.up.y > 0.99);
}

// Fishing: only at a pond; cast → wait → bite → strike inside the zone = fish; too early / outside = nothing.
{
  const pond = map.ponds.find((q) => q.team === 'red')!;
  const water = new Vector3(...pond.pos);
  const eye = water.clone().add(new Vector3(-4, 1.8, 0));
  const dir = water.clone().sub(eye).normalize();
  const f = new Fishing(map.ponds, 5);
  const body = eye.clone().add(new Vector3(0, -0.7, 0));
  const until = (phase: string, max = 64 * 10) => { for (let k = 0; k < max && f.phase !== phase; k++) f.tick(TICK_DT, body); return f.phase === phase; };
  f.use(eye, new Vector3(0, 0, -1).add(new Vector3(0, -0.05, 0)).normalize());
  check('cannot fish away from water', f.phase === 'idle' && f.events.some((e) => e.type === 'noWater'));
  f.events.length = 0;
  f.use(eye, dir);
  check('cast lands in the pond', f.phase === 'cast' && f.bobber.distanceTo(water) < 0.5);
  check('a fish bites after a few seconds', until('wait') && (() => { const t0 = f.dur; return until('bite') && t0 >= FISHING.waitMin; })());
  while (f.marker < f.zoneAt + FISHING.zone / 2) f.tick(TICK_DT, body);
  f.use(eye, dir);
  check('strike inside the zone catches a fish', f.events.some((e) => e.type === 'catch'));
  until('idle');
  f.events.length = 0;
  f.use(eye, dir);
  until('wait');
  f.use(eye, dir);
  check('striking before the bite scares the fish', f.events.some((e) => e.type === 'miss' && e.reason === 'early'));
  until('idle');
  f.events.length = 0;
  f.use(eye, dir);
  until('bite');
  f.use(eye, dir); // marker at the very start: the zone never starts there
  check('strike outside the zone misses', f.events.some((e) => e.type === 'miss' && e.reason === 'zone') && !f.events.some((e) => e.type === 'catch'));
  until('idle');
  f.events.length = 0;
  f.use(eye, dir);
  until('wait');
  f.tick(TICK_DT, body.clone().add(new Vector3(30, 0, 0)));
  check('walking away reels the line in', f.events.some((e) => e.type === 'miss' && e.reason === 'away'));
}

// City NPCs: bums and gangs on the streets, gradual noticing (sight cone, distance, movement), hearing, loot.
{
  const w = buildPhysicsWorld(R, map);
  const combat = new Combat(R, w, map);
  combat.windMul = 0;
  const pk = new Pickups(R, w, map);
  const npcs = new NpcManager(R, w, map, combat, pk);
  const vel = new Vector3();
  const me: Target = { id: 0, team: 'red', center: new Vector3(RX, G + 0.95, 10), up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1,
    vel, quiet: false };
  combat.targets.push(me);
  check('bums and a gang on every team face', TEAMS.every((t) => npcs.npcs.filter((n) => n.island === faceOfTeam(map, t.id)!.id && n.kind === 'bum').length === NPC.bumsPerIsland
    && npcs.npcs.filter((n) => n.island === faceOfTeam(map, t.id)!.id && n.kind === 'gang').length === NPC.gangSize));
  const step = (sec: number, each?: () => void) => {
    for (let k = 0; k < 64 * sec; k++) { each?.(); npcs.tick(TICK_DT); combat.tick(TICK_DT); combat.events.length = 0; }
  };
  step(2);
  const red = npcs.npcs.filter((n) => n.island === RED);
  check('NPCs stand on the streets', red.every((n) => n.sim.state.onGround && Math.abs(n.sim.state.pos.y - G - 0.94) < 0.3),
    red.map((n) => (n.sim.state.pos.y - G).toFixed(2)).join(' '));

  // stealth against one gang member: a target kept at a fixed spot relative to where it looks
  const g = red.find((n) => n.kind === 'gang')!;
  const others = npcs.npcs.filter((n) => n !== g);
  const hold = (dist: number, behind: boolean, speed: number, quiet: boolean) => () => {
    const s2 = g.sim.state;
    const f = new Vector3();
    moveBasis(s2.frame, s2.yaw, f, new Vector3());
    me.center.copy(s2.pos).addScaledVector(f, behind ? -dist : dist);
    vel.copy(f).multiplyScalar(speed);
    me.quiet = quiet;
    for (const o of others) o.target.alive && o.suspicion.clear(); // only `g` is under test
  };
  const reset = () => { g.suspicion.clear(); g.foe = null; g.target.aggro = null; g.state = 'patrol'; g.lookAt = null; me.hp = MAX_HP; };
  const timeToNotice = (dist: number, speed: number) => {
    reset();
    let t = 0;
    for (; t < 10 && !g.foe; t += TICK_DT) step(TICK_DT, hold(dist, false, speed, speed < 4));
    return t;
  };
  const tStill = timeToNotice(9, 0);
  const tRun = timeToNotice(9, 7);
  check('a target in view gets noticed gradually, not at once', tStill > 1 && tStill < 8, `standing at 9 m: ${tStill.toFixed(1)} s`);
  check('running in view is noticed faster', tRun < tStill * 0.6, `running: ${tRun.toFixed(1)} s`);
  check('noticed closer = sooner', timeToNotice(4, 0) < tStill, `4 m: ${timeToNotice(4, 0).toFixed(1)} s`);
  reset();
  step(4, hold(5, true, 3.4, true));
  check('quiet walk behind the back goes unnoticed', !g.foe && npcs.awareness(g, 0) < 0.3, `awareness ${npcs.awareness(g, 0).toFixed(2)}`);
  reset();
  step(1.5, hold(5, true, 7, false));
  check('running footsteps behind the back are heard', npcs.awareness(g, 0) > 0.2 && g.lookAt !== null, `awareness ${npcs.awareness(g, 0).toFixed(2)}`);
  reset();
  timeToNotice(7, 0);
  const hp0 = me.hp;
  step(5, hold(7, false, 0, true));
  check('an alerted gang member shoots', me.hp < hp0, `hp ${me.hp}`);
  check('the rest of the gang is told', red.filter((n) => n.kind === 'gang' && n !== g).some((n) => n.state === 'search' || n.foe === me));

  // a gunshot draws a patrolling gang member to look
  const g2 = red.filter((n) => n.kind === 'gang')[1];
  g2.foe = null; g2.state = 'patrol'; g2.suspicion.clear();
  me.center.set(0, -3000, 0);
  combat.noises.push({ pos: g2.sim.state.pos.clone().add(new Vector3(20, 0, 0)), radius: 38, owner: 0 });
  step(0.3);
  check('a gunshot within earshot sends the gang to search', (g2.state as string) === 'search' && !!g2.searchAt, g2.state);

  // loot: a dead bandit drops money
  const cash0 = pk.items.filter((i) => i.kind === 'cash').length;
  combat.damage(g2.target, 1000, 0, false, g2.target.center);
  step(0.1);
  check('a dead bandit drops money', pk.items.filter((i) => i.kind === 'cash').length === cash0 + 1 && (g2.state as string) === 'dead');

  // a minute of street life with somebody around: bums drink, litter, scuffle
  me.center.set(RX, G + 0.95, 10); vel.set(0, 0, 0); me.hp = 1e9;
  const bottles0 = pk.countOn('bottle', new Vector3(0, 1, 0));
  let brawls = 0;
  const t0 = performance.now();
  for (let k = 0; k < 64 * 90; k++) {
    npcs.tick(TICK_DT);
    combat.tick(TICK_DT);
    for (const e of combat.events.splice(0)) {
      const a = combat.target(e.type === 'hit' ? e.owner : -1), b = e.type === 'hit' ? combat.target(e.target) : null;
      if (a?.npc === 'bum' && b?.npc === 'bum') brawls++;
    }
  }
  const ms = (performance.now() - t0) / 90;
  check('bums drink and leave empty bottles', pk.countOn('bottle', new Vector3(0, 1, 0)) > bottles0, `${bottles0} → ${pk.countOn('bottle', new Vector3(0, 1, 0))}`);
  check('bums pick fights with each other', brawls > 0, `${brawls} hits`);
  check('NPCs stay on the streets', npcs.npcs.every((n) => n.state === 'dead' || n.sim.state.pos.toArray().every(Number.isFinite)
    && (() => {
      const isl = map.faces.find((f) => f.id === n.island)!;
      const u = upOf(n.sim.state.frame);
      return Math.abs(n.sim.state.pos.dot(u) - new Vector3(...isl.origin).dot(u) - 0.94) < 3;
    })()));
  check('NPCs are cheap to simulate', ms < 40, `${ms.toFixed(1)} ms per game second, ${npcs.npcs.length} NPCs`);
}

// Gang fights: telegraphed bursts at a locked spot (standing still you are hit, a step aside dodges), grenades.
{
  // the throw solver: low and high arcs both land on the point (no drag, no wind)
  const up = new Vector3(0, 1, 0), g = DEFAULT_MOVEMENT.gravity, v = WEAPONS.grenade.speed;
  const from = new Vector3(0, 1.5, 0), to = new Vector3(14, 0, 5);
  const land = (high: boolean) => {
    const d = lobDirection(from, to, up, v, g, high)!;
    const p = from.clone(), vel = d.multiplyScalar(v);
    for (let k = 0; k < 64 * 6 && !(vel.y < 0 && p.y <= to.y); k++) { vel.y -= g * TICK_DT; p.addScaledVector(vel, TICK_DT); }
    return p;
  };
  check('grenade arcs land on the target (low and lob)', land(false).distanceTo(to) < 0.6 && land(true).distanceTo(to) < 0.8,
    `low ${land(false).distanceTo(to).toFixed(2)}, lob ${land(true).distanceTo(to).toFixed(2)}`);
  check('a target out of reach gets no throw', lobDirection(from, new Vector3(60, 0, 0), up, v, g, false) === null);

  const w = buildPhysicsWorld(R, map);
  const combat = new Combat(R, w, map);
  combat.windMul = 0;
  const npcs = new NpcManager(R, w, map, combat, new Pickups(R, w, map));
  const N = npcs as unknown as { engage(n: Npc, t: Target): void; park(n: Npc): void; spawn(n: Npc): void };
  const gm = npcs.npcs.find((n) => n.island === RED && n.kind === 'gang')!;
  for (const o of npcs.npcs) if (o !== gm) { o.state = 'dead'; o.respawnT = 1e9; o.target.alive = false; N.park(o); }
  const me: Target = { id: 0, team: 'red', center: new Vector3(), up: new Vector3(0, 1, 0), hp: 1e6, alive: true, respawnIn: -1, vel: new Vector3() };
  combat.targets.push(me);
  let t = 0;
  const log: { t: number; type: string; hit?: boolean; d?: number }[] = [];
  const step = (sec: number, each?: () => void, until?: () => boolean) => {
    for (let k = 0; k < 64 * sec && !until?.(); k++) {
      each?.(); t += TICK_DT;
      npcs.tick(TICK_DT); combat.tick(TICK_DT);
      for (const e of npcs.events.splice(0)) if (e.id === gm.id) log.push({ t, type: e.type === 'windup' ? (e.grenade ? 'nadeWindup' : 'windup') : 'throw' });
      for (const e of combat.events.splice(0)) {
        if (e.type === 'fire' && e.owner === gm.id) log.push({ t, type: e.weapon === 'grenade' ? 'grenade' : 'shot' });
        if (e.type === 'bounce') log.push({ t, type: 'bounce', d: e.pos.distanceTo(me.center) });
        if (e.type === 'hit' && e.owner === gm.id && e.target === 0) log.push({ t, type: 'hit' });
        if (e.type === 'explode') log.push({ t, type: 'explode', hit: e.pos.distanceTo(me.center) < WEAPONS.grenade.radius * 0.75, d: e.pos.distanceTo(me.center) });
      }
    }
  };
  step(1);
  const s0 = gm.sim.state;
  const fwd = new Vector3(), side = new Vector3();
  moveBasis(s0.frame, s0.yaw, fwd, side);
  me.center.copy(s0.pos).addScaledVector(fwd, 10);
  gm.grenades = 0;
  N.engage(gm, me);
  const burst = () => {
    const from = log.length;
    step(4, undefined, () => log.slice(from).some((e) => e.type === 'windup'));
    const w0 = log.slice(from).find((e) => e.type === 'windup');
    return { from, w0 };
  };
  let b = burst();
  step(2, undefined, () => gm.fire === 'free' && log.slice(b.from).some((e) => e.type === 'shot'));
  step(0.2);
  const shots = log.slice(b.from).filter((e) => e.type === 'shot');
  const hits = log.slice(b.from).filter((e) => e.type === 'hit').length;
  check('a bandit winds up before the burst (time to react)', !!b.w0 && shots.length === NPC.gang.burst && shots[0].t - b.w0!.t >= NPC.gang.windup - 0.05,
    b.w0 ? `${(shots[0]?.t - b.w0.t).toFixed(2)} s, ${shots.length} shots` : 'no windup');
  check('standing still in a burst gets you hit', hits >= 2, `${hits}/${shots.length}`);
  // the next burst: step aside once it winds up
  b = burst();
  const away = side.clone().multiplyScalar(4.5 * TICK_DT);
  step(2, () => me.center.add(away), () => gm.fire === 'free' && log.slice(b.from).some((e) => e.type === 'shot'));
  step(0.2);
  const dodged = log.slice(b.from).filter((e) => e.type === 'hit').length;
  check('a step aside after the lock dodges the burst', !!b.w0 && log.slice(b.from).some((e) => e.type === 'shot') && dodged === 0, `${dodged} hits`);

  // grenades: in the open, at 14 m; it lands next to you (a fresh bandit at home: the chase above took it far)
  N.spawn(gm);
  step(0.5);
  moveBasis(gm.sim.state.frame, gm.sim.state.yaw, fwd, side);
  me.center.copy(gm.sim.state.pos).addScaledVector(fwd, 14);
  gm.grenades = 2; gm.grenadeT = 0;
  N.engage(gm, me);
  const chance = NPC.gang.grenadeChance;
  NPC.gang.grenadeChance = 1;
  const at = log.length;
  step(6, undefined, () => log.slice(at).some((e) => e.type === 'explode'));
  NPC.gang.grenadeChance = chance;
  const nw = log.slice(at).find((e) => e.type === 'nadeWindup'), thr = log.slice(at).find((e) => e.type === 'grenade');
  const boom = log.slice(at).find((e) => e.type === 'explode');
    check('a bandit winds up and throws a grenade', !!nw && !!thr && thr.t - nw.t >= NPC.gang.grenadeWindup - 0.05 && gm.grenades === 1);
  const touch = log.slice(at).find((e) => e.type === 'bounce');
  check('the grenade lands at the target and goes off within the blast radius', !!touch && touch.d! < 1.5 && !!boom?.hit,
    `touchdown ${touch?.d?.toFixed(1)} m, blast ${boom?.d?.toFixed(1)} m`);
}

// Bots: a full headless match (player parked out of reach): crystals fall, nobody gets lost.
{
  const w = buildPhysicsWorld(R, map);
  const ps = new PlayerSim(R, w, map, 'red');
  const combat = new Combat(R, w, map, [ps.mover.collider]);
  const bs = new BlockSystem(R, w, ps.mover.collider);
  combat.onWorldDamage = (h, d) => { bs.damageCollider(h, d); };
  combat.onExplosion = (p, r, d) => bs.explosion(p, r, d);
  const m = new Match(R, w, map, bs, 'red', ps.mover.collider);
  const me: Target = { id: 0, team: 'red', center: ps.state.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1 };
  ps.state.pos.set(0, -3000, 0);
  ps.mover.place(ps.state);
  combat.targets.push(me);
  const bots = new BotManager(R, w, map, combat, m, bs, 'red');
  // the city lives on: bots cross the streets past bums and gangs
  const npcs = new NpcManager(R, w, map, combat, new Pickups(R, w, map));
  check('two bots per enemy team', bots.bots.length === (TEAMS.length - 1) * 2 && !bots.bots.some((b) => b.team === 'red'));
  check('bots start with fists like the player', bots.bots.every((b) => b.weapons.current === 'fists' && !b.weapons.owned.pistol));
  let kills = 0;
  let pistolAt = -1;
  let maxAir = 0;
  const air = new Map<number, number>();
  const t0 = performance.now();
  const MATCH_T = 360; // attackers set off after a minute, a lane over a cube edge takes about another one
  for (let k = 0; k < 64 * MATCH_T; k++) {
    bots.tick(TICK_DT);
    npcs.tick(TICK_DT);
    combat.tick(TICK_DT);
    m.tick(TICK_DT, ps.state.pos);
    for (const e of combat.events.splice(0)) if (e.type === 'hit' && e.killed && !combat.target(e.target)?.npc && !combat.target(e.owner)?.npc) kills++;
    if (pistolAt < 0 && bots.bots.every((b) => b.weapons.current === 'pistol')) pistolAt = m.time;
    for (const b of bots.bots) {
      const a = b.target.alive && !b.sim.state.onGround ? (air.get(b.id) ?? 0) + TICK_DT : 0;
      air.set(b.id, a);
      maxAir = Math.max(maxAir, a);
    }
  }
  const broken = m.beds.filter((b) => !b.alive).map((b) => b.team);
  check('bots get a pistol on a timer, then a rifle', pistolAt >= BOT.pistolAt && pistolAt < BOT.pistolAt + 1
    && bots.bots.every((b) => b.out || b.weapons.current === 'rifle'), `pistol at ${pistolAt.toFixed(1)} s`);
  check('bots break crystals within 6 minutes', broken.length > 0, `broken=${broken.join(',')}`);
  check('bots fight each other', kills >= 2, `kills=${kills}`);
  check('no bot stays airborne for long', maxAir < 10, `max=${maxAir.toFixed(1)}s`);
  check('bot positions stay finite', bots.bots.every((b) => b.sim.state.pos.toArray().every(Number.isFinite)));
  // six city faces: 62 NPCs (the island map had 47); the cost per character is the same as before
  check('bots are cheap to simulate (with the city NPCs)', (performance.now() - t0) / MATCH_T < 80, `${((performance.now() - t0) / MATCH_T).toFixed(1)} ms per game second`);
}

// Slopes: walking up / down a ramp is as fast along the surface as on flat ground, and stays grounded (build ramps ~37°).
for (const deg of [20, 37, 45]) {
  const w = new R.World({ x: 0, y: 0, z: 0 });
  w.createCollider(R.ColliderDesc.cuboid(60, 1, 60).setTranslation(0, -1, 0));
  const a = (deg * Math.PI) / 180, L = 20;
  const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), a); // rises toward -Z
  const c = new Vector3(0, (Math.sin(a) * L) / 2, (-Math.cos(a) * L) / 2).add(new Vector3(0, -0.5, 0).applyQuaternion(q));
  w.createCollider(R.ColliderDesc.cuboid(4, 0.5, L / 2).setTranslation(c.x, c.y, c.z).setRotation(q));
  w.step();
  const ps = new PlayerSim(R, w, map, 'red');
  ps.surfaces = false; // a test world at the origin: the centre's gravity plate is not there
  const walk = (z: number, y: number, yaw: number) => {
    ps.state.pos.set(0, y, z); ps.state.vel.set(0, 0, 0); ps.state.frame.identity(); ps.mover.place(ps.state);
    for (let k = 0; k < 20; k++) ps.tick(emptyInput(), TICK_DT);
    let dist = 0, air = 0;
    for (let k = 0; k < 90; k++) {
      const p0 = ps.state.pos.clone();
      ps.tick({ ...emptyInput(), forward: 1, yaw }, TICK_DT);
      if (k >= 30) { dist += ps.state.pos.distanceTo(p0); if (!ps.state.onGround) air++; }
    }
    return { speed: dist / (60 * TICK_DT) / HU, air };
  };
  const upR = walk(4, 1, 0);
  const downR = walk(-Math.cos(a) * L + 2, Math.sin(a) * L + 1, Math.PI);
  check(`${deg}° ramp: same speed as on flat ground up and down, grounded`,
    Math.abs(upR.speed - 300) < 10 && Math.abs(downR.speed - 300) < 10 && upR.air + downR.air <= 2,
    `up ${upR.speed.toFixed(0)} u/s, down ${downR.speed.toFixed(0)} u/s, airborne ticks ${upR.air + downR.air}`);
}

// --- difficulty presets
{
  const normal = { ...BOT };
  applyDifficulty('easy');
  const easy = { ...BOT };
  applyDifficulty('hard');
  const hard = { ...BOT };
  applyDifficulty('normal');
  check('difficulty: easy is slower and less accurate than hard', easy.reaction > normal.reaction && normal.reaction > hard.reaction
    && easy.spread > hard.spread && easy.firstAttack > hard.firstAttack && easy.pistolAt > hard.pistolAt);
  check('difficulty: back to normal restores every value', JSON.stringify(BOT) === JSON.stringify(normal));
}

// --- lobby: line-ups, islands only for teams that play, allies and per-bot difficulty
{
  const d = defaultLobby();
  check('lobby: the default is you in red and 2 bots in every other team', playerTeam(d) === 'red' && activeTeams(d).length === 4
    && JSON.stringify(botRoster(d)) === JSON.stringify({ blue: ['normal', 'normal'], green: ['normal', 'normal'], yellow: ['normal', 'normal'] }));
  const c = parseLobby(JSON.stringify(d));
  c.seats.blue = [null, null, null, null, null];
  c.seats.yellow = [null, null, null, null, null];
  c.seats.green = [{ kind: 'bot', difficulty: 'hard' }, { kind: 'bot', difficulty: 'easy' }, null, null, null];
  seatPlayer(c, 'green', 2);
  check('lobby: sitting down elsewhere leaves the old seat; a lone team cannot start', playerTeam(c) === 'green' && !c.seats.red[0]
    && lobbyProblem(c) !== null);
  c.seats.yellow[0] = { kind: 'bot', difficulty: 'hard' };
  c.seats.green[3] = { kind: 'bot', difficulty: 'easy' };
  check('lobby: two teams can start; broken storage falls back to the default', lobbyProblem(c) === null
    && playerTeam(parseLobby('{"seats":1}')) === 'red' && playerTeam(parseLobby(null)) === 'red');
  const lm = generateMap(1337, 'green', activeTeams(c));
  check('lobby: only teams that play get a face and a crystal', JSON.stringify(lm.teams) === '["green","yellow"]'
    && lm.statues.length === 2 && lm.faces.filter((f) => f.team).length === 2);
  const w = buildPhysicsWorld(R, lm);
  const ps = new PlayerSim(R, w, lm, 'green');
  const combat = new Combat(R, w, lm, [ps.mover.collider]);
  const bs = new BlockSystem(R, w, ps.mover.collider);
  const m = new Match(R, w, lm, bs, 'green', ps.mover.collider);
  const bots = new BotManager(R, w, lm, combat, m, bs, 'green', 0, botRoster(c));
  const allies = bots.bots.filter((b) => b.team === 'green'), foes = bots.bots.filter((b) => b.team === 'yellow');
  check('lobby: allies join the player\'s team, each bot with its own difficulty', allies.length === 3 && foes.length === 1
    && allies[1].tune.reaction > foes[0].tune.reaction && allies[0].role === 'defend' && allies[1].role === 'attack'
    && foes[0].tune !== BOT, `allies ${allies.length}, foes ${foes.length}`);
  // late in the match: every attacker has set off
  m.time = 300;
  const t0 = performance.now();
  for (let i = 0; i < 64 * 20; i++) { m.time += TICK_DT; bots.tick(TICK_DT); }
  const goals = new Set(allies.filter((b) => b.goal).map((b) => b.goal));
  check('lobby: allies go for the enemy, never their own base', goals.has('yellow') && !goals.has('green') && allies.every((b) => !b.out),
    `goals ${[...goals].join(',')}, ${((performance.now() - t0) / 20).toFixed(0)} ms per game second`);
}

// GravWars movement: hold-to-extend jump reaches one build level, a wall slide brakes the fall, falls hurt.
{
  const w = buildPhysicsWorld(R, map);
  const ps = new PlayerSim(R, w, map, 'red');
  const st = ps.state;
  const put = (x: number, y: number, z: number) => {
    st.pos.set(x, y, z); st.vel.set(0, 0, 0); st.frame.identity(); st.onGround = false; st.jumpHold = 0; ps.mover.place(st);
  };
  const apex = (hold: number) => {
    put(RX, G + 1.2, 10);
    for (let k = 0; k < 30; k++) ps.tick(emptyInput(), TICK_DT);
    const y0 = st.pos.y; let top = y0;
    for (let k = 0; k < 120; k++) { ps.tick({ ...emptyInput(), jump: k < hold }, TICK_DT); top = Math.max(top, st.pos.y); }
    return top - y0;
  };
  const tap = apex(1), held = apex(60);
  check('tap jump is short, a held jump clears one build level (3 m)', tap > 1 && tap < 1.6 && held > PIECE_LEVEL + 0.1, `tap ${tap.toFixed(2)} held ${held.toFixed(2)}`);
  // the hall's east wall (outer face x = 12): fall against it pushing in → slow slide; not pushing → free fall
  put(HALL_HALF + 0.43, G + 8, 0);
  let minV = 0;
  for (let k = 0; k < 40; k++) { ps.tick({ ...emptyInput(), yaw: Math.PI / 2, forward: 1 }, TICK_DT); minV = Math.min(minV, st.vel.y); }
  check('pushing into a wall in the air slides down slowly', st.wallSlide && minV > -4.5, `v=${minV.toFixed(1)}`);
  put(HALL_HALF + 0.43, G + 8, 0);
  for (let k = 0; k < 40; k++) ps.tick(emptyInput(), TICK_DT);
  check('falling past a wall without pushing is a free fall (no hanging in the wall)', st.vel.y < -10, `v=${st.vel.y.toFixed(1)}`);
  const c2 = new Combat(R, w, map, [ps.mover.collider]);
  const t2: Target = { id: 0, team: 'red', center: st.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1 };
  c2.targets.push(t2);
  check('a soft landing does not hurt, a hard one does', c2.fall(t2, 12) === 0 && c2.fall(t2, 20) > 0 && t2.hp < MAX_HP);
  // regen: 3 s after the last hit, 2 HP/s
  const t3: Target = { id: 1, team: 'blue', center: new Vector3(0, 5000, 0), up: new Vector3(0, 1, 0), hp: 50, alive: true, respawnIn: -1, regen: true, calm: 0 };
  c2.targets.push(t3);
  for (let k = 0; k < 64 * 2.5; k++) c2.tick(TICK_DT);
  const early = t3.hp;
  for (let k = 0; k < 64 * 2.5; k++) c2.tick(TICK_DT);
  check('health regenerates 2 HP/s after 3 s without damage', early === 50 && Math.abs(t3.hp - 54) < 0.3, `${early} → ${t3.hp.toFixed(1)}`);
  // knockback: a hit shoves the victim away from the attacker
  let pushed = new Vector3();
  const t4: Target = { id: 2, team: 'green', center: new Vector3(5, 5000, 0), up: new Vector3(0, 1, 0), hp: 100, alive: true, respawnIn: -1, onImpulse: (v) => { pushed = v.clone(); } };
  const t5: Target = { id: 3, team: 'yellow', center: new Vector3(0, 5000, 0), up: new Vector3(0, 1, 0), hp: 100, alive: true, respawnIn: -1 };
  c2.targets.push(t4, t5);
  c2.damage(t4, 30, 3, false, t4.center);
  check('damage is a third and knocks the victim away from the attacker', Math.abs(t4.hp - 90) < 1e-6 && pushed.x > 0.5, `hp=${t4.hp} push=${pushed.x.toFixed(2)}`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall good');
process.exit(failed ? 1 : 0);
