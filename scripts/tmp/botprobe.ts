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
ps.state.pos.set(0, -3000, 0);
ps.mover.place(ps.state);
combat.targets.push(me);
const bots = new BotManager(R, w, map, combat, m, bs, 'red');
const pk = new Pickups(R, w, map);
bots.pickups = pk;
const npcs = new NpcManager(R, w, map, combat, pk);
const T = Number(process.env.T ?? 360);
const tasks = new Map<string, number>();
const shots = new Map<string, number>();
let kills = 0;
const t0 = performance.now();
for (let k = 0; k < 64 * T; k++) {
  bots.tick(TICK_DT);
  npcs.tick(TICK_DT);
  combat.tick(TICK_DT);
  pk.tick(TICK_DT);
  m.tick(TICK_DT, ps.state.pos);
  for (const e of combat.events) if (e.type === 'fire') {
    const b = bots.bots.find((x) => x.id === e.owner);
    if (b) { const k = `${e.weapon}:${b.enemy ? (b.enemy.npc ? 'npc-' + b.enemy.npc : 'fighter') : b.status}`; shots.set(k, (shots.get(k) ?? 0) + 1); }
  }
  for (const e of combat.events.splice(0)) if (e.type === 'hit' && e.killed && !combat.target(e.target)?.npc && !combat.target(e.owner)?.npc) kills++;
  for (const b of bots.bots) tasks.set(b.status, (tasks.get(b.status) ?? 0) + TICK_DT);
  if (k % (64 * 30) === 0) {
    console.log(`t=${m.time.toFixed(0)} ` + bots.bots.map((b) => `${b.team[0]}${b.slot}:${b.status}|$${b.wallet.cash}c${b.wallet.crystal}w${b.kit.wood}|${b.weapons.current}`).join('  '));
  }
}
console.log('ms/s', ((performance.now() - t0) / T).toFixed(1), 'kills', kills, 'beds', m.beds.map((b) => `${b.team}:${b.alive ? b.hp.toFixed(0) : 'X'}`).join(' '));
console.log([...tasks.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v.toFixed(0)}`).join(', '));
for (const b of bots.bots) console.log(b.team, b.slot, b.role, 'earned', b.earned, 'spent', b.spent, 'built', b.built, 'taken', b.taken, 'fish', b.eco.items.fish, 'bought', b.bought.join(','), 'goal', b.goal, 'likes', JSON.stringify(b.likes));
console.log('shots', [...shots.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', '));
