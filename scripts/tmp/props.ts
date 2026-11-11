import { Vector3 } from 'three';
import { initRapier, buildPhysicsWorld } from '../../src/shared/physics';
import { generateMap } from '../../src/shared/map';
import { Props } from '../../src/shared/props';
import { TICK_DT } from '../../src/shared/constants';
const R = await initRapier();
const map = generateMap(1337, 'red', ['red', 'blue', 'green', 'yellow']);
let t0 = performance.now();
const world = buildPhysicsWorld(R, map);
console.log('build ms', (performance.now() - t0).toFixed(0), 'crates', map.crates.length);
const props = new Props(world, map);
const i = props.nearest(new Vector3(0, -138, 30));
const p0 = props.pos(i);
console.log('crate', i, p0.toArray().map((v) => v.toFixed(2)), map.crates[i].kind, 'sleep', props.bodies[i].isSleeping());
t0 = performance.now();
for (let k = 0; k < 64; k++) props.tick(TICK_DT);
console.log('idle 64 ticks ms', (performance.now() - t0).toFixed(1), 'moved', props.pos(i).distanceTo(p0).toFixed(3));
props.push(i, new Vector3(6, 2, 0));
t0 = performance.now();
let n = 0;
for (let k = 0; k < 64 * 8; k++) { props.tick(TICK_DT); n++; if (!props.active) break; }
console.log('after kick ticks', n, 'ms', (performance.now() - t0).toFixed(1), 'pos', props.pos(i).toArray().map((v) => v.toFixed(2)), 'dist', props.pos(i).distanceTo(p0).toFixed(2));
// all crates settled at start? check how many were not resting on something: wake all and see who falls
let fell = 0;
for (let k = 0; k < props.bodies.length; k++) props.bodies[k].wakeUp();
t0 = performance.now();
for (let k = 0; k < 64 * 3; k++) props.tick(TICK_DT);
console.log('all awake 3 s ms', (performance.now() - t0).toFixed(0));
for (let k = 0; k < props.bodies.length; k++) if (props.pos(k).distanceTo(new Vector3(...map.crates[k].pos)) > 0.3) fell++;
console.log('crates that moved > 0.3 m when woken', fell);
for (let k = 0; k < props.bodies.length; k++) {
  const d = props.pos(k).distanceTo(new Vector3(...map.crates[k].pos));
  if (d > 0.3) console.log(k, map.crates[k].kind, map.crates[k].half[0].toFixed(2), 'moved', d.toFixed(2), map.crates[k].pos.map((v) => v.toFixed(1)).join(','));
}
