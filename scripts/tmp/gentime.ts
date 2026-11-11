import { generateMap } from '../../src/shared/map';
for (let i = 0; i < 3; i++) { const t = performance.now(); const m = generateMap(1337); console.log('gen', (performance.now() - t).toFixed(0), 'ms', m.boxes?.length, m.decor.length); }
