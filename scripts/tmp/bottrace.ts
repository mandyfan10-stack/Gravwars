import { Vector3 } from 'three';
import { BotManager } from '../../src/shared/bots';
import { Combat, MAX_HP, Target } from '../../src/shared/combat';
import { BlockSystem } from '../../src/shared/blocks';
import { TICK_DT } from '../../src/shared/constants';
import { Pickups } from '../../src/shared/economy';
import { generateMap } from '../../src/shared/map';
import { Match } from '../../src/shared/match';
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
ps.state.pos.set(0, -3000, 0); ps.mover.place(ps.state); combat.targets.push(me);
const bots = new BotManager(R, w, map, combat, m, bs, 'red');
const pk = new Pickups(R, w, map);
bots.pickups = pk;
const npcs = new NpcManager(R, w, map, combat, pk);
const WHO = process.env.WHO ?? 'blue0';
const b = bots.bots.find((x) => `${x.team}${x.slot}` === WHO)!;
let last = '', jumps = 0, lastKey = '';
for (let k = 0; k < 64 * Number(process.env.T ?? 120); k++) {
  bots.tick(TICK_DT); npcs.tick(TICK_DT); combat.tick(TICK_DT); pk.tick(TICK_DT); m.tick(TICK_DT, ps.state.pos);
  for (const e of combat.events.splice(0)) if (e.type === 'hit' && e.target === b.id) { if (e.killed) console.log(`  t=${m.time.toFixed(1)} KILLED by ${e.owner} (${combat.target(e.owner)?.npc ?? combat.target(e.owner)?.team})`); }
  if (b.jumpT > 0.24) jumps++;
  const st = `${b.task.kind}/${b.status}`;
  if (st !== last || b.routeKey !== lastKey) {
    if (m.time > Number(process.env.FROM ?? 0)) console.log(`t=${m.time.toFixed(1)} ${st} route=${b.routeKey} $${b.wallet.cash} items=${JSON.stringify(b.eco.items)} hp=${b.target.hp.toFixed(0)} pos=${b.sim.state.pos.toArray().map((v) => v.toFixed(1))} g=${b.sim.state.onGround} v=${b.sim.state.vel.length().toFixed(1)} stuck=${b.stuckT.toFixed(1)} frozen=${b.frozenT.toFixed(1)} nudge=${b.nudgeT.toFixed(1)} enemy=${b.enemy?.id ?? '-'} seen=${b.seenT.toFixed(1)} anchorD=${b.sim.state.pos.distanceTo(b.anchor).toFixed(2)} jumps=${jumps}`);
    last = st; lastKey = b.routeKey;
  }
}
