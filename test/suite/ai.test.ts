import { Quaternion, Vector3 } from 'three';
import { BlockSystem } from '../../src/shared/blocks';
import { wishlist } from '../../src/shared/botShop';
import { applyDifficulty, BOT, BotManager } from '../../src/shared/bots';
import { Combat, MAX_HP, Target } from '../../src/shared/combat';
import { DEFAULT_MOVEMENT, TICK_DT } from '../../src/shared/constants';
import { Pickups } from '../../src/shared/economy';
import { activeTeams, botRoster, defaultLobby, lobbyProblem, parseLobby, playerTeam, seatPlayer } from '../../src/shared/lobby';
import { faceOfTeam, generateMap } from '../../src/shared/map';
import { BED_HP, Match } from '../../src/shared/match';
import { upOf } from '../../src/shared/math';
import { moveBasis } from '../../src/shared/movement';
import { lobDirection, NPC, Npc, NpcManager } from '../../src/shared/npcs';
import { buildPhysicsWorld } from '../../src/shared/physics';
import { PlayerSim } from '../../src/shared/sim';
import { TEAMS } from '../../src/shared/teams';
import { giveWeapon, WEAPONS } from '../../src/shared/weapons';
import type { SimHarness } from '../harness';

export function runAiTests(h: SimHarness) {
  const { R, map, G, RED, RX, perfBudgetMul, check } = h;

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
    check('NPCs stay on the streets', npcs.npcs.every((n) => n.state === 'dead' || (n.sim.state.pos.toArray().every(Number.isFinite)
      && (() => {
        const isl = map.faces.find((f) => f.id === n.island)!;
        const u = upOf(n.sim.state.frame);
        return Math.abs(n.sim.state.pos.dot(u) - new Vector3(...isl.origin).dot(u) - 0.94) < 3;
      })())));
    check('NPCs are cheap to simulate', ms < 50 * perfBudgetMul, `${ms.toFixed(1)} ms per game second, ${npcs.npcs.length} NPCs`);
  }

  // Gang fights: telegraphed bursts at a locked spot (standing still you are hit, a step aside dodges), grenades.
  {
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
    check('a target out of reach gets no throw', lobDirection(from, new Vector3(120, 0, 0), up, v, g, false) === null);

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

  // Bots: a hit on their crystal sends the defender home at once; a fist fight with a bum is not an alarm.
  {
    const w = buildPhysicsWorld(R, map);
    const ps = new PlayerSim(R, w, map, 'red');
    const combat = new Combat(R, w, map, [ps.mover.collider]);
    const bs = new BlockSystem(R, w, ps.mover.collider);
    const m = new Match(R, w, map, bs, 'red', ps.mover.collider);
    m.attach(combat);
    ps.state.pos.set(0, -3000, 0);
    ps.mover.place(ps.state);
    const bots = new BotManager(R, w, map, combat, m, bs, 'red');
    const stepBots = (sec: number) => { for (let i = 0; i < 64 * sec; i++) { m.time += TICK_DT; bots.tick(TICK_DT); } };
    stepBots(5);
    const green = bots.bots.filter((b) => b.team === 'green');
    const def = green.find((b) => b.role === 'defend')!;
    const task = () => def.task.kind as string;
    const calm = task();
    m.damageBed('green', 10);
    stepBots(1.5);
    check('bots: the defender drops its task and defends the crystal when it is hit', calm !== 'defend' && task() === 'defend',
      `${calm} -> ${task()}`);
    m.beds.find((b) => b.team === 'green')!.hp = BED_HP;
    stepBots(10);
    check('bots: the alarm passes, the defender goes back to work', task() !== 'defend', task());
    // Bot shop wishlist includes crossbow and bots charge & release it when armed with one
    const need = { raider: false, wood: 0, fort: 0, shotgun: false, fisher: false, impulse: false };
    check('botShop: wishlist includes crossbow', wishlist(def.eco, need).some((wItem) => wItem.item.id === 'crossbow'));
    def.weapons.owned.pistol = false;
    def.weapons.owned.shotgun = false;
    def.weapons.owned.rifle = false;
    def.weapons.owned.rocket = false;
    def.weapons.ammo.grenade = 0;
    giveWeapon(def.weapons, 'crossbow', 4);
    def.weapons.reloadT = 0;
    def.weapons.cooldown = 0;
    def.pick = null;
    def.pauseT = 0;
    def.hesitateT = 0;
    def.scanT = 0;
    def.farT = 0;
    def.target.guard = null;
    def.target.stun = 0;
    const defUp = def.target.up.clone();
    const defEye = def.sim.state.pos.clone().addScaledVector(defUp, 1.625);
    const basisU = Math.abs(defUp.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
    const tan1 = new Vector3().crossVectors(defUp, basisU).normalize();
    const tan2 = new Vector3().crossVectors(defUp, tan1).normalize();
    let foePos: Vector3 | null = null;
    for (const dist of [8, 6, 4]) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const cand = defEye.clone().addScaledVector(tan1, Math.cos(a) * dist).addScaledVector(tan2, Math.sin(a) * dist);
        if (combat.lineOfSight(defEye, cand)) { foePos = cand; break; }
      }
      if (foePos) break;
    }
    const foe: Target = { id: 99, team: 'red', center: foePos ?? defEye.clone().addScaledVector(tan1, 5), up: defUp, hp: MAX_HP, alive: true, respawnIn: -1 };
    combat.targets.push(foe);
    const shotsBefore = def.shotsTotal;
    stepBots(3);
    check('bots: defender armed with crossbow charges and fires bolt level 1+',
      def.shotsTotal > shotsBefore && def.weapons.lastChargeLevel >= 1,
      `shots=${def.shotsTotal - shotsBefore} lvl=${def.weapons.lastChargeLevel}`);
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
      && easy.spread > hard.spread && easy.firstAttack > hard.firstAttack && easy.mistakes > hard.mistakes && easy.fishSkill < hard.fishSkill);
    check('difficulty: back to normal restores every value', JSON.stringify(BOT) === JSON.stringify(normal));
  }

  // --- lobby: line-ups, islands only for teams that play, allies and per-bot difficulty
  {
    const d = defaultLobby();
    check('lobby: the default is you in red and 2 bots in every other team', playerTeam(d) === 'red' && activeTeams(d).length === 4
      && JSON.stringify(botRoster(d)) === JSON.stringify({ blue: ['normal', 'normal'], green: ['normal', 'normal'], yellow: ['normal', 'normal'] }));
    check('spectator mode fills all active teams with bots', Object.keys(botRoster(d, true)).length === 4
      && (botRoster(d, true).red?.length ?? 0) === 2 && (botRoster(d, true).blue?.length ?? 0) === 2);
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

  // Bots demolish enemy player-built structures blocking their path
  {
    const bw = buildPhysicsWorld(R, map);
    const bbs = new BlockSystem(R, bw);
    const bMatch = new Match(R, bw, map, bbs, 'red');
    const bCombat = new Combat(R, bw, map);
    bCombat.onWorldDamage = (h2d, d) => bbs.damageCollider(h2d, d);
    bCombat.onExplosion = (p, rad, d) => bbs.explosion(p, rad, d);
    bMatch.attach(bCombat);
    const bm = new BotManager(R, bw, map, bCombat, bMatch, bbs, 'red', 0, { red: ['normal', 'normal'], blue: ['normal'] });
    const raider = bm.bots.find((b) => b.team === 'red' && b.role === 'attack')!;
    giveWeapon(raider.weapons, 'rifle', WEAPONS.rifle.mag);
    raider.weapons.reserve.rifle = 120;
    raider.weapons.current = 'rifle';
    raider.goal = 'blue';
    raider.departAt = 0;
    bMatch.time = 300;
    // Place an enemy blue wood wall sealing the red door vestibule at z = -13.5 so the raider must demolish it
    const doorWall = bbs.insertPiece('wall', new Vector3(-2.25, G + 2.25, -13.5), new Vector3(0.125, 2.25, 2.25), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2), 'wood', 'blue');
    const initialSize = bbs.blocks.size;
    for (let k = 0; k < 64 * 10 && bbs.blocks.has(doorWall.collider.handle); k++) {
      bMatch.time += TICK_DT;
      bm.tick(TICK_DT);
      bCombat.tick(TICK_DT);
      bMatch.tick(TICK_DT, new Vector3(0, -5000, 0), false);
    }
    check('bot raiders actively demolish enemy-built walls in their way',
      !bbs.blocks.has(doorWall.collider.handle) && bbs.blocks.size < initialSize,
      `wallGone=${!bbs.blocks.has(doorWall.collider.handle)} remainingHp=${doorWall.hp}`);
  }
}
