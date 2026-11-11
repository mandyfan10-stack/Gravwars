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
import { upOf } from '../../src/shared/math';

const R = await initRapier();
const map = generateMap();
const w = buildPhysicsWorld(R, map);
const ps = new PlayerSim(R, w, map, 'red');
const combat = new Combat(R, w, map, [ps.mover.collider]);
const bs = new BlockSystem(R, w, ps.mover.collider);
combat.onWorldDamage = (h, d) => { bs.damageCollider(h, d); };
const m = new Match(R, w, map, bs, 'red', ps.mover.collider);
const me: Target = { id: 0, team: 'red', center: ps.state.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1 };
ps.state.pos.set(0, -3000, 0); ps.mover.place(ps.state); combat.targets.push(me);
const bots = new BotManager(R, w, map, combat, m, bs, 'red');
const pk = new Pickups(R, w, map);
bots.pickups = pk;
const npcs = new NpcManager(R, w, map, combat, pk);
const B = bots as any;
console.log('ponds', B.ponds.length, B.ponds.map((p: any) => `${p.face}:${p.stands.length}`).join(' '));
console.log('shops', B.shops.map((s: any) => `${s.face}/${s.team}:${s.xz.map((v: number) => v.toFixed(1))}:${s.hall}`).join(' '));
const airT = new Map<number, number>();
for (let k = 0; k < 64 * Number(process.env.T ?? 120); k++) {
  bots.tick(TICK_DT); npcs.tick(TICK_DT); combat.tick(TICK_DT); pk.tick(TICK_DT); m.tick(TICK_DT, ps.state.pos);
  combat.events.length = 0;
  for (const b of bots.bots) {
    const a = b.status === 'в полёте' ? (airT.get(b.id) ?? 0) + TICK_DT : 0;
    airT.set(b.id, a);
    if (Math.abs(a - 2) < TICK_DT / 2) {
      const s = b.sim.state; const up = upOf(s.frame);
      console.log(`t=${m.time.toFixed(1)} ${b.team}${b.slot} task=${b.task.kind} onGround=${s.onGround} up=${up.toArray().map((v) => v.toFixed(2))} pos=${s.pos.toArray().map((v) => v.toFixed(1))} vel=${s.vel.length().toFixed(2)} route=${b.routeKey}`);
    }
  }
}
