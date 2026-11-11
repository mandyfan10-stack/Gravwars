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
const shot = async (name: string, setup: string, wait = 800) => {
  await g(setup);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.png` });
};
const put = (x: number, y: number, z: number, yaw: number, pitch: number) =>
  `(() => { const G = __game; G.sim.state.frame.identity(); G.sim.state.pos.set(${x}, -138 + ${y}, ${z}); G.sim.state.vel.set(0,0,0); G.sim.mover.place(G.sim.state); G.local.snap(); G.look(${yaw}, ${pitch}); })()`;
// tiles of the red face by their tallest window
const info = JSON.parse(await g(`(() => {
  const t = {};
  for (const b of __game.map.boxes) {
    if (b.pos[1] > -90 || b.pos[1] < -139) continue;
    const k = Math.round(b.pos[0] / 36) + ',' + Math.round(b.pos[2] / 36);
    t[k] ??= { win: 0, tile: 0, car: 0 };
    if (b.mat === 'window') t[k].win = Math.max(t[k].win, b.half[1]);
    if (b.mat === 'car' && b.pos[1] > -136) t[k].car++;
  }
  for (const h of __game.map.hulls) if (h.mat === 'tile' && h.points[1] < -90) { const k = Math.round(h.points[0] / 36) + ',' + Math.round(h.points[2] / 36); t[k] ??= { win: 0, tile: 0, car: 0 }; t[k].tile++; }
  return JSON.stringify(t);
})()`) as string);
console.log(info);
const tiles = Object.entries(info) as [string, { win: number; tile: number; car: number }][];
const tower = tiles.filter(([k]) => k !== '0,0').sort((a, b) => b[1].win - a[1].win)[0][0].split(',').map(Number);
const garage = tiles.sort((a, b) => b[1].car - a[1].car)[0][0].split(',').map(Number);
console.log('tower tile', tower, 'garage tile', garage);
const [tx, tz] = [tower[0] * 36, tower[1] * 36];
for (const [i, yaw] of [0, Math.PI / 2, Math.PI, -Math.PI / 2].entries()) await shot(`int-tower-g${i}`, put(tx + 2, 1.2, tz + 2, yaw, 0));
await shot('int-tower-f3', put(tx + 2, 0.15 + 9 + 1.2, tz + 2, 0, 0));
await shot('int-tower-f3b', put(tx + 2, 0.15 + 9 + 1.2, tz + 2, Math.PI, 0));
const [gx, gz] = [garage[0] * 36, garage[1] * 36];
await shot('int-garage', put(gx + 2, 3.15 + 1.2, gz + 2, 0, -0.1));
console.log('errors', errors.slice(0, 10));
await browser.close();
