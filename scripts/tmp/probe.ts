import { generateMap } from '../../src/shared/map';
const m = generateMap();
for (const l of m.lanes) if (l.a === 'ny' || l.b === 'ny') console.log(l.id, 'A', JSON.stringify(l.pathA), 'B', JSON.stringify(l.pathB), 'back', JSON.stringify(l.back));
console.log('ponds', m.ponds.map(p => p.team).join(','));
console.log('spawn red', m.spawns.red);
console.log('faces', m.faces.map(f => `${f.id}:${f.team}:${f.up}`).join(' '));
console.log(m.buildings.slice(0, 3));
