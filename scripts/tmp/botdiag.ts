import { Vector3 } from 'three';
import { BlockSystem } from '../../src/shared/blocks';
import { BotManager } from '../../src/shared/bots';
import { Combat, MAX_HP, Target } from '../../src/shared/combat';
import { TICK_DT } from '../../src/shared/constants';
import { Pickups } from '../../src/shared/economy';
import { faceByUp, generateMap } from '../../src/shared/map';
import { Match } from '../../src/shared/match';
import { upOf } from '../../src/shared/math';
import { NpcManager } from '../../src/shared/npcs';
import { buildPhysicsWorld, initRapier } from '../../src/shared/physics';
import { PlayerSim } from '../../src/shared/sim';
const R = await initRapier();
const map = generateMap();
const w = buildPhysicsWorld(R, map);
const ps = new PlayerSim(R, w, map, 'red');
const combat = new Combat(R, w, map, [ps.mover.collider]);
const bs = new BlockSystem(R, w, ps.mover.collider);
combat.onWorldDamage = (h, d) => { bs.damageCollider(h, d); };
combat.onExplosion = (p, r, d) => bs.explosion(p, r, d);
const m = new Match(R, w, map, bs, 'red', ps.mover.collider);
const me: Target = { id: 0, team: 'red', center: ps.state.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1 };
ps.state.pos.set(0, -3000, 0); ps.mover.place(ps.state);
combat.targets.push(me);
const bots = new BotManager(R, w, map, combat, m, bs, 'red');
const npcs = process.argv[2] === 'nonpc' ? null : new NpcManager(R, w, map, combat, new Pickups(R, w, map));
const T = Number(process.argv[3] ?? 360);
for (let k = 0; k < 64 * T; k++) {
  bots.tick(TICK_DT); npcs?.tick(TICK_DT); combat.tick(TICK_DT); m.tick(TICK_DT, ps.state.pos);
  for (const e of combat.events.splice(0)) if (e.type === 'hit' && e.killed && !combat.target(e.target)?.npc && !combat.target(e.owner)?.npc) console.log(m.time.toFixed(0), 'kill', e.owner, '->', e.target);
  if (k % (64 * 15) === 0) {
    console.log(`t=${m.time.toFixed(0)} blocks=${bs.blocks.size}`);
    for (const b of bots.bots) {
      const f = faceByUp(map, upOf(b.sim.state.frame));
      const p = b.sim.state.pos;
      console.log(`  ${b.id} ${b.team} ${b.role} goal=${b.goal} face=${f?.id} pos=${p.toArray().map(v => v.toFixed(0)).join(',')} ${b.status} key=${b.routeKey.slice(0, 40)} wp=${b.wp}/${b.routePts.length} alive=${b.target.alive}`);
    }
  }
}
console.log('broken', m.beds.filter(b => !b.alive).map(b => b.team));
