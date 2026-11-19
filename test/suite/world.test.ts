import { Quaternion, Vector3 } from 'three';
import {
  BLOCK_MATERIALS, BlockSystem, PIECE_CELL, PIECE_COST, PIECE_HP_MUL, PIECE_LEVEL, PIECE_THICK, START_BLOCKS,
} from '../../src/shared/blocks';
import { Combat, CRYSTAL, MAX_HP, Target } from '../../src/shared/combat';
import { TICK_DT } from '../../src/shared/constants';
import { APPLE_HEAL, Economy, ITEMS, MAX_MEDKITS, PICKUPS, Pickups, SHOP, SHOP_ROWS } from '../../src/shared/economy';
import { FISHING, Fishing } from '../../src/shared/fishing';
import { Hotbar, holdables } from '../../src/shared/inventory';
import { activeTeams, defaultLobby, lobbyProblem } from '../../src/shared/lobby';
import { faceOfTeam, generateMap } from '../../src/shared/map';
import { BoxDef, Builder, Frame, MapData } from '../../src/shared/mapgen/core';
import { fillTile, OWN_GROUND, TileKind } from '../../src/shared/mapgen/tiles';
import { BED_HP, CRYSTAL_STUN_TIME, GENERATORS, Match, killRewardFor } from '../../src/shared/match';
import { Rng } from '../../src/shared/math';
import { emptyInput } from '../../src/shared/movement';
import { buildPhysicsWorld } from '../../src/shared/physics';
import { PlayerSim } from '../../src/shared/sim';
import { TEAMS } from '../../src/shared/teams';
import { WEAPONS, createWeaponState } from '../../src/shared/weapons';
import type { SimHarness } from '../harness';

