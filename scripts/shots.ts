/**
 * Screenshots of the running dev server (npm run dev) for visual checks: `npx tsx scripts/shots.ts [outDir]`.
 * Headless Chrome renders through the real GPU (ANGLE on Vulkan); SwiftShader is far too slow for this scene.
 */
import { chromium } from 'playwright';

const out = process.argv[2] ?? 'shots';
const url = process.env.URL ?? 'http://localhost:5173/';
const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => (window as any).__game?.ready, null, { timeout: 120000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/1-menu.png` });

const g = (fn: string) => page.evaluate(fn);
await g('__game.play()');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/2-hud.png` });

// look at an enemy bot from 4 m: same gravity, facing it
await g(`(() => {
  const G = __game, b = G.bots.bots.find((b) => b.team === 'blue' && b.role === 'defend');
  const up = b.target.up.clone();
  G.sim.setGravity(up.clone().negate());
  G.sim.state.frame.copy(b.sim.state.frame);
  const side = new b.sim.state.pos.constructor(1, 0, 0).applyQuaternion(b.sim.state.frame);
  G.sim.state.pos.copy(b.sim.state.pos).addScaledVector(side, 3.2);
  G.sim.state.vel.set(0, 0, 0);
  G.sim.mover.place(G.sim.state);
  G.local.snap();
  const d = b.sim.state.pos.clone().sub(G.sim.state.pos).applyQuaternion(G.sim.state.frame.clone().invert());
  G.look(Math.atan2(-d.x, -d.z), -0.12);
  G.combat.targets.find((t) => t.id === 0).hp = 1e9;
})()`);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/3-bot.png` });

// shop + build mode
await page.keyboard.press('Digit3');
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/4-build.png` });
// shop: back home, stand at the kiosk, press E; a toast and a kill line for the feed
await page.keyboard.press('Digit1');
await g(`(() => {
  const G = __game;
  G.sim.setGravity(new G.sim.state.pos.constructor(0, -1, 0));
  G.sim.respawn('manual');
  const base = G.map.bases.find((b) => b.team === 'red');
  G.sim.state.pos.set(base.shop[0] + 3, base.shop[1] + 0.2, base.shop[2]);
  G.sim.state.vel.set(0, 0, 0);
  G.sim.mover.place(G.sim.state);
  G.local.snap();
  G.match.wallet.copper = 31; G.match.wallet.crystal = 2;
  G.hud.killfeed('<span style="color:#3b6bff">Синие</span>' + G.icon('swords') + '<span style="color:#3bff6b">Зелёные</span>');
})()`);
await page.waitForTimeout(400);
await page.keyboard.press('KeyE');
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/5-shop.png` });
await browser.close();
if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
console.log('saved to', out);
