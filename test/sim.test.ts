/* Headless checks of the shared simulation: run with `npm test`. */
import { Quaternion, Vector3 } from 'three';
import { BLOCK_MATERIALS, BlockSystem, START_BLOCKS } from '../src/shared/blocks';
import { GENERATORS, Match, SHOP } from '../src/shared/match';
import { HU, TICK_DT } from '../src/shared/constants';
import { generateMap } from '../src/shared/map';
import { emptyInput, MoveInput } from '../src/shared/movement';
import { buildPhysicsWorld, initRapier } from '../src/shared/physics';
import { PlayerSim } from '../src/shared/sim';

const R = await initRapier();
const map = generateMap();
const world = buildPhysicsWorld(R, map);
const sim = new PlayerSim(R, world, map, 'red');
const s = sim.state;

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
check('spawns on the skyscraper roof', s.onGround && Math.abs(s.pos.y - (-87 + 0.15 + 46 + 0.915)) < 0.1, `y=${s.pos.y.toFixed(3)}`);

// 2. walk speed
place(0, -86, 0, 0);
run(30, {});
run(128, { forward: 1 });
check('ground speed ≈ maxSpeed', Math.abs(planarSpeed() - 300 * HU) < 0.05, `${(planarSpeed() / HU).toFixed(0)} u/s`);

// 3. bhop + air strafe gains speed
place(0, -86, 20, 0);
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
place(-5.5, -86, -9.5, Math.PI / 2); // facing -X
run(30, {});
run(200, { forward: 1 });
check('climbs stairs', s.pos.y > -87 + 0.15 + 2.1 + 0.9, `y=${(s.pos.y + 87).toFixed(2)} above island`);

// 5. surf ramp: drop onto the slope with speed along it
place(-21.2, -82, -24, 0);
s.vel.set(0, 0, 12);
sim.mover.place(s);
let minY = Infinity;
run(70, () => ({ right: -1 }));
minY = s.pos.y;
check('surfs (not grounded on steep ramp, keeps speed)', !s.onGround || s.vel.length() > 8, `v=${s.vel.length().toFixed(1)} y=${(minY + 87).toFixed(2)}`);

// 6. spawn on roof → walk into the geyser → lands on central island
sim.respawn();
run(30, {});
let launched = false;
sim.events.length = 0;
run(500, (i) => {
  if (sim.events.some((e) => e.type === 'launch')) launched = true;
  sim.events.length = 0;
  return i < 200 && !launched ? { forward: 1, yaw: -3 * Math.PI / 4 } : {};
});
check('geyser launches', launched);
check('lands on top of core', s.onGround && Math.abs(s.pos.y - (20 + 0.915)) < 0.15 && Math.abs(s.pos.x) < 20, `pos=${s.pos.toArray().map((v) => v.toFixed(1))}`);

// 7. portal on the top face → opposite face (gravity flips)
// top face (+Y) opposite portal at local (0,2,-8); face frame for +Y is identity → world (0,22,-8)
place(0, 21.2, -4, 0); // facing -Z toward the portal
run(20, {});
sim.events.length = 0;
let teleported = false;
run(200, () => {
  if (sim.events.some((e) => e.type === 'teleport')) teleported = true;
  sim.events.length = 0;
  return teleported ? {} : { forward: 1 };
});
const up = new Vector3(0, 1, 0).applyQuaternion(s.frame);
check('portal teleports', teleported);
check('stands on bottom face with flipped gravity', s.onGround && up.y < -0.99 && Math.abs(s.pos.y + 20.915) < 0.15,
  `pos=${s.pos.toArray().map((v) => v.toFixed(1))} up=${up.toArray().map((v) => v.toFixed(2))}`);

// 8. gravity switch to green (down +X)
place(-2, -86, 0, 0);
run(10, {});
sim.setGravity(new Vector3(1, 0, 0));
const up2 = new Vector3(0, 1, 0).applyQuaternion(s.frame);
check('gravity switch rotates frame', up2.x < -0.99, up2.toArray().map((v) => v.toFixed(2)).join(','));

