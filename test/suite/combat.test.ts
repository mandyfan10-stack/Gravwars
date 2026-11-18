import { Vector3 } from 'three';
import { BlockSystem } from '../../src/shared/blocks';
import { Combat, DAMAGE_SCALE, MAX_HP, SPAWN_GUARD, Target } from '../../src/shared/combat';
import { TICK_DT } from '../../src/shared/constants';
import { ITEMS, Pickups } from '../../src/shared/economy';
import { BASE_HEAL_RATE, BED_HP, BED_REGEN, RESPAWN_DELAY } from '../../src/shared/match';
import { emptyInput } from '../../src/shared/movement';
import { NPC, NpcManager } from '../../src/shared/npcs';
import { buildPhysicsWorld } from '../../src/shared/physics';
import { Props } from '../../src/shared/props';
import { HOOK, JETPACK, PlayerSim } from '../../src/shared/sim';
import { TEAMS } from '../../src/shared/teams';
import { THROW, Throws } from '../../src/shared/throwables';
import {
  CROSSBOW_LEVELS, KICK, MELEE, WEAPONS, createWeaponState, energyLeft, giveWeapon, hasAmmo, kickReady, kicked,
  reloadAllOwnedWeapons, shotSpread, weaponTick,
} from '../../src/shared/weapons';
import type { SimHarness } from '../harness';

