/* Headless checks of the shared simulation: run with `npm test`. */
import { Quaternion, Vector3 } from 'three';
import { BUILD_MATERIALS, BuildSystem, planBuild } from '../src/shared/building';
import { buildAim } from '../src/shared/buildAim';
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


// Construction: common world grid, gravity-relative orientation, validation, damage and colliders.
{
  const w = new R.World({x:0,y:0,z:0});
  const bs = new BuildSystem(R, w);
  const pos = new Vector3(0, 0, 0), frame = new Quaternion(), eye = new Vector3(0, 0, 0);
  const plan = planBuild('floor', new Vector3(3.2, 0.1, -3.2), new Vector3(0,1,0), new Vector3(0,0,-1));
  check('build snaps to world grid', plan.cell.equals(new Vector3(3,0,-3)));
  check('build places and deducts materials', bs.place(plan,pos,frame,eye) === 'ok' && bs.resources.wood === 190 && bs.pieces.size === 1);
  const rotated = planBuild('floor', new Vector3(3.2, 0.1, -3.2), new Vector3(0,1,0), new Vector3(0,0,-1), 1);
  check('same floor rotated cannot be duplicated', bs.place(rotated,pos,frame,eye) === 'duplicate' && bs.resources.wood === 190);
  const wall = planBuild('wall', new Vector3(0,0,0), new Vector3(0,1,0), new Vector3(0,0,-1));
  check('building cannot intersect player', bs.validate(wall,wall.position,frame,eye) === 'player');
  check('cannot place out of range', bs.validate(planBuild('wall',new Vector3(30,0,0),new Vector3(0,1,0),new Vector3(0,0,-1)),pos,frame,eye) === 'range');
  const hit = w.castRay(new R.Ray(plan.position.clone().add(new Vector3(0,3,0)), {x:0,y:-1,z:0}), 6, true);
  check('building collider blocks ray', !!hit);
  const piece = [...bs.pieces.values()][0];
  bs.damageCollider(piece.collider.handle, 40);
  check('building receives damage', piece.hp === 60 && bs.pieces.size === 1);
  bs.explosion(piece.plan.position, 5.5, 75);
  check('explosion destroys building and collider', bs.pieces.size === 0 && !w.castRay(new R.Ray(plan.position.clone().add(new Vector3(0,3,0)), {x:0,y:-1,z:0}), 6, true));
  bs.resources.wood = 0;
  check('build requires materials', bs.validate(plan,pos,frame,eye) === 'resources');
  for (const up of [new Vector3(0,1,0),new Vector3(0,-1,0),new Vector3(1,0,0),new Vector3(-1,0,0),new Vector3(0,0,1),new Vector3(0,0,-1)]) {
    const f = Math.abs(up.z) > 0.9 ? new Vector3(1,0,0) : new Vector3(0,0,-1);
    const p = planBuild('ramp',new Vector3(5,5,5),up,f);
    const normal = new Vector3(0,1,0).applyQuaternion(p.rotation);
    check(`ramp follows gravity ${up.toArray()}`, Math.abs(normal.dot(up)-Math.SQRT1_2)<0.0001);
  }
  const w2 = new R.World({x:0,y:0,z:0});
  w2.createCollider(R.ColliderDesc.cuboid(2,2,2).setTranslation(3,0,-3)); w2.step();
  check('world geometry blocks placement', new BuildSystem(R,w2).validate(plan,pos,frame,eye) === 'occupied');
  const w3 = new R.World({x:0,y:0,z:0});
  const bs3 = new BuildSystem(R,w3);
  const wall3 = planBuild('wall',new Vector3(0,0,-6),new Vector3(0,1,0),new Vector3(0,0,-1));
  bs3.place(wall3,pos,frame,eye);
  const c = new Combat(R,w3,map,[]); c.windMul=0;
  c.onWorldDamage=(handle, damage) => { bs3.damageCollider(handle,damage); };
  for (let n=0;n<5;n++) {
    c.fire('rifle', 99, new Vector3(0,0,0), new Vector3(0,0,-1), new Vector3(), new Vector3(0,-1,0));
    for(let k=0;k<6;k++) c.tick(TICK_DT);
  }
  check('rifle projectiles destroy a build through combat', bs3.pieces.size===0);
  const w4 = new R.World({x:0,y:0,z:0});
  const ps = new PlayerSim(R,w4,map,'red');
  const bs4 = new BuildSystem(R,w4,ps.mover.collider);
  bs4.place(plan, new Vector3(0,0,0), frame, eye);
  ps.state.pos.set(3,2,-3); ps.state.vel.set(0,0,0); ps.state.frame.identity(); ps.mover.place(ps.state);
  for(let k=0;k<100;k++) ps.tick(emptyInput(),TICK_DT);
  check('player can stand on a built floor', ps.state.onGround && Math.abs(ps.state.pos.y - (-1.32 + 1.83/2)) < 0.12, `y=${ps.state.pos.y.toFixed(2)}`);
  const w5 = new R.World({x:0,y:0,z:0}); const bs5 = new BuildSystem(R,w5);
  const stonePlan = planBuild('floor',new Vector3(0,0,-6),new Vector3(0,1,0),new Vector3(0,0,-1));
  check('stone placement spends stone only', bs5.place(stonePlan,pos,frame,eye,'stone') === 'ok' && bs5.resources.stone===90 && bs5.resources.wood===200);
  const stone = [...bs5.pieces.values()][0];
  check('material determines HP',stone.hp===BUILD_MATERIALS.stone.hp);
  const next = buildAim('floor',eye,pos,new Vector3(0,1,0),new Vector3(0,0,-1),new Vector3(0,0,-1),{pos:stone.plan.position,piece:stone});
  check('aiming at floor extends to next grid cell', next.equals(stone.plan.cell.clone().add(new Vector3(0,0,-3))));
  const edgeWall = planBuild('wall',stone.plan.cell,new Vector3(0,1,0),new Vector3(0,0,-1));
  check('wall connects to floor on shared edge',bs5.place(edgeWall,pos,frame,eye,'metal')==='ok');
  const wall5=[...bs5.pieces.values()].find(p=>p.material==='metal')!;
  const top=buildAim('wall',eye,pos,new Vector3(0,1,0),new Vector3(0,0,-1),new Vector3(0,0,-1),{pos:wall5.plan.cell.clone().add(new Vector3(0,1,0)),piece:wall5});
  check('aiming high on wall selects next level',top.equals(wall5.plan.cell.clone().add(new Vector3(0,3,0))));
  bs5.damageCollider(stone.collider.handle,100); check('stone survives rifle damage',stone.hp===100);
  check('reclaim returns half to matching material',bs5.reclaim(stone.collider.handle)===stone && bs5.resources.stone===95 && bs5.resources.wood===200);
  check('reclaim rejects non-building',bs5.reclaim(999999)===null);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall good');
process.exit(failed ? 1 : 0);