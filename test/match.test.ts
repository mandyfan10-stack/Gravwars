/* Headless 15-minute full-match bot soak test: run with `npm run test:sim`. */
import { Vector3 } from 'three';
import { BlockSystem } from '../src/shared/blocks';
import { BotManager } from '../src/shared/bots';
import { Combat, MAX_HP, Target } from '../src/shared/combat';
import { TICK_DT } from '../src/shared/constants';
import { Pickups } from '../src/shared/economy';
import { generateMap } from '../src/shared/map';
import { BED_HP, Match } from '../src/shared/match';
import { NpcManager } from '../src/shared/npcs';
import { buildPhysicsWorld, initRapier } from '../src/shared/physics';
import { PlayerSim } from '../src/shared/sim';
import { TEAMS } from '../src/shared/teams';

const R = await initRapier();
const map = generateMap();
const perfBudgetMul = process.env.CI ? 2.5 : 1;

let failed = 0;
function check(name: string, ok: boolean, info = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`);
  if (!ok) failed++;
}

// Bots: a full headless match (player parked out of reach): they earn, shop, build, defend and raid; crystals fall.
{
  const w = buildPhysicsWorld(R, map);
  const ps = new PlayerSim(R, w, map, 'red');
  const combat = new Combat(R, w, map, [ps.mover.collider]);
  const bs = new BlockSystem(R, w, ps.mover.collider);
  combat.onWorldDamage = (h, d) => { bs.damageCollider(h, d); };
  combat.onExplosion = (p, r, d) => bs.explosion(p, r, d);
  const m = new Match(R, w, map, bs, 'red', ps.mover.collider);
  m.attach(combat);
  const me: Target = { id: 0, team: 'red', center: ps.state.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1 };
  ps.state.pos.set(0, -3000, 0);
  ps.mover.place(ps.state);
  combat.targets.push(me);
  const bots = new BotManager(R, w, map, combat, m, bs, 'red');
  const pk = new Pickups(R, w, map);
  bots.pickups = pk;
  const npcs = new NpcManager(R, w, map, combat, pk);
  check('two bots per enemy team', bots.bots.length === (TEAMS.length - 1) * 2 && !bots.bots.some((b) => b.team === 'red'));
  check('bots start with fists and no money like the player', bots.bots.every((b) => b.weapons.current === 'fists'
    && !b.weapons.owned.pistol && b.wallet.cash === 0 && b.kit.wood === 0));

  let kills = 0;
  let maxAir = 0;
  let idle = 0, samples = 0;
  let crystalHits = 0;
  const kinds = new Set<string>();
  let defended = false;
  const air = new Map<number, number>();
  const t0 = performance.now();
  const MATCH_T = 900;
  for (let k = 0; k < 64 * MATCH_T; k++) {
    bots.tick(TICK_DT);
    npcs.tick(TICK_DT);
    combat.tick(TICK_DT);
    m.tick(TICK_DT, ps.state.pos);
    pk.tick(TICK_DT);
    for (const e of m.events.splice(0)) if (e.type === 'bedHit' || e.type === 'bedStage1Broken' || e.type === 'bedBroken') crystalHits++;
    for (const e of combat.events.splice(0)) if (e.type === 'hit' && e.killed && !combat.target(e.target)?.npc && !combat.target(e.owner)?.npc) kills++;
    if (k % 64 === 0) for (const b of bots.bots) {
      if (b.out || !b.target.alive) continue;
      samples++;
      kinds.add(b.task.kind);
      if (b.task.kind === 'defend') defended = true;
      if (b.task.kind === 'patrol') idle++;
    }
    for (const b of bots.bots) {
      const a = b.target.alive && !b.sim.state.onGround ? (air.get(b.id) ?? 0) + TICK_DT : 0;
      air.set(b.id, a);
      maxAir = Math.max(maxAir, a);
    }
  }
  const broken = m.beds.filter((b) => b.stage === 2 || !b.alive || b.hp < BED_HP).map((b) => `${b.team}(${b.stage}:${b.hp.toFixed(0)})`);
  const all = bots.bots;
  check('bots earn money and spend it at the counters', all.every((b) => b.earned > 0 && b.spent > 0 && b.bought.length > 0),
    all.map((b) => `${b.team}${b.role[0]} +${b.earned}/-${b.spent}`).join(' '));
  check('every bot buys a gun; raiders buy wood for their bridges',
    all.every((b) => b.bought.includes('pistol')) && all.some((b) => (b.bought.includes('wood') || b.bought.includes('builder')) && b.built > 0)
    && all.every((b) => b.kit.wood >= 0 && b.wallet.cash >= 0));
  check('bots pick up loot and fish for money', all.some((b) => b.taken > 0) && kinds.has('fish') && kinds.has('shop'),
    [...kinds].join(','));
  check('bots defend their base when it is attacked, and raid', defended && kinds.has('raid'));
  check('bots are always busy (patrol is a rare fallback)', idle / samples < 0.1, `patrol ${((100 * idle) / samples).toFixed(1)} %`);
  check('bots attack/break crystals within 15 minutes', crystalHits > 0 || broken.length > 0, `hits=${crystalHits} broken=${broken.join(',')}`);
  check('bots fight each other', kills >= 2, `kills=${kills}`);
  check('no bot stays airborne for long', maxAir < 10, `max=${maxAir.toFixed(1)}s`);
  check('bot positions stay finite', bots.bots.every((b) => b.sim.state.pos.toArray().every(Number.isFinite)));
  check('bots are cheap to simulate (with the city NPCs)', (performance.now() - t0) / MATCH_T < 130 * perfBudgetMul, `${((performance.now() - t0) / MATCH_T).toFixed(1)} ms per game second`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall good');
process.exit(failed ? 1 : 0);
