import { Quaternion, Vector3 } from 'three';
import { BlockSystem, BRIDGE_COST } from '../../src/shared/blocks';
import { Combat, MAX_HP, Target } from '../../src/shared/combat';
import { HU, TICK_DT, WORLD } from '../../src/shared/constants';
import { faceOfTeam, generateMap, HALL_H, HALL_HALF, SW, XZ } from '../../src/shared/map';
import { upOf } from '../../src/shared/math';
import { CROUCH_SPEED, emptyInput, moveBasis, MoveInput, SPRINT_SPEED, STAMINA } from '../../src/shared/movement';
import { buildPhysicsWorld } from '../../src/shared/physics';
import { PlayerSim } from '../../src/shared/sim';
import { TEAMS } from '../../src/shared/teams';
import type { SimHarness } from '../harness';

export function runMovementTests(h: SimHarness) {
  const { R, map, world, sim, G, RED, RX, check, run, planarSpeed, place } = h;
  const s = sim.state;

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

  // 7. the cube: six faces, a bridge lane over every edge (17 pieces at PIECE_CELL = 4.5 m)
  check('six faces, a 17-piece bridge lane over each of the 12 edges', map.faces.length === 6 && map.lanes.length === 12
    && map.lanes.every((l) => l.pieces.length === 17), `faces=${map.faces.length} lanes=${map.lanes.length}`);
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
      && map.bases.filter((b) => b.team === '').length >= 2 && map.crystalSpots.length >= 2);
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
    check('tap jump is short, a held jump reaches over 3 m', tap > 1 && tap < 1.6 && held > 3.1, `tap ${tap.toFixed(2)} held ${held.toFixed(2)}`);
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
    check('a soft landing does not hurt, a hard one does', c2.fall(t2, 12) === 0 && c2.fall(t2, 20) > 0 && c2.fall(t2, 50) === 25 && t2.hp < MAX_HP);
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
}
