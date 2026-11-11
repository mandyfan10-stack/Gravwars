import { initRapier, buildPhysicsWorld } from '../../src/shared/physics';
import { generateMap } from '../../src/shared/map';
import { Props } from '../../src/shared/props';
import { TICK_DT } from '../../src/shared/constants';
const R = await initRapier();
const map = generateMap(1337, 'red', ['red', 'blue', 'green', 'yellow']);
const world = buildPhysicsWorld(R, map);
const props = new Props(world, map);
const asleep = () => props.bodies.filter((b) => b.isSleeping()).length;
console.log("asleep after build", asleep());
for (let k = 0; k < 64 * 4; k++) { props.tick(TICK_DT); if (k % 32 === 0) console.log(k, asleep()); }
