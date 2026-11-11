import { chromium } from 'playwright';
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5181/');
await page.waitForFunction(() => !(document.getElementById('start-game') as HTMLButtonElement).disabled, null, { timeout: 120000 });
await page.click('#start-game');
await page.waitForFunction(() => (window as any).__game?.ready, null, { timeout: 120000 });
const g = (fn: string) => page.evaluate(fn);
await g('__game.skipIntro()');
await page.waitForTimeout(500);
await g('__game.play()');
await page.waitForTimeout(600);
const shot = async (name: string, setup: string, wait = 700) => {
  await g(setup);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.png` });
};
const put = (x: number, y: number, z: number, yaw: number, pitch: number) =>
  `(() => { const G = __game; G.sim.state.frame.identity(); G.sim.state.pos.set(${x}, -138 + ${y}, ${z}); G.sim.state.vel.set(0,0,0); G.sim.mover.place(G.sim.state); G.local.snap(); G.look(${yaw}, ${pitch}); })()`;
await shot('1-hall', put(5, 1.2, 6, 0, 0));
await shot('2-street', put(18, 1.2, -30, 0, 0.05));
await shot('3-up', put(18, 1.2, -30, 0, 1.2));
await shot('4-rim', put(18, 1.2, -84, 0, -0.1));
// build one lane of the red face fully (for the look)
await g(`(() => { const G = __game; const L = G.map.lanes.find((l) => l.a === 'ny'); G.lane = L; for (const p of L.pieces) G.blocks.insertPiece(p.kind, new G.sim.state.pos.constructor(...p.center), new G.sim.state.pos.constructor(...p.half), new G.camera.quaternion.constructor(...p.quat), 'wood', 'red'); })()`);
const lane = await g(`JSON.stringify(__game.lane.pathA)`);
console.log('lane', lane);
const pa = JSON.parse(lane as string);
await shot('5-lane', put(pa[0][0] * 0.9, 1.2, pa[0][1] * 0.9, Math.atan2(-(pa[1][0] - pa[0][0]), -(pa[1][1] - pa[0][1])), -0.05), 900);
await shot('6-corner', put(pa[1][0] - (pa[1][0] - pa[0][0]) * 0.3, 1.2, pa[1][1] - (pa[1][1] - pa[0][1]) * 0.3, Math.atan2(-(pa[2][0] - pa[1][0]), -(pa[2][1] - pa[1][1])), 0.35), 900);
// interior of a building: find a window box on the red face
const tower = await g(`(() => { const b = __game.map.boxes.find((b) => b.mat === 'window' && b.half[1] > 10 && b.pos[1] < -100); return b ? JSON.stringify(b.pos) : null; })()`);
console.log('tower glass', tower);
console.log('errors', errors.slice(0, 10));
await browser.close();
