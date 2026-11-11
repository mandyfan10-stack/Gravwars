import { Vector3 } from 'three';
import { generateMap } from '../../src/shared/mapgen/cube';
const map = generateMap(1337, 'red');
for (const f of map.faces) {
  const up = new Vector3(...f.up);
  const trees = map.trees.filter((t) => t.kind === 'tree' && new Vector3(...t.up).dot(up) > 0.99).length;
  const ponds = map.ponds.filter((p) => new Vector3(...p.up).dot(up) > 0.99).length;
  const shops = map.bases.filter((b) => new Vector3(...b.up).dot(up) > 0.99).map((b) => b.team || 'neutral');
  const gens = map.crystalSpots.filter((c) => new Vector3(...c.up).dot(up) > 0.99).length;
  console.log(f.id, f.team, { trees, ponds, shops, gens, nodes: map.nav[f.id].nodes.length });
}
console.log('ponds', map.ponds[0]);
