/* Headless checks of the shared simulation: run with `npm test`. */
import { Quaternion, Vector3 } from 'three';
import {
  BLOCK_MATERIALS, BlockSystem, PIECE_CELL, PIECE_COST, PIECE_HP_MUL, PIECE_LEVEL, PIECE_THICK, START_BLOCKS,
} from '../src/shared/blocks';
import { BOT, BotManager } from '../src/shared/bots';
import { GENERATORS, Match } from '../src/shared/match';
import { APPLE_HEAL, BUILDER_WOOD, Economy, ITEMS, LADDER, Pickups, PICKUPS, SHOP } from '../src/shared/economy';
import { Fishing, FISHING } from '../src/shared/fishing';
import { HU, TICK_DT, WORLD } from '../src/shared/constants';
import { generateMap, PLAYGROUND } from '../src/shared/map';
import { emptyInput, MoveInput } from '../src/shared/movement';
import { buildPhysicsWorld, initRapier } from '../src/shared/physics';
import { PlayerSim } from '../src/shared/sim';

const R = await initRapier();
const map = generateMap();
const world = buildPhysicsWorld(R, map);
const sim = new PlayerSim(R, world, map, 'red');
const s = sim.state;
/** Ground of the red island (its frame is the world frame shifted down). */
const G = -WORLD.islandDistance;
const [PX, PZ] = PLAYGROUND;

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

// 1. spawn & stand
run(64, {});
check('spawns on the skyscraper roof', s.onGround && Math.abs(s.pos.y - (G + 0.15 + 50 + 0.915)) < 0.1, `y=${s.pos.y.toFixed(3)}`);

// 2. walk speed (along the road x = 14)
place(14, G + 1, 10, 0);
run(30, {});
run(128, { forward: 1 });
check('ground speed ≈ maxSpeed', Math.abs(planarSpeed() - 300 * HU) < 0.05, `${(planarSpeed() / HU).toFixed(0)} u/s`);

// 3. bhop + air strafe gains speed
place(0, WORLD.coreHalf + 1, 0, 0); // open middle of the top core face
run(30, {});
run(40, { forward: 1 });
let maxSp = 0;
run(320, () => {
  const yaw = Math.atan2(-s.vel.x, -s.vel.z);
  maxSp = Math.max(maxSp, planarSpeed());
  return { jump: true, right: 1, yaw };
});
check('air strafe + bhop gains speed', maxSp > 500 * HU, `max ${(maxSp / HU).toFixed(0)} u/s`);

// 4. stairs (playground on red island, local == world because red frame is identity)
place(-5.5 + PX, G + 1, -9.5 + PZ, Math.PI / 2); // facing -X
run(30, {});
run(200, { forward: 1 });
check('climbs stairs', s.pos.y > G + 0.15 + 2.1 + 0.9, `y=${(s.pos.y - G).toFixed(2)} above island`);

// 5. surf ramp: drop onto the slope with speed along it
place(-21.2 + PX, G + 5, -24 + PZ, 0);
s.vel.set(0, 0, 12);
sim.mover.place(s);
let minY = Infinity;
run(70, () => ({ right: -1 }));
minY = s.pos.y;
check('surfs (not grounded on steep ramp, keeps speed)', !s.onGround || s.vel.length() > 8, `v=${s.vel.length().toFixed(1)} y=${(minY - G).toFixed(2)}`);

// 6. spawn on roof → walk into the geyser → lands on the middle island
sim.respawn();
run(30, {});
let launched = false;
sim.events.length = 0;
run(64 * 10, (i) => {
  if (sim.events.some((e) => e.type === 'launch')) launched = true;
  sim.events.length = 0;
  return i < 200 && !launched ? { forward: 1, yaw: -3 * Math.PI / 4 } : {};
});
check('geyser launches', launched);
check('lands on the middle island', s.onGround && Math.abs(s.pos.y - (-WORLD.midDistance + 0.15 + 0.915)) < 0.15 && Math.abs(s.pos.x - 26) < 3, `pos=${s.pos.toArray().map((v) => v.toFixed(1))}`);