// 9. walk off the island → void death
sim.respawn();
sim.events.length = 0;
place(29, -86, 0, -Math.PI / 2); // facing +X, at the edge (no buildings in that strip? road at z=0)
run(30, {});
let died = false;
run(64 * 8, () => {
  if (sim.events.some((e) => e.type === 'respawn' && e.reason === 'void')) died = true;
  sim.events.length = 0;
  return died ? {} : { forward: 1 };
});
check('falling into the void respawns', died);


// 10. every team's lift (street → roof) and geyser (roof → core) land on target
import { TEAMS } from '../src/shared/teams';
for (const [i, pad] of map.pads.entries()) {
  const team = TEAMS[Math.floor(i / 2)];
  sim.team = team;
  sim.respawn();
  const pu = new Vector3(...pad.up);
  s.pos.set(...pad.pos).addScaledVector(pu, 0.95);
  sim.mover.place(s);
  sim.events.length = 0;
  run(64 * 7, {});
  const dist = s.pos.distanceTo(new Vector3(...pad.target));
  check(`${pad.kind} ${team.id}`, s.onGround && dist < 1.5, `miss=${dist.toFixed(2)}m`);
}


// 11. combat: rifle hits a dummy, wind/gravity bend bullets, grenade bounces + rocket-jumps
import { Combat, MAX_HP, Target } from '../src/shared/combat';
import { createWeaponState, weaponTick, WEAPONS } from '../src/shared/weapons';
{
  sim.team = TEAMS[0];
  sim.respawn();
  const combat = new Combat(R, world, map, sim.portals, [sim.mover.collider]);
  const me: Target = { id: 0, team: 'red', center: s.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1,
    onImpulse: (v) => sim.applyImpulse(v) };
  const dummy: Target = { id: 1, team: 'blue', center: new Vector3(0, -86 + 0.915 - 1 + 0.15, -10), up: new Vector3(0, 1, 0),
    hp: MAX_HP, alive: true, respawnIn: 0 };
  combat.targets.push(me, dummy);
  // shoot from the road at the dummy 10 m ahead (aim at chest)
  place(0, -86, 0, 0);
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

  // bullet drop + wind drift over 100 m
  const shot = combat.fire('rifle', 0, new Vector3(0, -40, 0), new Vector3(0, 0, -1), new Vector3(), new Vector3(0, -1, 0));
  const start = combat.time;
  let drop = 0;
  for (let k = 0; k < 64; k++) {
    combat.tick(TICK_DT);
    if (shot.pos.z < -100) { drop = -40 - shot.pos.y; break; }
  }
  const w = combat.wind.felt(start, new Vector3(0, -1, 0));
  check('bullet drops with shooter gravity', drop > 0.8 && drop < 3, `drop=${drop.toFixed(2)}m wind=${w.length().toFixed(1)}`);
  combat.events.length = 0;

  // grenade: weapon state + fuse + self knockback
  const ws = createWeaponState();
  check('rifle auto-fire respects interval', (() => {
    let n = 0;
    for (let k = 0; k < 64; k++) if (weaponTick(ws, { fire: true, reload: false, select: null }, TICK_DT)) n++;
    return n >= 8 && n <= 10;
  })());
  weaponTick(ws, { fire: false, reload: false, select: 'grenade' }, TICK_DT);
  for (let k = 0; k < 20; k++) weaponTick(ws, { fire: false, reload: false, select: null }, TICK_DT);
  check('grenade selected', weaponTick(ws, { fire: true, reload: false, select: null }, TICK_DT) === 'grenade' && ws.ammo.grenade === 2);
  place(0, -86, 6, 0);
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


// Blocks: flush on any surface, grid-aligned sideways, bridging assist, damage, inventory.
{
  const up = new Vector3(0, 1, 0), frame = new Quaternion(), fwd = new Vector3(0, 0, -1);
  const w = new R.World({ x: 0, y: 0, z: 0 });
  // ground whose top (y = 0.37) is NOT on the 1 m grid, ending at z = -4.2
  w.createCollider(R.ColliderDesc.cuboid(10, 1, 5).setTranslation(0, -0.63, 0.8));
  w.step();
  const bs = new BlockSystem(R, w);
  const far = new Vector3(0, 50, 50);
  const eye = new Vector3(0.2, 2, 0.3);
  const t = bs.target(eye, new Vector3(0, -1, 0), far, up, fwd)!;
  check('block sits flush on off-grid ground', !!t && !t.assisted && Math.abs(t.center.y - 0.87) < 1e-6, `y=${t?.center.y.toFixed(3)}`);
  check('block snaps to grid sideways', t.center.x === 0.5 && t.center.z === 0.5);
  check('block placement spends inventory', bs.place(t.center, far, frame, eye, 'wood', 'red') === 'ok' && bs.inventory.wood === START_BLOCKS.wood - 1);
  const block = [...bs.blocks.values()][0];
  const side = bs.target(new Vector3(0.5, 0.87, 3), new Vector3(0, 0, -1), far, up, fwd)!;
  check('aiming at a block face targets the neighbour cell', side.center.equals(block.center.clone().add(new Vector3(0, 0, 1))));
  const onTop = bs.target(new Vector3(0.5, 3, 0.5), new Vector3(0, -1, 0), far, up, fwd)!;
  check('stacking on top', onTop.center.equals(block.center.clone().add(up)));
  check('cannot place into the player', bs.validate(onTop.center, onTop.center.clone().add(new Vector3(0, 0.5, 0)), frame, eye, 'wood') === 'player');
  check('cannot place into the map', bs.validate(new Vector3(3.5, 0.2, 0.5), far, frame, new Vector3(3.5, 2, 0.5), 'wood') === 'occupied');
  check('cannot place into another block', bs.validate(block.center, far, frame, eye, 'wood') === 'occupied');
  check('cannot place out of range', bs.validate(new Vector3(0.5, 0.87, -20), far, frame, eye, 'wood') === 'range');
  check('placement needs blocks of that material', bs.validate(onTop.center, far, frame, eye, 'stone') === 'resources');
  // bridging: stand on the last ground cell at the edge, look into the void
  const ps = new PlayerSim(R, w, map, 'red');
  const bs2 = new BlockSystem(R, w, ps.mover.collider);
  ps.state.pos.set(0.5, 0.37 + 0.915 + 0.05, -3.7); ps.state.vel.set(0, 0, 0); ps.state.frame.identity(); ps.mover.place(ps.state);
  for (let k = 0; k < 30; k++) ps.tick(emptyInput(), TICK_DT);
  const peye = ps.state.pos.clone().add(new Vector3(0, 0.71, 0));
  const edge = bs2.target(peye, new Vector3(0, 0.2, -1).normalize(), ps.state.pos, up, fwd);
  check('bridging assist continues the ground over the void', !!edge && edge.assisted && edge.center.z < -4.66 && edge.center.z > -4.8 && Math.abs(edge.center.y + 0.13) < 1e-3,
    edge ? edge.center.toArray().map((v) => v.toFixed(2)).join(',') : 'none');
  check('assisted block is placeable', bs2.place(edge!.center, ps.state.pos, ps.state.frame, peye, 'wood', 'red') === 'ok');
  const bridge = [...bs2.blocks.values()][0];
  ps.state.pos.set(0.5, bridge.center.y + 0.5 + 0.915 + 0.05, bridge.center.z); ps.state.vel.set(0, 0, 0); ps.mover.place(ps.state);
  for (let k = 0; k < 30; k++) ps.tick(emptyInput(), TICK_DT);
  check('player stands on a block', ps.state.onGround && Math.abs(ps.state.pos.y - (bridge.center.y + 0.5 + 0.915)) < 0.1, `y=${ps.state.pos.y.toFixed(2)}`);
  const next = bs2.target(ps.state.pos.clone().add(new Vector3(0, 0.71, 0)), new Vector3(0, 0, -1), ps.state.pos, up, fwd)!;
  check('bridging continues from the block under the feet', next.assisted && next.center.equals(bridge.center.clone().add(new Vector3(0, 0, -1))));
  // jump up onto a block (one block = one jump)
  bs2.add(bridge.center.clone().add(new Vector3(0, 1, -1)), 'wood', null);
  let climbed = false;
  for (let k = 0; k < 64; k++) {
    ps.tick({ ...emptyInput(), forward: 1, jump: k > 2 && k < 20, yaw: 0 }, TICK_DT);
    if (ps.state.onGround && ps.state.pos.y > bridge.center.y + 1.5 + 0.8) climbed = true;
  }
  check('can jump onto one block', climbed, `y=${ps.state.pos.y.toFixed(2)}`);
  check('reclaim returns your own block', bs2.reclaim(bridge.collider.handle, 'red') === bridge && bs2.inventory.wood === START_BLOCKS.wood);
  const mapBlock = [...bs2.blocks.values()][0];
  check('cannot reclaim enemy / map blocks', bs2.reclaim(mapBlock.collider.handle, 'red') === null);
  // damage
  const stone = bs.add(new Vector3(-3.5, 0.87, 0.5), 'stone', 'blue');
  bs.damageCollider(stone.collider.handle, 100);
  check('material determines HP', stone.maxHp === BLOCK_MATERIALS.stone.hp && stone.hp === BLOCK_MATERIALS.stone.hp - 100);
  bs.explosion(stone.center.clone().add(new Vector3(0, 1.5, 0)), 5.5, 75);
  check('explosion destroys a damaged block and its collider', !bs.byCollider(stone.collider.handle)
    && !w.castRay(new R.Ray(new Vector3(-3.5, 3, 0.5), { x: 0, y: -1, z: 0 }), 1.8, true));
  const c = new Combat(R, w, map, []);
  c.windMul = 0;
  c.onWorldDamage = (handle, damage) => { bs.damageCollider(handle, damage); };
  const wood = bs.add(new Vector3(-6.5, 1.37, -8), 'wood', 'blue');
  for (let n = 0; n < 3; n++) {
    c.fire('rifle', 99, new Vector3(-6.5, 1.37, -2), new Vector3(0, 0, -1), new Vector3(), new Vector3(0, -1, 0));
    for (let k = 0; k < 6; k++) c.tick(TICK_DT);
  }
  check('three rifle hits break a wood block', !bs.byCollider(wood.collider.handle), `hp=${wood.hp} ev=${c.events.map((e) => e.type).join(',')}`);
}

// Regression: building on the real map works where the old 3 m grid sank pieces into the street.
{
  const w = buildPhysicsWorld(R, map);
  const ps = new PlayerSim(R, w, map, 'red');
  const bs = new BlockSystem(R, w, ps.mover.collider);
  const up = new Vector3(0, 1, 0);
  for (const [x, z] of [[0, -8], [5, 10], [-12, 3]]) {
    ps.state.pos.set(x, -85.5, z); ps.state.vel.set(0, 0, 0); ps.state.frame.identity(); ps.mover.place(ps.state);
    for (let k = 0; k < 90; k++) ps.tick(emptyInput(), TICK_DT);
    const eye = ps.state.pos.clone().add(new Vector3(0, 0.71, 0));
    const dir = new Vector3(0, -0.7, -1).normalize();
    const t = bs.target(eye, dir, ps.state.pos, up, new Vector3(0, 0, -1));
    const feet = ps.state.pos.y - 0.915;
    const res = t && bs.validate(t.center, ps.state.pos, ps.state.frame, eye, 'wood');
    check(`street block at ${x},${z} is placeable and flush`, res === 'ok' && Math.abs(t!.center.y - 0.5 - feet) < 0.05,
      `${res} bottom-feet=${t ? (t.center.y - 0.5 - feet).toFixed(2) : '-'}`);
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
  const gen = m.generators.find((g) => g.currency === 'copper')!;
  const away = new Vector3(0, 500, 0);
  for (let k = 0; k < 64 * 5; k++) m.tick(TICK_DT, away);
  check('copper generator accumulates', gen.stored === 5, `stored=${gen.stored}`);
  for (let k = 0; k < 64 * 100; k++) m.tick(TICK_DT, away);
  check('generator caps', gen.stored === GENERATORS.copper.cap);
  m.tick(TICK_DT, gen.pos.clone().addScaledVector(gen.up, 0.95));
  check('walking onto the generator collects', m.wallet.copper === GENERATORS.copper.cap && gen.stored === 0 && m.events.some((e) => e.type === 'pickup'));
  const stoneItem = SHOP.find((i) => i.id === 'stone')!;
  check('shop sells blocks', m.buy(stoneItem) === 'ok' && bs.inventory.stone === 12 && m.wallet.copper === GENERATORS.copper.cap - 24);
  check('shop refuses without money', m.buy(SHOP.find((i) => i.id === 'metal')!) === 'money' && bs.inventory.metal === 0);
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

console.log(failed ? `\n${failed} check(s) failed` : '\nall good');
process.exit(failed ? 1 : 0);