export function runCombatTests(h: SimHarness) {
  const { R, map, world, sim, G, RED, RX, perfBudgetMul, check, run, place } = h;
  const s = sim.state;

  // 11. combat: rifle hits a dummy, wind/gravity bend bullets, grenade bounces + rocket-jumps
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
    check(`rifle hits dummy at 10 m: ${toKill} rounds kill`, hits >= toKill - 1 && hits <= toKill && killed, `hits=${hits} killed=${killed}`);
    check('dead dummy respawns', (() => { for (let k = 0; k < 64 * 3.2; k++) combat.tick(TICK_DT); return dummy.alive && dummy.hp === MAX_HP; })());

    // ballistics over 100 m (through the empty middle of the cube): 2x speed, drop with the shooter's gravity, drag
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
    check('rifle: normal speed, heavier bullets drop (~0.5 s)', rf.drop > 0.15 && rf.drop < 0.6 && rf.speed > 0.88 && rf.speed < 0.97 && rf.t > 0.4 && rf.t < 0.6,
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
    const tick = (fire: boolean, extra: Partial<{ reload: boolean; select: 'fists' | 'pistol' | 'rifle' | 'crossbow' | 'grenade' | null }> = {}) =>
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
    for (let k = 0; k < 64 * 4.2; k++) tick(false);
    check('reload moves spare rounds into the magazine', ws.ammo.rifle === 30 && ws.reserve.rifle === 10, `mag=${ws.ammo.rifle} spare=${ws.reserve.rifle}`);
    for (let k = 0; k < 5; k++) { tick(true); for (let j = 0; j < 8; j++) tick(false); }
    tick(false, { reload: true });
    check('tactical reload is faster', ws.reloadT === WEAPONS.rifle.reload);
    for (let k = 0; k < 64 * 3.5; k++) tick(false);
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

  // GravWars weapons and tools: shotgun, rocket launcher, punches and kicks that hit everyone in front, crates that
  // fly, the grappling hook.
  {
    const aw = new R.World({ x: 0, y: 0, z: 0 });
    aw.createCollider(R.ColliderDesc.cuboid(60, 1, 60).setTranslation(0, -1, 0));
    aw.createCollider(R.ColliderDesc.cuboid(10, 15, 0.5).setTranslation(0, 15, -25)); // a tall wall 24.5 m ahead
    aw.step();
    const c = new Combat(R, aw, map);
    c.windMul = 0;
    const Y = new Vector3(0, 1, 0);
    const pushes = new Map<number, Vector3>();
    const dummy = (id: number, x: number, y: number, z: number): Target => ({ id, team: 'blue', center: new Vector3(x, y, z), up: Y, hp: MAX_HP,
      alive: true, respawnIn: -1, onImpulse: (v) => pushes.set(id, (pushes.get(id) ?? new Vector3()).add(v)) });
    const shooter = dummy(0, 0, 1, 0);
    shooter.team = 'red';
    c.targets.push(shooter);
    const settle = (ticks = 64) => { for (let k = 0; k < ticks; k++) c.tick(TICK_DT); };
    const only = (...ts: Target[]) => { c.targets.length = 0; c.targets.push(shooter, ...ts); pushes.clear(); c.events.length = 0; };

    // shotgun: 8 pellets; up close they all land, at 20 m most of them miss and the rest are weak
    const shotgunAt = (dist: number) => {
      const d = dummy(1, 0, 1, -dist);
      only(d);
      c.fire('shotgun', 0, new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(), Y.clone().negate());
      const pellets = c.volley.length;
      settle();
      return { pellets, hits: c.events.filter((e) => e.type === 'hit').length, dmg: MAX_HP - d.hp };
    };
    const sgNear = shotgunAt(4), sgFar = shotgunAt(20);
    check('shotgun: 8 pellets, nearly all hit at 4 m (damage 11)', sgNear.pellets === 8 && sgNear.hits >= 7 && sgNear.dmg > 22 && sgNear.dmg < 32,
      `hits=${sgNear.hits} dmg=${sgNear.dmg.toFixed(1)}`);
    check('shotgun: at 20 m few pellets land and they are weak', sgFar.hits <= 4 && sgFar.dmg < sgNear.dmg / 3, `hits=${sgFar.hits} dmg=${sgFar.dmg.toFixed(1)}`);

    // rocket: 2x speed (~72 m/s), +70% damage (136 raw); blows up on the wall
    const near = dummy(1, 1.5, 1, -23.4), far = dummy(2, 8.0, 1, -23.4);
    only(near, far);
    const rocket = c.fire('rocket', 0, new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(), Y.clone().negate());
    let boomT = 0;
    for (let k = 0; k < 64 * 2 && !boomT; k++) { c.tick(TICK_DT); if (c.events.some((e) => e.type === 'explode')) boomT = (k + 1) * TICK_DT; }
    check('rocket flies at ~36 m/s with ballistic drop and blows up on the wall', boomT > 0.58 && boomT < 0.78 && rocket.pos.y < 0.8 && rocket.pos.y > 0.02 && rocket.pos.z > -24.6,
      `t=${boomT.toFixed(2)} at ${rocket.pos.toArray().map((v) => v.toFixed(2)).join(',')}`);
    check('rocket splash: 1.5 m away hurts, 8 m away does not', near.hp < MAX_HP - 40 && far.hp === MAX_HP, `near=${near.hp.toFixed(0)} far=${far.hp}`);
    const victim = dummy(1, 0, 1, -8);
    only(victim);
    c.fire('rocket', 0, new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(), Y.clone().negate());
    settle();
    check('direct rocket hit: 90 damage and a big shove', victim.hp > 0 && MAX_HP - victim.hp >= 88 && MAX_HP - victim.hp <= 90 && (pushes.get(1)?.length() ?? 0) > 10,
      `dmg=${MAX_HP - victim.hp} push=${pushes.get(1)?.length().toFixed(1)}`);
    shooter.center.set(0, 1, 10);
    shooter.hp = MAX_HP;
    only();
    c.fire('rocket', 0, new Vector3(0, 1.6, 10), new Vector3(0, -1, -0.05).normalize(), new Vector3(), Y.clone().negate());
    settle(20);
    const rj = pushes.get(0) ?? new Vector3();
    check('rocket jump: a rocket at your feet throws you up for a fraction of the damage', rj.y > 8 && shooter.hp < MAX_HP && shooter.hp > MAX_HP - 60,
      `vy=${rj.y.toFixed(1)} hp=${shooter.hp.toFixed(0)}`);
    shooter.center.set(0, 1, 0);
    {
      // the launcher holds one rocket: it reloads by itself after the shot (no dry click needed)
      const ws = createWeaponState();
      giveWeapon(ws, 'rocket');
      ws.reserve.rocket = 2;
      weaponTick(ws, { fire: false, reload: false, select: 'rocket' }, TICK_DT);
      let fired = 0, t = 0;
      for (; t < 4 && fired < 2; t += TICK_DT) if (weaponTick(ws, { fire: ws.cooldown <= 0 && ws.reloadT <= 0 && ws.ammo.rocket > 0, reload: false, select: null }, TICK_DT)) fired++;
      check('rocket launcher reloads itself after each shot', fired === 2 && t > WEAPONS.rocket.reloadEmpty
        && t < WEAPONS.rocket.interval + WEAPONS.rocket.reloadEmpty + 0.5, `t=${t.toFixed(2)}`);
    }

    // Rocket deals 50% less damage to crystals
    {
      shooter.center.set(0, 1, -9);
      const blueC = { team: 'blue' as const, pos: new Vector3(0, 1, -10), up: Y, alive: true };
      c.crystals.push(blueC);
      let cryDmg = 0;
      c.onCrystal = (_c, dmg) => { cryDmg = dmg; };
      c.triggerExplosion(new Vector3(0, 1, -10), 0, 'red', WEAPONS.rocket.radius, WEAPONS.rocket.damage, WEAPONS.rocket.knockback, WEAPONS.rocket.blockDamage, 0.4, WEAPONS.rocket.raw, 'rocket', new Vector3(0, 1, -9));
      check('rocket deals 50% less damage to crystals', cryDmg === Math.round(WEAPONS.rocket.damage * 0.5 * 10) / 10, `dmg=${cryDmg}`);
      c.crystals.length = 0;
    }

    check('weapon balances: rifle 7 dmg, pistol 10 dmg, fish $7, reload 25% faster',
      WEAPONS.rifle.damage === 7 && WEAPONS.pistol.damage === 10 && ITEMS.fish.sell === 7
      && WEAPONS.rifle.reload === 2.36 && WEAPONS.pistol.reload === 1.69);

    // fists: everyone in front within reach takes the punch and is shoved back; nobody behind
    const eye = new Vector3(0, 1.6, 0);
    const left = dummy(1, -0.5, 1, -1.5), right = dummy(2, 0.6, 1, -1.4), behind = dummy(3, 0, 1, 1.5);
    only(left, right, behind);
    c.use('fists', 0, eye, new Vector3(0, 0, -1), new Vector3(), Y.clone().negate());
    const punched = MAX_HP - Math.round(WEAPONS.fists.damage * DAMAGE_SCALE * 10) / 10;
    check('a punch lands on both people in front, not on the one behind', left.hp === punched && right.hp === punched && behind.hp === MAX_HP,
      `${left.hp} ${right.hp} ${behind.hp}`);
    check('punched people fly back', [1, 2].every((id) => (pushes.get(id)?.z ?? 0) < -MELEE.push * 0.8) && !pushes.has(3));

    // kick: 10 HP flat, a long shove; 3 s cooldown after a hit, a short one after a miss
    const kicked1 = dummy(1, 0.3, 1, -1.6);
    only(kicked1);
    const kn = c.kick(0, eye, new Vector3(0, 0, -1), Y);
    check('kick: 10 HP, long shove on victim, and recoil pushback on kicker', kn === 1 && kicked1.hp === MAX_HP - KICK.damage
      && (pushes.get(1)?.length() ?? 0) > KICK.push * 0.95 && (pushes.get(0)?.z ?? 0) > 2,
      `hp=${kicked1.hp} push=${pushes.get(1)?.length().toFixed(1)} recoil=${pushes.get(0)?.z.toFixed(1)}`);
    const kws = createWeaponState();
    kicked(kws, true);
    const ready = (t: number) => { for (let k = 0; k < t * 64; k++) weaponTick(kws, { fire: false, reload: false, select: null }, TICK_DT); return kickReady(kws); };
    const after2 = ready(1.5), after3 = ready(0.6);
    kicked(kws, false);
    check('kick cooldown: 2 s after a hit, 0.1 s after a miss', !after2 && after3 && kws.kickCd === KICK.cdMiss && KICK.cdMiss === 0.1 && ready(KICK.cdMiss + 0.05));

    // Crossbow: levels 0..3 charge (0s->5 dmg, 1s->10 dmg, 2s->12 dmg / 1m wide, 3s->20 dmg / 2.5m wide), reload 0.5 + 1*lvl
    {
      const cws = createWeaponState();
      giveWeapon(cws, 'crossbow');
      weaponTick(cws, { fire: false, reload: false, select: 'crossbow' }, TICK_DT);
      for (let k = 0; k < 20; k++) weaponTick(cws, { fire: false, reload: false, select: null }, TICK_DT);
      // Level 0 instant tap
      weaponTick(cws, { fire: true, reload: false, select: null }, TICK_DT);
      const fired0 = weaponTick(cws, { fire: false, reload: false, select: null }, TICK_DT);
      check('crossbow level 0: instant shot, 0.375 s reload', fired0 === 'crossbow' && cws.lastChargeLevel === 0 && Math.abs(cws.reloadTotal - CROSSBOW_LEVELS[0].reload) < 1e-6);
      for (let k = 0; k < 64; k++) weaponTick(cws, { fire: false, reload: false, select: null }, TICK_DT);
      // Level 3 (2.1s hold with 1.5x charge rate): 60 damage, 2.5m width (hits target 1.1m off-axis), speed 2 m/s, 2.625s reload
      for (let k = 0; k < Math.ceil(2.1 / TICK_DT); k++) weaponTick(cws, { fire: true, reload: false, select: null }, TICK_DT);
      const fired3 = weaponTick(cws, { fire: false, reload: false, select: null }, TICK_DT);
      const offAxis = dummy(1, 1.1, 1, -8);
      only(offAxis);
      c.use('crossbow', 0, new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(), Y.clone().negate(), cws.lastChargeT);
      settle(400);
      check('crossbow level 3: 1.5x charge rate (2s), 2.5m wide slow bolt (5 m/s) hits off-axis for 60 dmg, 2.625s reload',
        fired3 === 'crossbow' && cws.lastChargeLevel === 3 && Math.abs(cws.reloadTotal - CROSSBOW_LEVELS[3].reload) < 1e-6 && MAX_HP - offAxis.hp === 60
        && CROSSBOW_LEVELS[2].speed === 24 && CROSSBOW_LEVELS[3].speed === 5,
        `lvl=${cws.lastChargeLevel} dmg=${MAX_HP - offAxis.hp} reload=${cws.reloadTotal} sp2=${CROSSBOW_LEVELS[2].speed} sp3=${CROSSBOW_LEVELS[3].speed}`);

      // Crossbow level 2+ piercing: pierces enemies, only disappears on a wall
      const dA = dummy(2, 0, 1, -4);
      const dB = dummy(3, 0, 1, -8);
      only(dA, dB);
      const pLvl2 = c.use('crossbow', 0, new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(), Y.clone().negate(), 2.2)!;
      settle(25);
      check('crossbow level 2 pierces enemies without disappearing',
        dA.hp === MAX_HP - 25 && dB.hp === MAX_HP - 25 && pLvl2.alive,
        `dA=${dA.hp} dB=${dB.hp} alive=${pLvl2.alive}`);
      settle(60);
      check('crossbow level 2 disappears upon hitting a wall', !pLvl2.alive);
      // Crossbow level 1: stops on the first enemy
      const dC = dummy(4, 0, 1, -4);
      const dD = dummy(5, 0, 1, -8);
      only(dC, dD);
      const pLvl1 = c.use('crossbow', 0, new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(), Y.clone().negate(), 1.2)!;
      settle(25);
      check('crossbow level 1 stops on the first enemy',
        dC.hp === MAX_HP - 10 && dD.hp === MAX_HP && !pLvl1.alive,
        `dC=${dC.hp} dD=${dD.hp} alive=${pLvl1.alive}`);
    }

    // crates on the real map: kicked ones fly and fall along their own face's gravity, bullets nudge them
    const mw = buildPhysicsWorld(R, map);
    const props = new Props(mw, map);
    const cm = new Combat(R, mw, map);
    cm.props = props;
    // a lone crate / barrel on the ground (not pinned under a stacked crate) with 8 m open on one side
    const open = (i: number, up: Vector3): Vector3 | null => {
      const cr = map.crates[i];
      if (cr.kind === 'crate' && cr.half[1] > 0.52) return null;
      const p = new Vector3(...cr.pos);
      // Reject crates pinned by another crate stacked on top, or clustered with adjacent side crates within kick path
      const crowded = map.crates.some((o, j) => {
        if (j === i) return false;
        if (cr.kind === 'crate') return p.distanceTo(new Vector3(...o.pos)) < 2.1;
        const d = new Vector3(...o.pos).sub(p);
        const alongUp = d.dot(up);
        d.addScaledVector(up, -alongUp);
        return alongUp > 0.25 && alongUp < 1.8 && d.lengthSq() < 1.0;
      });
      if (crowded) return null;
      for (const d of [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)]) {
        if (Math.abs(d.dot(up)) > 0.5) continue;
        const from = p.clone().addScaledVector(d, cr.half[0] + 0.05);
        const back = cr.kind === 'crate' ? 1.45 - cr.half[0] : 2;
        if (!mw.castRay(new R.Ray(from, d), 8, true)
          && !mw.castRay(new R.Ray(p.clone().addScaledVector(d, -cr.half[0] - 0.05), d.clone().negate()), Math.max(0.2, back), true)) return d;
      }
      return null;
    };
    const onGround = (face: (p: number[]) => boolean, up: Vector3) => map.crates.findIndex((cr, i) => cr.kind === 'crate' && face(cr.pos) && !!open(i, up));
    const kickCrate = (i: number, up: Vector3) => {
      const p0 = props.pos(i);
      const h = map.crates[i].half[1];
      const d = open(i, up)!;
      const kEye = p0.clone().addScaledVector(up, -h + 1.6).addScaledVector(d, -1.4);
      const n = cm.kick(0, kEye, d, up);
      for (let k = 0; k < 64 * 3; k++) props.tick(TICK_DT);
      return { n, p0, p1: props.pos(i) };
    };
    const redCrate = onGround((p) => Math.abs(p[1] - G) < 1.5, Y);
    const rk = kickCrate(redCrate, Y);
    check('a kicked crate flies a few metres and lands', rk.n >= 1 && rk.p1.distanceTo(rk.p0) > 0.8 && Math.abs(rk.p1.y - rk.p0.y) < 1.5,
      `moved ${rk.p1.distanceTo(rk.p0).toFixed(1)} m`);
    const topCrate = onGround((p) => Math.abs(p[1] + G) < 1.5, new Vector3(0, -1, 0));
    const tk = kickCrate(topCrate, new Vector3(0, -1, 0));
    check('a crate on the opposite face falls towards its own ground (up there)', tk.p1.distanceTo(tk.p0) > 0.8 && tk.p1.y > -G - 2,
      `y ${tk.p0.y.toFixed(1)} → ${tk.p1.y.toFixed(1)}`);
    const shotCrate = map.crates.findIndex((cr, i) => i !== redCrate && cr.kind === 'barrel' && Math.abs(cr.pos[1] - G) < 1.5
      && new Vector3(...cr.pos).distanceTo(rk.p0) > 6 && !!open(i, Y));
    const b0 = props.pos(shotCrate);
    const sd = open(shotCrate, Y)!;
    for (let k = 0; k < 3; k++) {
      const from = b0.clone().addScaledVector(sd, 4);
      cm.fire('rifle', 0, from, sd.clone().negate(), new Vector3(), Y.clone().negate());
      for (let j = 0; j < 4; j++) { cm.tick(TICK_DT); props.tick(TICK_DT); }
    }
    for (let k = 0; k < 64; k++) props.tick(TICK_DT);
    check('bullets nudge a barrel', props.pos(shotCrate).distanceTo(b0) > 0.03, `moved ${(props.pos(shotCrate).distanceTo(b0) * 100).toFixed(0)} cm`);
    for (let k = 0; k < 64 * 5 && props.active; k++) props.tick(TICK_DT);
    const settledBeforeIdle = !props.active;
    let idle = performance.now();
    for (let k = 0; k < 64 * 4; k++) props.tick(TICK_DT);
    idle = performance.now() - idle;
    check('resting crates cost nothing', settledBeforeIdle && !props.active && idle < 20 * perfBudgetMul, `${idle.toFixed(1)} ms for 4 s`);

    // grappling hook: bites the wall 20 m away and pulls you there; nothing within 30 m = it comes back empty
    const hs = new PlayerSim(R, aw, map, 'red');
    hs.surfaces = false;
    const hst = hs.state;
    hst.pos.set(0, 0.92, 0); hst.vel.set(0, 0, 0); hst.frame.identity(); hs.mover.place(hst);
    for (let k = 0; k < 20; k++) hs.tick(emptyInput(), TICK_DT);
    const heye = hst.pos.clone().add(new Vector3(0, 0.71, 0));
    const anchorAim = new Vector3(0, 9, -24.5).sub(heye).normalize();
    const thrown = hs.throwHook(heye, anchorAim);
    let minD = Infinity, events: string[] = [];
    for (let k = 0; k < 64 * 3; k++) {
      hs.tick(emptyInput(), TICK_DT);
      minD = Math.min(minD, hst.pos.distanceTo(new Vector3(0, 9, -24.5)));
      for (const e of hs.events.splice(0)) if (e.type === 'hook') events.push(e.what);
    }
    check('hook bites a wall ~26 m away and pulls you up to it', thrown && events[0] === 'attach' && events.includes('release') && minD < 1.6,
      `closest ${minD.toFixed(2)} m, ${events.join(',')}`);
    hst.pos.set(0, 0.92, 0); hst.vel.set(0, 0, 0); hs.mover.place(hst); hs.hook = null; hs.hookCd = 0;
    for (let k = 0; k < 64; k++) hs.tick(emptyInput(), TICK_DT);
    events = [];
    hs.throwHook(hst.pos.clone().add(new Vector3(0, 0.71, 0)), new Vector3(0, 0.3, 1).normalize());
    for (let k = 0; k < 64; k++) { hs.tick(emptyInput(), TICK_DT); for (const e of hs.events.splice(0)) if (e.type === 'hook') events.push(e.what); }
    check(`hook: range is 35 m, nothing within ${HOOK.range} m → it comes back, you stay`, HOOK.range === 35 && HOOK.magnet === 0.25
      && events.join() === 'miss' && hs.hook === null && Math.hypot(hst.pos.x, hst.pos.z) < 0.1,
      events.join());
    hs.mover.dispose();
  }

  // New mechanics verification: revolver ricochet, armor vest save, jetpack flight/overheat, active reload, doors & base hall heal
  {
    const nw = new R.World({ x: 0, y: 0, z: 0 });
    nw.createCollider(R.ColliderDesc.cuboid(60, 1, 60).setTranslation(0, -1, 0));
    nw.step();
    const nc = new Combat(R, nw, map);
    nc.windMul = 0;
    const Yn = new Vector3(0, 1, 0);
    const shooter: Target = { id: 0, team: 'red', center: new Vector3(0, 1, 0), up: Yn, hp: MAX_HP, alive: true, respawnIn: -1 };
    const t1: Target = { id: 1, team: 'blue', center: new Vector3(0, 1, -12), up: Yn, hp: MAX_HP, alive: true, respawnIn: -1 };
    let armorBroken = false;
    const t2: Target = { id: 2, team: 'blue', center: new Vector3(5, 1, -15), up: Yn, hp: 10, alive: true, respawnIn: -1, armor: true, onArmorBreak: () => { armorBroken = true; t2.armor = false; } };
    nc.targets.push(shooter, t1, t2);
    nc.use('revolver', 0, new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(), Yn.clone().negate());
    for (let k = 0; k < 20; k++) nc.tick(TICK_DT);
    check('revolver deals 25 primary dmg, chains 20 dmg ricochet to nearby foe, and armor vest saves target with 50 HP',
      t1.hp === 75 && armorBroken && t2.alive && t2.hp === 50 && !t2.armor,
      `t1=${t1.hp} t2=${t2.hp} broken=${armorBroken}`);

    // Active reload: green zone hit vs miss lockout
    const rws = createWeaponState();
    giveWeapon(rws, 'rifle');
    rws.ammo.rifle = 10;
    rws.reserve.rifle = 60;
    weaponTick(rws, { fire: false, reload: false, select: 'rifle' }, TICK_DT);
    weaponTick(rws, { fire: false, reload: true, select: null }, TICK_DT);
    const zoneMid = rws.reloadZoneStart + rws.reloadZoneWidth * 0.5;
    let tickedClick = false;
    for (let k = 0; k < 400 && rws.reloadT > 0; k++) {
      const prog = 1 - rws.reloadT / rws.reloadTotal;
      const hit = prog >= zoneMid - 0.02 && prog <= rws.reloadZoneStart + rws.reloadZoneWidth;
      weaponTick(rws, { fire: false, reload: hit, select: null }, TICK_DT);
      if (rws.activeReloadClick) { tickedClick = true; break; }
    }
    check('active reload succeeds inside green zone with audible click and finishes immediately',
      tickedClick && rws.reloadStatus === 'success' && rws.reloadT === 0 && rws.ammo.rifle === WEAPONS.rifle.mag + 1);

    // Miss active reload -> lockout 10s (release R key first)
    weaponTick(rws, { fire: false, reload: false, select: null }, TICK_DT);
    rws.ammo.rifle = 5;
    weaponTick(rws, { fire: false, reload: true, select: null }, TICK_DT);
    for (let k = 0; k < 10; k++) weaponTick(rws, { fire: false, reload: false, select: null }, TICK_DT);
    weaponTick(rws, { fire: false, reload: true, select: null }, TICK_DT);
    check('missed active reload triggers fail status and 10s lockout',
      rws.reloadStatus === 'fail' && rws.reloadLockout > 9.5);

    // Revolver hold-to-cock & reloadAllOwnedWeapons
    giveWeapon(rws, 'revolver');
    rws.reserve.revolver = 12;
    weaponTick(rws, { fire: false, reload: false, select: 'revolver' }, TICK_DT);
    let revFired = false;
    for (let t = 0; t < 0.7; t += TICK_DT) {
      if (weaponTick(rws, { fire: true, reload: false, select: null }, TICK_DT) === 'revolver') { revFired = true; break; }
    }
    reloadAllOwnedWeapons(rws);
    check('revolver fires after LMB cock hold and reloadAllOwnedWeapons refills mags',
      revFired && rws.ammo.revolver === WEAPONS.revolver.mag && rws.ammo.rifle === WEAPONS.rifle.mag);

    // Shotgun shell-by-shell reload interruptible by firing
    giveWeapon(rws, 'shotgun');
    rws.ammo.shotgun = 0;
    rws.reserve.shotgun = 8;
    weaponTick(rws, { fire: false, reload: false, select: 'shotgun' }, TICK_DT);
    weaponTick(rws, { fire: false, reload: true, select: null }, TICK_DT);
    let shellTicks = 0;
    for (let k = 0; k < 50 && rws.ammo.shotgun < 1; k++) {
      weaponTick(rws, { fire: false, reload: false, select: null }, TICK_DT);
      if (rws.shotgunShellInserted) shellTicks++;
    }
    const intShot = weaponTick(rws, { fire: true, reload: false, select: null }, TICK_DT);
    check('shotgun loads shell-by-shell and cancels reload when fired',
      shellTicks >= 1 && intShot === 'shotgun' && rws.reloadT === 0);

    // Jetpack flight, fuel consumption & 12s overheat explosion (fly in tight circles at center of cube so no void/wall interrupt)
    const jw = buildPhysicsWorld(R, map);
    const jSim = new PlayerSim(R, jw, map, 'red');
    jSim.respawn();
    jSim.state.pos.set(0, 0, 0);
    jSim.state.vel.set(0, 0, 0);
    jSim.state.onGround = false;
    jSim.state.jumpHold = 0;
    jSim.mover.place(jSim.state);
    jSim.hasJetpack = true;
    jSim.hasJetpackFuel = true;
    const jpIn = emptyInput();
    jpIn.jump = true;
    let fuelEv = 0;
    let exploded = false;
    for (let k = 0; k < Math.ceil((JETPACK.maxFlight + 0.5) * 64); k++) {
      jpIn.yaw += 0.08;
      jSim.tick(jpIn, TICK_DT);
      for (const ev of jSim.events.splice(0)) {
        if (ev.type === 'jetpackFuel') fuelEv++;
        if (ev.type === 'jetpackExplode') exploded = true;
      }
    }
    check('jetpack flies airborne, consumes ammo fuel and explodes after 12s without disappearing',
      fuelEv >= 40 && exploded && jSim.hasJetpack, `fuel=${fuelEv} exploded=${exploded}`);

    // Doors: global grid wall/floor door variant opened by teammate, blocked for enemy
    const nbs = new BlockSystem(R, nw);
    nbs.inventory.metal = 10;
    const dPlan = nbs.plan('wall', new Vector3(0, 1.5, 0), Yn, new Vector3(0, 0, -1), new Vector3(0, 1.5, 0), new Vector3(0, 0, -1), 'door')!;
    nbs.place(dPlan, 'metal', 'red');
    const doorBlk = nbs.findByPos(dPlan.center, 0.2)!;
    const enemyDenied = nbs.toggleDoor(new Vector3(0, 1.5, 0), new Vector3(0, 0, -1), 'blue');
    const allyOpened = nbs.toggleDoor(new Vector3(0, 1.5, 0), new Vector3(0, 0, -1), 'red');
    check('team door variant opens for teammates and denies enemies',
      doorBlk.variant === 'door' && !enemyDenied && !!allyOpened && doorBlk.open === true);

    // Respawn delay 8s & base hall rate 2 HP/s & BED_HP 250 & BED_REGEN {15, 2.5}
    check('updated rules constants: respawn 8s, base heal 2/s, crystal 250 HP and 15s/2.5 regen',
      RESPAWN_DELAY === 8 && BASE_HEAL_RATE === 2 && BED_HP === 250 && BED_REGEN.delay === 15 && BED_REGEN.rate === 2.5);

    // Remade base hall: square 4.5x4.5 doorway on global grid & open walkable under-ramp shop bay
    const hallW = buildPhysicsWorld(R, map);
    const hallBs = new BlockSystem(R, hallW);
    hallBs.inventory.wood = 10;
    const exitPlan = hallBs.plan('wall', new Vector3(-2.25, G + 1.0, 10.5), new Vector3(0, 1, 0), new Vector3(0, 0, 1),
      new Vector3(-2.25, G + 1.7, 10.5), new Vector3(0, 0, 1), 'door');
    check('base hall square exit aligns to single global-grid 4.5x4.5 wall/door slot at z=13.5',
      !!exitPlan && Math.abs(exitPlan.center.x - (-2.25)) < 0.01 && Math.abs(exitPlan.center.z - 13.5) < 0.01
      && Math.abs(exitPlan.center.y - (G + 2.25)) < 0.01 && hallBs.place(exitPlan, 'wood', 'red') === 'ok',
      exitPlan ? `c=${exitPlan.center.toArray().map((v) => v.toFixed(2))}` : 'null');
    const redShop = map.bases.find((b) => b.team === 'red')!;
    check('red shop moved under west ramp (-8.75, -4.6) and fountain basin is fishable',
      redShop.shop[0] < -7 && map.ponds.some((p) => Math.hypot(p.pos[0], p.pos[2]) > 0));
  }
}