// 7. middle island gate → own (far) core face; then the top face's opposite portal → bottom face (gravity flips)
const throughPortal = (x: number, y: number, z: number) => {
  place(x, y, z, 0); // facing -Z toward the portal
  run(20, {});
  sim.events.length = 0;
  let teleported = false;
  run(200, () => {
    if (sim.events.some((e) => e.type === 'teleport')) teleported = true;
    sim.events.length = 0;
    return teleported ? {} : { forward: 1 };
  });
  return teleported;
};
check('mid gate teleports to the core', throughPortal(0, -WORLD.midDistance + 1.2, 4));
run(30, {});
check('stands on own core face', s.onGround && Math.abs(s.pos.y - (WORLD.coreHalf + 0.915)) < 0.15, `pos=${s.pos.toArray().map((v) => v.toFixed(1))}`);
const teleported = throughPortal(0, WORLD.coreHalf + 1.2, -20);
run(30, {});
const up = new Vector3(0, 1, 0).applyQuaternion(s.frame);
check('portal teleports', teleported);
check('stands on bottom face with flipped gravity', s.onGround && up.y < -0.99 && Math.abs(s.pos.y + WORLD.coreHalf + 0.915) < 0.15,
  `pos=${s.pos.toArray().map((v) => v.toFixed(1))} up=${up.toArray().map((v) => v.toFixed(2))}`);

// 8. gravity switch to green (down +X)
place(14, G + 1, 0, 0);
run(10, {});
sim.setGravity(new Vector3(1, 0, 0));
const up2 = new Vector3(0, 1, 0).applyQuaternion(s.frame);
check('gravity switch rotates frame', up2.x < -0.99, up2.toArray().map((v) => v.toFixed(2)).join(','));

// 9. walk off the island → void death
sim.respawn();
sim.events.length = 0;
place(WORLD.islandHalf - 1, G + 1, 0, -Math.PI / 2); // facing +X, at the torn edge of the (always present) tile (2,0)
run(30, {});
let died = false;
run(64 * 8, () => {
  if (sim.events.some((e) => e.type === 'respawn' && e.reason === 'void')) died = true;
  sim.events.length = 0;
  return died ? {} : { forward: 1 };
});
check('falling into the void respawns', died);


// 10. every team's lift (street → roof), descent (roof → street) and geyser (roof → middle island) land on target
import { TEAMS } from '../src/shared/teams';
for (const [i, pad] of map.pads.entries()) {
  const team = TEAMS.find((t) => t.id === pad.team)!;
  sim.team = team;
  sim.respawn();
  const pu = new Vector3(...pad.up);
  s.pos.set(...pad.pos).addScaledVector(pu, 0.95);
  sim.mover.place(s);
  sim.events.length = 0;
  run(64 * 9, {});
  const dist = s.pos.distanceTo(new Vector3(...pad.target));
  // the geyser lands at speed and slides a little on the landing plaza
  check(`${pad.kind} ${team.id}`, s.onGround && dist < (pad.kind === 'geyser' ? 2.5 : 1.5), `miss=${dist.toFixed(2)}m`);
}


