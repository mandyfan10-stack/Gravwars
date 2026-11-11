import { Vector3 } from 'three';
import { initRapier, buildPhysicsWorld } from '../../src/shared/physics';
import { generateMap } from '../../src/shared/map';
import { Props } from '../../src/shared/props';
import { Combat } from '../../src/shared/combat';
import { TICK_DT, WORLD } from '../../src/shared/constants';
const R = await initRapier();
const map = generateMap();
const G = -WORLD.cubeHalf;
const w = buildPhysicsWorld(R, map);
const props = new Props(w, map);
const cm = new Combat(R, w, map);
cm.props = props;
const Y = new Vector3(0, 1, 0);
const i = map.crates.findIndex((cr) => cr.kind === 'crate' && Math.abs(cr.pos[1] - G) < 1.5);
const p0 = props.pos(i);
console.log('crate', i, p0.toArray().map((v) => v.toFixed(2)), 'half', map.crates[i].half, 'neighbours',
  map.crates.filter((c, k) => k !== i && new Vector3(...c.pos).distanceTo(p0) < 3).length);
for (const d of [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)]) {
  const hit = w.castRay(new R.Ray(p0.clone().addScaledVector(d, map.crates[i].half[0] + 0.05), d), 6, true);
  console.log('dir', d.toArray(), 'free', hit ? hit.timeOfImpact.toFixed(2) : '>6');
}
const h = map.crates[i].half[1];
const kEye = p0.clone().addScaledVector(Y, -h + 1.6).addScaledVector(new Vector3(1, 0, 0), 1.4);
console.log('n', cm.kick(0, kEye, new Vector3(-1, 0, 0), Y), 'vel', props.bodies[i].linvel());
for (let k = 0; k < 10; k++) props.tick(TICK_DT);
console.log('after 10 ticks', props.pos(i).toArray().map((v) => v.toFixed(2)), props.bodies[i].linvel());