export function runWorldTests(h: SimHarness) {
  const { R, map, G, RX, check } = h;

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
    check('enemy beds are fortified, own bed is not', TEAMS.every((t) => t.id === 'red' ? fortOf(t.id) === 0 : fortOf(t.id) >= 12),
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
    // enemy crystal: walled off, then shot to pieces, but only from within 5 m
    const blue = m.bed('blue');
    const st = map.statues.find((s) => s.team === 'blue')!;
    const bup = new Vector3(...st.up);
    const side = new Vector3(1, 0, 0).applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), bup));
    const roofEye = blue.pos.clone().addScaledVector(bup, -4 + 1.625).addScaledVector(side, 3);
    const toBlue = blue.pos.clone().sub(roofEye).normalize();
    check('fortification hides the enemy crystal', m.bedInSight(roofEye, toBlue) === null);
    for (const b of [...bs.blocks.values()]) if (b.team === 'blue') bs.damageCollider(b.collider.handle, b.hp);
    const sight = m.bedInSight(roofEye, toBlue);
    check('enemy crystal in sight once the wall is gone, within 5 m', sight?.bed === blue && sight.dist < CRYSTAL.range, `d=${sight?.dist.toFixed(2)}`);
    const cb = new Combat(R, w, map, [ps.mover.collider]);
    m.attach(cb);
    cb.targets.push({ id: 0, team: 'red', center: roofEye.clone(), up: bup, hp: MAX_HP, alive: true, respawnIn: -1 });
    const shootBed = (from: Vector3, n: number) => {
      for (let k = 0; k < n && blue.alive; k++) {
        cb.fire('rifle', 0, from, blue.pos.clone().sub(from).normalize(), new Vector3(), bup.clone().negate());
        for (let j = 0; j < 8; j++) cb.tick(TICK_DT);
      }
    };
    const farEye = blue.pos.clone().addScaledVector(bup, -4 + 1.625).addScaledVector(side, -7);
    shootBed(farEye, 6);
    const farHits = cb.events.filter((e) => e.type === 'crystal');
    check('shots from 7 m stop at the crystal and do nothing', blue.hp === BED_HP && farHits.length === 6 && farHits.every((e) => e.type === 'crystal' && e.far),
      `hp=${blue.hp} hits=${farHits.length}`);
    cb.events.length = 0;
    shootBed(roofEye, 5);
    const chipped = blue.hp;
    for (let k = 0; k < 64 * 22; k++) m.tick(TICK_DT, new Vector3(0, 500, 0));
    check('close shots chip the crystal; it heals back after 15 s calm delay', chipped < BED_HP - 8 && blue.hp === BED_HP, `${chipped.toFixed(1)} → ${blue.hp}`);
    let shots1 = 0;
    for (; shots1 < 220 && blue.stage === 1; shots1++) shootBed(roofEye, 1);
    check('stage 1 breaks and enters 10 s invulnerability', blue.stage === 2 && blue.invulnT > 9.5 && m.events.some((e) => e.type === 'bedStage1Broken' && e.team === 'blue'),
      `shots1=${shots1} invulnT=${blue.invulnT}`);
    // After 10 seconds, crystal explodes (100% lethal damage + stun to nearby enemies and revives dead allies) and enters stage 2
    const deadFighter: Target = { id: 99, team: 'blue', center: blue.pos.clone().addScaledVector(bup, 30), up: bup, hp: 0, alive: false, respawnIn: 5 };
    cb.targets.push(deadFighter);
    let revivedTeam: string | null = null;
    m.onReviveAll = (t) => { revivedTeam = t; };
    for (let k = 0; k < 64 * 10.2; k++) m.tick(TICK_DT, new Vector3(0, 500, 0));
    check('stage 1 invulnerability ends with blast event, enemy stun/lethal blast and ally revive after 10 s',
      blue.invulnT === 0
      && m.events.some((e) => e.type === 'bedStageBlast' && e.team === 'blue')
      && cb.targets[0].stun === CRYSTAL_STUN_TIME && !cb.targets[0].alive && cb.targets[0].hp === 0
      && deadFighter.alive && deadFighter.hp === MAX_HP && revivedTeam === 'blue',
      `stun=${cb.targets[0].stun} alive=${deadFighter.alive} hp=${deadFighter.hp} revived=${revivedTeam}`);
    let shots2 = 0;
    for (; shots2 < 220 && blue.alive; shots2++) shootBed(roofEye, 1);
    check('rifle fire from 3 m breaks crystal stage 2', !blue.alive && shots2 > 60 && shots2 < 160 && m.events.some((e) => e.type === 'bedBroken' && e.team === 'blue' && e.byPlayer),
      `shots2=${shots2}`);
    check('death with own bed = respawn', m.onDeath() === true && m.result === null);
    for (const t of TEAMS) if (t.id !== 'red') m.destroyBed(t.id);
    check('all enemy beds broken = win', m.result === 'win' && m.events.some((e) => e.type === 'win'));
    const m2 = new Match(R, w, map, new BlockSystem(R, w), 'red');
    m2.destroyBed('red');
    check('no bed = eliminated on death', m2.onDeath() === false && m2.result === 'lose');
  }

  // Economy: start broke, sell junk, everything on the shelf from the start, pockets spill on death.
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
    {
      const laid = SHOP_ROWS.flatMap((r) => r.ids).filter((id): id is string => !!id);
      check('shop window: every item once', laid.length === SHOP.length && SHOP.every((i) => laid.includes(i.id)), laid.join(' '));
    }
    check('prices: tools, guns, revolver, jetpack, armor, crossbow and block packs', item('rod').price === 5 && item('pistol').price === 20
      && item('revolver').price === 30 && item('shotgun').price === 35 && item('rifle').price === 40 && item('crossbow').price === 75
      && item('rocket').price === 5 && item('grenade').price === 10 && item('jetpack').price === 5 && item('armor').price === 5
      && item('wood').price === 4 && item('stone').price === 8 && item('metal').price === 2);
    eco.items.bottle = 4; eco.items.apple = 1; eco.items.fish = 1;
    const value = eco.sellValue;
    check('selling pays per item, cheaply', eco.sellAll() === value && value === 4 * ITEMS.bottle.sell + ITEMS.apple.sell + ITEMS.fish.sell
      && eco.wallet.cash === value && eco.items.bottle === 0, `got ${value}`);
    eco.wallet.cash = 1000;
    eco.buy(item('rifle'));
    check('a rifle can be the first purchase', ws.owned.rifle && ws.ammo.rifle === WEAPONS.rifle.mag && !ws.owned.pistol);
    for (const id of ['rod', 'wood', 'pistol', 'grenade']) eco.buy(item(id));
    const wood = item('wood') as Extract<typeof SHOP[number], { kind: 'blocks' }>;
    check('buying wood grants build tool and wood blocks', eco.has('builder') && bs.inventory.wood === wood.count);
    const woodPacks = Math.ceil(17 / wood.count);
    check('a bridge (17 plates, 1 wood each) costs under 20 money', woodPacks * item('wood').price < 20,
      `${woodPacks}×${item('wood').price}`);
    check('weapons from the shop come loaded', ws.owned.pistol && ws.ammo.pistol === WEAPONS.pistol.mag
      && ws.owned.rifle && ws.ammo.grenade === 2);
    check('bought tools and guns leave the shelf', !eco.offers().some((o) => ['rod', 'pistol', 'rifle'].includes(o.item.id)), shelf());
    eco.buy(item('grenade'));
    check('grenades are capped', eco.buy(item('grenade')) === 'full' && ws.ammo.grenade === WEAPONS.grenade.mag);
    for (let k = 0; k < MAX_MEDKITS; k++) eco.buy(item('medkit'));
    check('medkits go to the pockets, capped', eco.items.medkit === MAX_MEDKITS && eco.buy(item('medkit')) === 'full');
    check('a medkit is not sold back', eco.sell('medkit') === 0 && eco.items.medkit === MAX_MEDKITS);
    eco.items.apple = 1;
    check('eating takes an apple (+20 HP)', eco.eat() && eco.items.apple === 0 && !eco.eat() && APPLE_HEAL === 20);
    eco.items.apple = 3; eco.items.bottle = 2; eco.wallet.cash = 11;
    const piles = eco.spill();
    const pile = (k: string) => piles.find((p) => p.kind === k)?.amount ?? 0;
    check('death spills the items and half of the cash', pile('apple') === 3 && pile('bottle') === 2 && pile('medkit') === MAX_MEDKITS
      && pile('cash') === 5 && eco.wallet.cash === 6 && eco.items.apple === 0 && eco.items.medkit === 0, JSON.stringify(piles));
    check('guns and tools stay after death', ws.owned.rifle && eco.has('builder'));

    // hotbar: 9 hotbar slots + 9 backpack slots, new things fill free slots in order
    const bar = new Hotbar();
    bar.sync(holdables(eco));
    check('hotbar: guns, grenades, tools in order (9 slots + 9 backpack)', bar.bar.slice(0, 4).join() === 'pistol,rifle,grenade,rod' && bar.pack.length === 9, bar.bar.join());
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

    // Mid-air drops fall under gravity and settle on the ground (`grounded: true`)
    const airDrop = p.drop('wood', new Vector3(RX, G + 4, 0), new Vector3(0, 1, 0), 5);
    check('mid-air drop starts ungrounded', !!airDrop && !airDrop.grounded);
    for (let k = 0; k < 64 * 2; k++) p.tick(TICK_DT);
    check('mid-air drop lands on the street and grounds', !!airDrop && !!airDrop.grounded && airDrop.vy === 0 && Math.abs(airDrop.pos.y - G) < 0.25,
      airDrop ? `grounded=${airDrop.grounded} y=${(airDrop.pos.y - G).toFixed(2)}` : 'none');

    // Removing a block wakes nearby resting pickups so they fall down to the floor below
    const bs = new BlockSystem(R, w);
    bs.onRemove = (b) => p.wakeNear(b.center, Math.max(b.half.x, b.half.y, b.half.z) + 1.5);
    const plat = bs.insertPiece('floor', new Vector3(RX + 4, G + 4, 0), new Vector3(2.25, 0.125, 2.25), new Quaternion(), 'wood', 'red');
    const onBlock = p.drop('stone', new Vector3(RX + 4, G + 4.2, 0), new Vector3(0, 1, 0), 3);
    check('drop on placed floor starts grounded above street', !!onBlock && !!onBlock.grounded && onBlock.pos.y > G + 3.5);
    bs.reclaim(plat.collider.handle, 'red');
    check('removing floor wakes nearby pickup', !!onBlock && !onBlock.grounded);
    for (let k = 0; k < 64 * 2; k++) p.tick(TICK_DT);
    check('woken pickup falls onto street below', !!onBlock && !!onBlock.grounded && Math.abs(onBlock.pos.y - G) < 0.25,
      onBlock ? `grounded=${onBlock.grounded} y=${(onBlock.pos.y - G).toFixed(2)}` : 'none');
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

  // 1×1 fortification block building & explosion crystal shielding
  {
    const w = buildPhysicsWorld(R, map);
    const ps = new PlayerSim(R, w, map, 'red');
    const bs = new BlockSystem(R, w, ps.mover.collider);
    bs.inventory.metal = 10;
    const m = new Match(R, w, map, bs, 'red', ps.mover.collider);
    const redBed = m.bed('red');
    const rup = redBed.up.clone();
    const qf = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), rup);
    const side = new Vector3(1, 0, 0).applyQuaternion(qf);
    const redFloor = redBed.pos.clone().addScaledVector(rup, -2.8);
    const eye1 = redFloor.clone().addScaledVector(rup, 1.625).addScaledVector(side, 4.5);
    const floorAim = redFloor.clone().addScaledVector(side, 2);
    const dir1 = floorAim.clone().sub(eye1).normalize();
    const b1 = bs.plan('block', eye1, rup, dir1, eye1, dir1);
    const exp1 = floorAim.clone().addScaledVector(rup, 0.5);
    check('1x1 block plans flush on crystal hall fort grid next to pedestal',
      !!b1 && b1.kind === 'block' && b1.center.distanceTo(exp1) < 0.05 && bs.place(b1, 'metal', 'red') === 'ok',
      b1 ? `d=${b1.center.distanceTo(exp1).toFixed(3)}` : 'null');
    const placed1 = b1 && bs.findByPos(b1.center, 0.1);
    check('1x1 block has exact material HP and spends 1 unit',
      !!placed1 && placed1.maxHp === BLOCK_MATERIALS.metal.hp && bs.inventory.metal === 9);

    const eye2 = redFloor.clone().addScaledVector(rup, 2.5).addScaledVector(side, 4.5);
    const topAim = b1!.center.clone().addScaledVector(rup, 0.5);
    const dir2 = topAim.clone().sub(eye2).normalize();
    const b2 = bs.plan('block', eye2, rup, dir2, eye2, dir2);
    const exp2 = b1!.center.clone().addScaledVector(rup, 1);
    check('1x1 block stacks cleanly on top of existing block',
      !!b2 && b2.center.distanceTo(exp2) < 0.05 && bs.place(b2, 'metal', 'red') === 'ok');
    const h2 = bs.findByPos(b2!.center, 0.1)!.collider.handle;
    check('1x1 block reclaim refunds 1 material',
      !!bs.reclaim(h2, 'red') && bs.inventory.metal === 9);

    const corePlan = {
      kind: 'block' as const, center: redBed.pos.clone(), half: new Vector3(0.5, 0.5, 0.5),
      quat: new Quaternion(), key: 'core|test', level: 0,
    };
    check('1x1 block cannot be placed inside the crystal core',
      bs.validate(corePlan, 'metal', true) === 'blocked');

    // Unbroken fort wall blocks explosion damage to the crystal; broken wall lets it through
    const ew = new R.World({ x: 0, y: 0, z: 0 });
    ew.createCollider(R.ColliderDesc.cuboid(20, 1, 20).setTranslation(0, -1, 0));
    ew.step();
    const eb = new BlockSystem(R, ew);
    const ec = new Combat(R, ew, map);
    ec.onWorldDamage = (h2d, d) => eb.damageCollider(h2d, d);
    ec.onExplosion = (p, r, d) => eb.explosion(p, r, d);
    const eCrystal = { team: 'blue' as const, pos: new Vector3(0, 1.5, 0), up: new Vector3(0, 1, 0), alive: true };
    ec.crystals = [eCrystal];
    let eHits = 0;
    ec.onCrystal = () => { eHits++; };
    const shield = eb.add(new Vector3(0, 1.5, 2), 'metal', 'blue');
    ec.triggerExplosion(new Vector3(0, 1.5, 3), 0, 'red', 5.5, 65, 10, 120, 0.4, false, 'grenade', new Vector3(0, 1.5, 3));
    const blockedHits = eHits;
    const shieldHpAfterFirst = shield.hp;
    eb.damageCollider(shield.collider.handle, shield.hp);
    ec.triggerExplosion(new Vector3(0, 1.5, 3), 0, 'red', 5.5, 65, 10, 120, 0.4, false, 'grenade', new Vector3(0, 1.5, 3));
    check('intact fort block shields crystal from outer explosion splash; broken wall exposes it',
      blockedHits === 0 && eHits === 1 && shieldHpAfterFirst > 0,
      `blockedHits=${blockedHits} openHits=${eHits} shieldHp=${shieldHpAfterFirst}`);
  }

  // New gameplay & map verification checks
  {
    check('revolver and rocket use 0.18 gravityScale',
      WEAPONS.revolver.gravityScale === 0.18 && WEAPONS.rocket.gravityScale === 0.18,
      `rev=${WEAPONS.revolver.gravityScale} rkt=${WEAPONS.rocket.gravityScale}`);

    const cw = new R.World({ x: 0, y: 0, z: 0 });
    cw.createCollider(R.ColliderDesc.cuboid(20, 1, 20).setTranslation(0, -1, 0));
    cw.step();
    const cbs = new Combat(R, cw, map);
    cbs.targets.push({ id: 42, team: 'purple', center: new Vector3(0, 1, 0), up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1 });
    const bolt = cbs.fire('crossbow', 42, new Vector3(0, 1.4, 0), new Vector3(0, 0, -1), new Vector3(), new Vector3(0, -1, 0), 1);
    check('crossbow bolt carries shooter team id', bolt.team === 'purple', `team=${bolt.team}`);

    const sb = defaultLobby();
    sb.mode = 'sandbox';
    for (const tid of ['blue', 'green', 'yellow', 'purple'] as const) sb.seats[tid] = [null, null, null, null, null];
    check('sandbox mode allows solo launch with 1 active team', lobbyProblem(sb) === null && activeTeams(sb).length === 1);

    const dm = generateMap(77, 'red', ['red', 'blue'], 'duel');
    const dmFaces = dm.faces.map((f) => f.id).sort().join(',');
    check('duel mode creates 4 islands (ny, py opposing bases + nx, px neutral) and 4 bridge lanes',
      dm.faces.length === 4 && dmFaces === 'nx,ny,px,py' && dm.statues.length === 2 && dm.lanes.length === 4,
      `faces=${dmFaces} lanes=${dm.lanes.length}`);

    const hasHoles = (map.roadHoles?.length ?? 0) > 0 && (dm.roadHoles?.length ?? 0) > 0;
    const connected = Object.values(map.nav).every((g) => {
      if (!g.nodes.length) return false;
      const adj: number[][] = Array.from({ length: g.nodes.length }, () => []);
      for (const [a, b] of g.edges) { adj[a]?.push(b); adj[b]?.push(a); }
      const seen = new Set<number>([0]);
      const q = [0];
      while (q.length) {
        const u = q.pop()!;
        for (const v of adj[u] ?? []) if (!seen.has(v)) { seen.add(v); q.push(v); }
      }
      return seen.size === g.nodes.length;
    });
    check('road holes are generated while keeping face road nav graphs fully connected',
      hasHoles && connected, `holes=${map.roadHoles?.length ?? 0} duelHoles=${dm.roadHoles?.length ?? 0}`);

    const mb = new Builder(1, { half: 72, face: 144 }, 28, 128);
    const mf = new Frame(new Vector3(0, 0, 0), new Quaternion());
    fillTile(mb, mf, new Rng(1), { i: 0, j: 0, kind: 'museum' }, 0, 0, null);
    const mw = buildPhysicsWorld(R, mb.data);
    const cast = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxToi = 30) =>
      mw.castRay(new R.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }), maxToi, true) !== null;
    const openOculusCenter = !cast(0, 1.5, 0, 0, 1, 0, 20);
    const solidRoofRim = cast(0, 1.5, 6.5, 0, 1, 0, 20);
    const openDoorNegZ = !cast(0, 1.5, 0, 0, 0, -1, 18);
    const openDoorPosZ = !cast(0, 1.5, 0, 0, 0, 1, 18);
    const solidSideWall = cast(0, 2.0, 0, 1, 0, 0, 18) && cast(0, 2.0, 0, -1, 0, 0, 18);
    check('museum tile has 2 opposite entrances (-Z/+Z), solid side walls, and open circular ceiling hole',
      openOculusCenter && solidRoofRim && openDoorNegZ && openDoorPosZ && solidSideWall,
      `oculusOpen=${openOculusCenter} roofRim=${solidRoofRim} doors=${openDoorNegZ}/${openDoorPosZ} walls=${solidSideWall}`);

    const skLobby = defaultLobby();
    skLobby.mode = 'skirmish';
    skLobby.seats.green = [null, null, null, null, null];
    skLobby.seats.yellow = [null, null, null, null, null];
    const skValid = lobbyProblem(skLobby) === null;
    const sm = generateMap(2026, 'red', ['red', 'blue'], 'skirmish');
    const smFaces = sm.faces.map((f) => f.id).sort().join(',');
    const gapMeters = (sm.cube.halfY ?? 0) * 2;
    let minMidClearance = Infinity;
    for (const sSeed of [101, 202, 303, 777, 1337, 2026]) {
      const m = generateMap(sSeed, 'red', ['red', 'blue'], 'skirmish');
      let maxNyY = -Infinity;
      let minPyY = Infinity;
      for (const bx of m.boxes) {
        const topY = bx.pos[1] + bx.half[1];
        const botY = bx.pos[1] - bx.half[1];
        if (bx.pos[1] < 0) maxNyY = Math.max(maxNyY, topY);
        else minPyY = Math.min(minPyY, botY);
      }
      minMidClearance = Math.min(minMidClearance, minPyY - maxNyY);
    }
    const swWorld = buildPhysicsWorld(R, sm);
    const swSim = new PlayerSim(R, swWorld, sm, 'red');
    const swBlocks = new BlockSystem(R, swWorld, swSim.mover.collider);
    const swMatch = new Match(R, swWorld, sm, swBlocks, 'red', swSim.mover.collider);
    const swCombat = new Combat(R, swWorld, sm, [swSim.mover.collider]);
    swMatch.attach(swCombat);
    const swEco = new Economy(swMatch.wallet, swBlocks, createWeaponState());
    swEco.freeWeapons = sm.mode === 'skirmish';
    const rifleOffer = swEco.offers().find((o) => o.item.id === 'rifle')!;
    const woodOffer = swEco.offers().find((o) => o.item.id === 'wood')!;
    const buyRifleFree = swEco.buy(rifleOffer.item);
    const startWood = swBlocks.inventory.wood;
    for (let k = 0; k < 64 * 2; k++) swMatch.tick(TICK_DT, swSim.state.pos, true);
    const outsideOk = !swSim.outside(new Vector3(-36, -22, 0)) && swSim.outside(new Vector3(-130, -22, 0)) && swSim.outside(new Vector3(0, 60, 0));
    check('skirmish mode: 2 mirrored islands 10 cells (45m) apart, buildings never touch, free weapons, +1 wood/s in base, kill reward',
      skValid && sm.faces.length === 2 && smFaces === 'ny,py' && gapMeters === 45 && minMidClearance >= 4.0
      && rifleOffer.item.price === 0 && buyRifleFree === 'ok' && woodOffer.item.price > 0
      && swBlocks.inventory.wood === startWood + 2 && killRewardFor('skirmish') === 25 && outsideOk,
      `gap=${gapMeters}m clearance=${minMidClearance.toFixed(1)}m wood=${startWood}->${swBlocks.inventory.wood}`);

    // Geometric Z-fighting & buried-decal regression check across all 19 tile kinds and all 3 game modes
    type P2 = [number, number];
    const clipPoly = (poly: P2[], xMin: number, xMax: number, yMin: number, yMax: number): P2[] => {
      const clip = (pts: P2[], inside: (p: P2) => boolean, isect: (a: P2, b: P2) => P2): P2[] => {
        const out: P2[] = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const ia = inside(a), ib = inside(b);
          if (ia && ib) out.push(b);
          else if (ia && !ib) out.push(isect(a, b));
          else if (!ia && ib) { out.push(isect(a, b)); out.push(b); }
        }
        return out;
      };
      let p = poly;
      p = clip(p, (q) => q[0] >= xMin, (a, b) => [xMin, a[1] + ((b[1] - a[1]) * (xMin - a[0])) / (b[0] - a[0])]);
      if (!p.length) return p;
      p = clip(p, (q) => q[0] <= xMax, (a, b) => [xMax, a[1] + ((b[1] - a[1]) * (xMax - a[0])) / (b[0] - a[0])]);
      if (!p.length) return p;
      p = clip(p, (q) => q[1] >= yMin, (a, b) => [a[0] + ((b[0] - a[0]) * (yMin - a[1])) / (b[1] - a[1]), yMin]);
      if (!p.length) return p;
      return clip(p, (q) => q[1] <= yMax, (a, b) => [a[0] + ((b[0] - a[0]) * (yMax - a[1])) / (b[1] - a[1]), yMax]);
    };
    const scanCoplanar = (boxes: readonly BoxDef[], decals: MapData['decals']) => {
      const vis = boxes.filter((b) => !b.hidden);
      const obbs = vis.map((b, id) => {
        const q = new Quaternion(...b.quat);
        const rad = Math.hypot(b.half[0], b.half[1], b.half[2]) + 0.05;
        return {
          id, pos: new Vector3(...b.pos), rad,
          axes: [
            new Vector3(1, 0, 0).applyQuaternion(q),
            new Vector3(0, 1, 0).applyQuaternion(q),
            new Vector3(0, 0, 1).applyQuaternion(q),
          ] as [Vector3, Vector3, Vector3],
          half: b.half, opaque: b.mat !== 'window' && b.mat !== 'water',
        };
      });
      let buriedDecals = 0;
      for (const dec of decals) {
        const c = new Vector3(...dec.pos);
        for (const o of obbs) {
          if (!o.opaque) continue;
          const dx = c.x - o.pos.x, dy = c.y - o.pos.y, dz = c.z - o.pos.z;
          if (Math.abs(dx) > o.rad || Math.abs(dy) > o.rad || Math.abs(dz) > o.rad) continue;
          if (Math.abs(dx * o.axes[0].x + dy * o.axes[0].y + dz * o.axes[0].z) < o.half[0] + 0.001
            && Math.abs(dx * o.axes[1].x + dy * o.axes[1].y + dz * o.axes[1].z) < o.half[1] + 0.001
            && Math.abs(dx * o.axes[2].x + dy * o.axes[2].y + dz * o.axes[2].z) < o.half[2] + 0.001) {
            buriedDecals++;
          }
        }
      }
      interface FacePoly { id: number; mat: string; n: Vector3; u: Vector3; v: Vector3; c: Vector3; hu: number; hv: number; d: number; corners: Vector3[]; offset: boolean }
      const buckets = new Map<string, FacePoly[]>();
      const specs: [number, number, number, number][] = [[0, 1, 1, 2], [0, -1, 1, 2], [1, 1, 0, 2], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 0, 1]];
      vis.forEach((b, id) => {
        const o = obbs[id];
        for (const [ai, sg, ui, vi] of specs) {
          const n = o.axes[ai].clone().multiplyScalar(sg);
          const u = o.axes[ui], v = o.axes[vi];
          const c = o.pos.clone().addScaledVector(n, b.half[ai]);
          const hu = b.half[ui], hv = b.half[vi];
          const key = `${Math.round(n.x * 100)},${Math.round(n.y * 100)},${Math.round(n.z * 100)}`;
          let list = buckets.get(key);
          if (!list) { list = []; buckets.set(key, list); }
          list.push({
            id, mat: b.mat, n, u, v, c, hu, hv, d: c.dot(n),
            corners: [
              c.clone().addScaledVector(u, -hu).addScaledVector(v, -hv),
              c.clone().addScaledVector(u, hu).addScaledVector(v, -hv),
              c.clone().addScaledVector(u, hu).addScaledVector(v, hv),
              c.clone().addScaledVector(u, -hu).addScaledVector(v, hv),
            ],
            offset: b.mat === 'paint' || b.mat === 'glow',
          });
        }
      });
      const isBuried = (pt: Vector3, idA: number, idB: number) => {
        for (const o of obbs) {
          if (!o.opaque || o.id === idA || o.id === idB) continue;
          const dx = pt.x - o.pos.x, dy = pt.y - o.pos.y, dz = pt.z - o.pos.z;
          if (Math.abs(dx) > o.rad || Math.abs(dy) > o.rad || Math.abs(dz) > o.rad) continue;
          if (Math.abs(dx * o.axes[0].x + dy * o.axes[0].y + dz * o.axes[0].z) >= o.half[0] - 0.002) continue;
          if (Math.abs(dx * o.axes[1].x + dy * o.axes[1].y + dz * o.axes[1].z) >= o.half[1] - 0.002) continue;
          if (Math.abs(dx * o.axes[2].x + dy * o.axes[2].y + dz * o.axes[2].z) >= o.half[2] - 0.002) continue;
          return true;
        }
        return false;
      };
      let zFight = 0;
      const tmp = new Vector3();
      for (const list of buckets.values()) {
        list.sort((a, b) => a.d - b.d);
        for (let i = 0; i < list.length; i++) {
          const a = list[i];
          for (let j = i + 1; j < list.length; j++) {
            const b = list[j];
            const dist = b.d - a.d;
            if (dist > 0.015) break;
            if (a.id === b.id || a.n.dot(b.n) < 0.999) continue;
            const proj: P2[] = b.corners.map((p) => { const d = p.clone().sub(a.c); return [d.dot(a.u), d.dot(a.v)]; });
            const pts = clipPoly(proj, -a.hu, a.hu, -a.hv, a.hv);
            if (pts.length < 3) continue;
            let area = 0;
            for (let k = 0; k < pts.length; k++) {
              const [x0, y0] = pts[k], [x1, y1] = pts[(k + 1) % pts.length];
              area += x0 * y1 - x1 * y0;
            }
            if (Math.abs(area) * 0.5 < 0.005) continue;
            let cx = 0, cy = 0;
            for (const [ux, vy] of pts) { cx += ux; cy += vy; }
            cx /= pts.length; cy /= pts.length;
            let exposed = false;
            const samples: P2[] = [[cx, cy], ...pts.map(([ux, vy]): P2 => [cx * 0.35 + ux * 0.65, cy * 0.35 + vy * 0.65])];
            for (const [su, sv] of samples) {
              tmp.copy(a.c).addScaledVector(a.u, su).addScaledVector(a.v, sv).addScaledVector(a.n, dist + 0.025);
              if (!isBuried(tmp, a.id, b.id)) { exposed = true; break; }
            }
            if (!exposed) continue;
            if (a.offset !== b.offset && dist >= 0.004) continue;
            zFight++;
          }
        }
      }
      return { zFight, buriedDecals };
    };
    const scanMap = (md: MapData) => {
      const byFace = new Map<string, { boxes: BoxDef[]; decals: MapData['decals'] }>();
      for (const f of md.faces) byFace.set(f.id, { boxes: [], decals: [] });
      const nearest = (p: readonly number[]) => {
        let best = md.faces[0].id, bd = Infinity;
        for (const f of md.faces) {
          const d = (f.origin[0] - p[0]) ** 2 + (f.origin[1] - p[1]) ** 2 + (f.origin[2] - p[2]) ** 2;
          if (d < bd) { bd = d; best = f.id; }
        }
        return best;
      };
      for (const b of md.boxes) byFace.get(nearest(b.pos))!.boxes.push(b);
      for (const d of md.decals) byFace.get(nearest(d.pos))!.decals.push(d);
      let zFight = 0, buriedDecals = 0;
      for (const g of byFace.values()) {
        const r = scanCoplanar(g.boxes, g.decals);
        zFight += r.zFight;
        buriedDecals += r.buriedDecals;
      }
      return { zFight, buriedDecals };
    };
    const allKinds: TileKind[] = [
      'tower', 'office', 'houses', 'parking', 'construction', 'park', 'pond', 'greenpond',
      'plaza', 'abyss', 'pipes', 'pipeline', 'bar', 'store', 'court', 'museum', 'market', 'square', 'hall',
    ];
    let tileHits = 0, tileBuried = 0;
    for (const kind of allKinds) {
      const tb = new Builder(1337, { half: 126, face: 90 }, 20, 360);
      const tf = new Frame(new Vector3(0, 0, 0), new Quaternion());
      if (!OWN_GROUND.has(kind)) {
        tb.span(tf, -18, -1.5, -18, 18, 0, 18, 0x77736d, 'asphalt');
        tb.block(tf, 0, 0, 0, 12, 0.075, 12, 0xcfc4ac, 'paving');
      }
      fillTile(tb, tf, new Rng(1337), { i: 1, j: 1, kind }, 0, 0, TEAMS[0], 44);
      const r = scanCoplanar(tb.data.boxes, tb.data.decals);
      tileHits += r.zFight;
      tileBuried += r.buriedDecals;
    }
    const stdScan = scanMap(map);
    const duelScan = scanMap(dm);
    const skirScan = scanMap(sm);
    const totalZF = tileHits + stdScan.zFight + duelScan.zFight + skirScan.zFight;
    const totalBD = tileBuried + stdScan.buriedDecals + duelScan.buriedDecals + skirScan.buriedDecals;
    check('map geometry has zero exposed coplanar Z-fighting and zero buried decals across all 19 tiles and all modes',
      totalZF === 0 && totalBD === 0,
      `tiles=${tileHits}/${tileBuried} std=${stdScan.zFight}/${stdScan.buriedDecals} duel=${duelScan.zFight}/${duelScan.buriedDecals} skir=${skirScan.zFight}/${skirScan.buriedDecals}`);
  }
}