// 11. combat: rifle hits a dummy, wind/gravity bend bullets, grenade bounces + rocket-jumps
import { Combat, MAX_HP, Target } from '../src/shared/combat';
import { createWeaponState, damageFalloff, giveWeapon, hasAmmo, weaponTick, WEAPONS } from '../src/shared/weapons';
{
  sim.team = TEAMS[0];
  sim.respawn();
  const combat = new Combat(R, world, map, sim.portals, [sim.mover.collider]);
  const me: Target = { id: 0, team: 'red', center: s.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1,
    onImpulse: (v) => sim.applyImpulse(v) };
  const dummy: Target = { id: 1, team: 'blue', center: new Vector3(14, G + 1.065, -10), up: new Vector3(0, 1, 0),
    hp: MAX_HP, alive: true, respawnIn: 0 };
  combat.targets.push(me, dummy);
  // shoot from the road at the dummy 10 m ahead (aim at chest)
  place(14, G + 1, 0, 0);
  run(30, {});
  const eye = s.pos.clone().add(new Vector3(0, 0.71, 0));
  let hits = 0;
  let killed = false;
  for (let i = 0; i < 6; i++) {
    const dir = dummy.center.clone().sub(eye).normalize();
    combat.fire('rifle', 0, eye, dir, s.vel, new Vector3(0, -1, 0));
    for (let k = 0; k < 20; k++) combat.tick(TICK_DT);
    for (const e of combat.events.splice(0)) if (e.type === 'hit' && e.target === 1) { hits++; killed ||= e.killed; }
  }
  check('rifle hits dummy at 10 m', hits === 5 && killed, `hits=${hits} killed=${killed}`);
  check('dead dummy respawns', (() => { for (let k = 0; k < 64 * 3.2; k++) combat.tick(TICK_DT); return dummy.alive && dummy.hp === MAX_HP; })());

  // bullet drop + wind drift over 100 m (in empty space off the ±Z core faces)
  const shot = combat.fire('rifle', 0, new Vector3(0, 0, -100), new Vector3(0, 0, -1), new Vector3(), new Vector3(0, -1, 0));
  const start = combat.time;
  let drop = 0;
  for (let k = 0; k < 64; k++) {
    combat.tick(TICK_DT);
    if (shot.pos.z < -200) { drop = -shot.pos.y; break; }
  }
  const w = combat.wind.felt(start, new Vector3(0, -1, 0));
  check('bullet drops with shooter gravity', drop > 0.8 && drop < 3, `drop=${drop.toFixed(2)}m wind=${w.length().toFixed(1)}`);
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
    return n >= 8 && n <= 10;
  })());
  for (let k = 0; k < 64 * 4; k++) tick(true);
  check('empty gun without spare ammo does not fire or reload', ws.ammo.rifle === 0 && ws.reloadT === 0 && tick(true) === null && !hasAmmo(ws, 'rifle'));
  ws.reserve.rifle = 40;
  tick(false, { reload: true });
  for (let k = 0; k < 64 * 2; k++) tick(false);
  check('reload moves spare rounds into the magazine', ws.ammo.rifle === 30 && ws.reserve.rifle === 10, `mag=${ws.ammo.rifle} spare=${ws.reserve.rifle}`);
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
  check('punch hits up close for small damage', near === WEAPONS.fists.damage && far === 0, `near=${near} far=${far}`);
  punchDummy.alive = false;
  combat.events.length = 0;
  place(14, G + 1, 6, 0);
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
  const bs = new BlockSystem(R, w, ps.mover.collider);
  const stand = (x: number, y: number, z: number) => {
    ps.state.pos.set(x, y + 0.915 + 0.05, z); ps.state.vel.set(0, 0, 0); ps.state.frame.identity(); ps.mover.place(ps.state);
    for (let k = 0; k < 20; k++) ps.tick(emptyInput(), TICK_DT);
  };
  const near = (v: Vector3, x: number, y: number, z: number) => v.distanceTo(new Vector3(x, y, z)) < 1e-3;
  stand(1, 0, 1);
  const wall = bs.plan('wall', ps.state.pos, up, fwd)!;
  check('wall goes on the next grid line in front', near(wall.center, 2, PIECE_LEVEL / 2, 0), wall.center.toArray().map((v) => v.toFixed(2)).join(','));
  const wallThick = new Vector3(1, 0, 0).applyQuaternion(wall.quat);
  check('wall faces the player', Math.abs(Math.abs(wallThick.z) - 1) < 1e-6, wallThick.toArray().map((v) => v.toFixed(2)).join(','));
  const floor = bs.plan('floor', ps.state.pos, up, fwd)!;
  check('floor fills the cell in front at feet level', near(floor.center, 2, -PIECE_THICK / 2, -PIECE_CELL / 2));
  check('placing spends material', bs.place(floor, 'wood', 'red') === 'ok' && bs.inventory.wood === START_BLOCKS.wood - PIECE_COST);
  check('one piece per slot', bs.validate(bs.plan('floor', ps.state.pos, up, fwd)!, 'wood') === 'occupied');
  check('needs material', bs.validate(wall, 'stone') === 'resources');
  const piece = [...bs.blocks.values()][0];
  check('piece HP from material', piece.maxHp === BLOCK_MATERIALS.wood.hp * PIECE_HP_MUL);
  check('pick-up refunds the piece', bs.reclaim(piece.collider.handle, 'red') === piece && bs.inventory.wood === START_BLOCKS.wood);
  // a piece cannot go into a character
  stand(2, 0, 0.3);
  const blocked = bs.plan('wall', new Vector3(2, 0.965, 2.5), up, fwd)!;
  check('cannot build into the player', near(blocked.center, 2, PIECE_LEVEL / 2, 0) && bs.validate(blocked, 'wood') === 'player');
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
  fb.damageCollider(stone.collider.handle, 100);
  check('material determines HP', stone.maxHp === BLOCK_MATERIALS.stone.hp && stone.hp === BLOCK_MATERIALS.stone.hp - 100);
  fb.explosion(stone.center.clone().add(new Vector3(0, 1.5, 0)), 5.5, 75);
  check('explosion destroys a damaged block and its collider', !fb.byCollider(stone.collider.handle)
    && !bw.castRay(new R.Ray(new Vector3(-3.5, 3, 0.5), { x: 0, y: -1, z: 0 }), 1.8, true));
  const c = new Combat(R, bw, map, []);
  c.windMul = 0;
  c.onWorldDamage = (handle, damage) => { fb.damageCollider(handle, damage); };
  const wood = fb.add(new Vector3(-6.5, 1.37, -8), 'wood', 'blue');
  for (let n = 0; n < 3; n++) {
    c.fire('rifle', 99, new Vector3(-6.5, 1.37, -2), new Vector3(0, 0, -1), new Vector3(), new Vector3(0, -1, 0));
    for (let k = 0; k < 6; k++) c.tick(TICK_DT);
  }
  check('three close rifle hits break a wood block', !fb.byCollider(wood.collider.handle), `hp=${wood.hp}`);
  const farWood = fb.add(new Vector3(-6.5, 1.37, -40), 'wood', 'blue');
  c.fire('rifle', 99, new Vector3(-6.5, 1.37, -2), new Vector3(0, 0, -1), new Vector3(), new Vector3(0, -1, 0));
  for (let k = 0; k < 64; k++) c.tick(TICK_DT);
  const farDmg = BLOCK_MATERIALS.wood.hp - farWood.hp;
  check('rifle damage falls off with distance', farDmg > 0 && farDmg < WEAPONS.rifle.damage * 0.6, `damage at 38 m = ${farDmg}`);
  check('falloff curve', damageFalloff(WEAPONS.rifle, 5) === 1 && damageFalloff(WEAPONS.rifle, 1000) === WEAPONS.rifle.falloff!.min
    && damageFalloff(WEAPONS.rifle, 25) < 1 && damageFalloff(WEAPONS.rifle, 25) > WEAPONS.rifle.falloff!.min);
}

