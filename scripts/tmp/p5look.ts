// Phase 5: compare retro looks on the same views.
import { chromium } from 'playwright';
const out = process.argv[2];
const looks = JSON.parse(process.env.LOOKS ?? '[[480,24]]') as [number, number][];
const views = (process.env.VIEWS ?? 'street,hall').split(',');
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
const put = (x: number, y: number, z: number, yaw: number, pitch: number) => g(`(() => { const G = __game; G.sim.setGravity(new G.sim.state.pos.constructor(0, -1, 0)); G.sim.state.frame.identity(); G.sim.state.pos.set(${x}, -138 + ${y}, ${z}); G.sim.state.vel.set(0,0,0); G.sim.mover.place(G.sim.state); G.local.snap(); G.look(${yaw}, ${pitch}); })()`);
const VIEW: Record<string, [number, number, number, number, number]> = {
  street: [18, 1.2, -30, 0, 0.02],
  hall: [5, 1.2, 6, 0.6, -0.05],
  park: [-40, 1.2, 40, 2.4, 0.0],
  up: [18, 1.2, -30, 0.3, 0.75],
};
await g(`(() => { const G = __game; G.combat.targets.find((t) => t.id === 0).hp = 1e9; })()`);
// a close look at the nearest decor of a kind on the red face: from its front-left, 6 m away
const near = (kind: string, dist: number, side: number, h: number) => g(`(() => {
  const G = __game, V = G.sim.state.pos.constructor, Q = G.camera.quaternion.constructor;
  const list = G.map.decor.filter((d) => d.kind === '${kind}' && d.pos[1] < -130);
  const me = new V(5, -137, 6);
  list.sort((a, b) => new V(...a.pos).distanceTo(me) - new V(...b.pos).distanceTo(me));
  const d = list[0], q = new Q(...d.quat), at = new V(...d.pos);
  const dir = new V(Math.sin(${side}), 0, -Math.cos(${side})).applyQuaternion(q);
  const eye = at.clone().addScaledVector(dir, ${dist}).add(new V(0, ${h}, 0));
  G.sim.setGravity(new V(0, -1, 0)); G.sim.state.frame.identity();
  G.sim.state.pos.copy(eye).add(new V(0, -0.71, 0)); G.sim.state.vel.set(0, 0, 0); G.sim.mover.place(G.sim.state); G.local.snap();
  const v = at.clone().add(new V(0, ${kind === 'bus' ? 1.5 : kind === 'lamp' ? 3 : 0.8}, 0)).sub(eye);
  G.look(Math.atan2(-v.x, -v.z), Math.atan2(v.y, Math.hypot(v.x, v.z)));
})()`);
const NEAR: Record<string, [string, number, number, number]> = {
  sedan: ['sedan', 5.5, 0.7, 0.6], hatch: ['hatch', 5, 0.8, 0.6], van: ['van', 6, 0.7, 0.8], bus: ['bus', 11, 0.6, 1.0], lamp: ['lamp', 5, 1.6, 0.3],
};
for (const v of views) {
  if (NEAR[v]) await near(...NEAR[v]);
  else await put(...VIEW[v]);
  await page.waitForTimeout(700);
  for (const [lines, levels] of looks) {
    await g(`__game.gfx.setLook({ lines: ${lines}, levels: ${levels} })`);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${out}/${v}-${lines}-${levels}.png` });
  }
}
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