// Building on the real map: pieces fit on the streets of the island.
{
  const w = buildPhysicsWorld(R, map);
  const ps = new PlayerSim(R, w, map, 'red');
  const bs = new BlockSystem(R, w, ps.mover.collider);
  const up = new Vector3(0, 1, 0);
  for (const [x, z] of [[14, -8], [14, 20], [-14, 1]]) {
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
  for (const b of [...bs.blocks.values()]) if (b.team === 'blue') bs.damageCollider(b.collider.handle, 1000);
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

// Economy: start broke, sell junk, the purchase ladder, ammo per gun.
{
  const w = buildPhysicsWorld(R, map);
  const bs = new BlockSystem(R, w);
  bs.inventory.wood = 0;
  const ws = createWeaponState();
  const eco = new Economy({ cash: 0, crystal: 0 }, bs, ws);
  const item = (id: string) => SHOP.find((i) => i.id === id)!;
  const shelf = () => eco.offers().map((o) => `${o.item.id}:${o.state}`).join(' ');
  check('start with no money and no tools', eco.wallet.cash === 0 && !eco.has('rod') && ws.current === 'fists');
  check('only the rod is open at first', eco.buy(item('pistol')) === 'locked' && eco.buy(item('rod')) === 'money'
    && eco.offers().filter((o) => o.state !== 'locked').every((o) => o.item.id === 'rod' || o.item.id === 'heal'), shelf());
  eco.items.bottle = 4; eco.items.apple = 1; eco.items.fish = 1;
  const value = eco.sellValue;
  check('selling pays per item, cheaply', eco.sellAll() === value && value === 4 * ITEMS.bottle.sell + ITEMS.apple.sell + ITEMS.fish.sell
    && eco.wallet.cash === value && eco.items.bottle === 0, `got ${value}`);
  eco.wallet.cash = 1000;
  const order: string[] = [];
  for (let guard = 0; guard < 10; guard++) {
    const next = eco.offers().find((o) => o.state === 'ok' && o.item.step && !eco.has(o.item.step));
    if (!next) break;
    order.push(next.item.step!);
    eco.buy(next.item);
  }
  check('purchase ladder: rod → build tool → pistol → rifle → grenades → blocks', order.join(',') === LADDER.join(','), order.join(','));
  check('build tool comes with some wood', bs.inventory.wood === BUILDER_WOOD);
  check('weapons from the shop come loaded, no spare ammo', ws.owned.pistol && ws.ammo.pistol === WEAPONS.pistol.mag && ws.reserve.pistol === 0
    && ws.owned.rifle && ws.ammo.grenade === 2);
  check('bought tools leave the shelf', !eco.offers().some((o) => ['rod', 'builder', 'pistol', 'rifle'].includes(o.item.id)), shelf());
  eco.buy(item('ammo-pistol'));
  check('ammo is bought per gun', ws.reserve.pistol === 12 && ws.reserve.rifle === 0);
  eco.buy(item('grenade'));
  check('grenades are capped', eco.buy(item('grenade')) === 'full' && ws.ammo.grenade === WEAPONS.grenade.mag);
  eco.items.apple = 1;
  check('eating takes an apple', eco.eat() && eco.items.apple === 0 && !eco.eat() && APPLE_HEAL > 0);
}

// Pickups: apples under trees, bottles on the streets of every base island; taken items come back later.
{
  const w = buildPhysicsWorld(R, map);
  const p = new Pickups(R, w, map);
  const apples = p.items.filter((i) => i.kind === 'apple');
  const bottles = p.items.filter((i) => i.kind === 'bottle');
  const trees = map.trees.filter((t) => t.kind === 'tree').length;
  check('an apple under (almost) every tree', apples.length >= trees * 0.9, `${apples.length}/${trees}`);
  check('bottles on every base island', TEAMS.every((t) => bottles.filter((b) => b.up.equals(new Vector3(...t.down).negate())).length === PICKUPS.bottlesPerIsland),
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

// Bots: verified drop points, a full headless match (player parked out of reach): crystals fall, nobody gets lost.
{
  const w = buildPhysicsWorld(R, map);
  const ps = new PlayerSim(R, w, map, 'red');
  const combat = new Combat(R, w, map, ps.portals, [ps.mover.collider]);
  const bs = new BlockSystem(R, w, ps.mover.collider);
  combat.onWorldDamage = (h, d) => { bs.damageCollider(h, d); };
  combat.onExplosion = (p, r, d) => bs.explosion(p, r, d);
  const m = new Match(R, w, map, bs, 'red', ps.mover.collider);
  const me: Target = { id: 0, team: 'red', center: ps.state.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1 };
  ps.state.pos.set(0, -3000, 0);
  ps.mover.place(ps.state);
  combat.targets.push(me);
  const bots = new BotManager(R, w, map, combat, m, bs, 'red');
  check('every core face has a verified drop point', TEAMS.every((t) => bots.dropOk.has(t.id)),
    TEAMS.filter((t) => !bots.dropOk.has(t.id)).map((t) => t.id).join(' '));
  check('two bots per enemy team', bots.bots.length === (TEAMS.length - 1) * 2 && !bots.bots.some((b) => b.team === 'red'));
  check('bots start with fists like the player', bots.bots.every((b) => b.weapons.current === 'fists' && !b.weapons.owned.pistol));
  let kills = 0;
  let pistolAt = -1;
  let maxAir = 0;
  const air = new Map<number, number>();
  const t0 = performance.now();
  for (let k = 0; k < 64 * 240; k++) {
    bots.tick(TICK_DT);
    combat.tick(TICK_DT);
    m.tick(TICK_DT, ps.state.pos);
    for (const e of combat.events.splice(0)) if (e.type === 'hit' && e.killed) kills++;
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
  check('bots break crystals within 4 minutes', broken.length > 0, `broken=${broken.join(',')}`);
  check('bots fight each other', kills >= 2, // 3 enemy teams on a big map: fewer encounters in 4 min
    `kills=${kills}`);
  check('no bot stays airborne for long', maxAir < 10, `max=${maxAir.toFixed(1)}s`);
  check('bot positions stay finite', bots.bots.every((b) => b.sim.state.pos.toArray().every(Number.isFinite)));
  check('bots are cheap to simulate', (performance.now() - t0) / 240 < 40, `${((performance.now() - t0) / 240).toFixed(1)} ms per game second`);
}

// Slopes: walking up / down a ramp keeps full ground speed and stays grounded (build ramps are ~37°).
for (const deg of [20, 37, 45]) {
  const w = new R.World({ x: 0, y: 0, z: 0 });
  w.createCollider(R.ColliderDesc.cuboid(60, 1, 60).setTranslation(0, -1, 0));
  const a = (deg * Math.PI) / 180, L = 20;
  const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), a); // rises toward -Z
  const c = new Vector3(0, (Math.sin(a) * L) / 2, (-Math.cos(a) * L) / 2).add(new Vector3(0, -0.5, 0).applyQuaternion(q));
  w.createCollider(R.ColliderDesc.cuboid(4, 0.5, L / 2).setTranslation(c.x, c.y, c.z).setRotation(q));
  w.step();
  const ps = new PlayerSim(R, w, map, 'red');
  const walk = (z: number, y: number, yaw: number) => {
    ps.state.pos.set(0, y, z); ps.state.vel.set(0, 0, 0); ps.state.frame.identity(); ps.mover.place(ps.state);
    for (let k = 0; k < 20; k++) ps.tick(emptyInput(), TICK_DT);
    let dist = 0, air = 0;
    for (let k = 0; k < 90; k++) {
      const z0 = ps.state.pos.z;
      ps.tick({ ...emptyInput(), forward: 1, yaw }, TICK_DT);
      if (k >= 30) { dist += Math.abs(ps.state.pos.z - z0); if (!ps.state.onGround) air++; }
    }
    return { speed: dist / (60 * TICK_DT) / HU, air };
  };
  const upR = walk(4, 1, 0);
  const downR = walk(-Math.cos(a) * L + 2, Math.sin(a) * L + 1, Math.PI);
  check(`${deg}° ramp: full speed up and down, grounded`, upR.speed > 290 && downR.speed > 290 && upR.air + downR.air <= 2,
    `up ${upR.speed.toFixed(0)} u/s, down ${downR.speed.toFixed(0)} u/s, airborne ticks ${upR.air + downR.air}`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall good');
process.exit(failed ? 1 : 0);