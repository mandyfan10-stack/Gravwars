// Shop window: buy tab (some things owned, cursor on a tile), sell tab with loot.
import { chromium } from 'playwright';
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1600), height: Number(process.env.H ?? 900) } });
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
await g(`(() => {
  const G = __game, shop = (id) => G.eco.offers().find((o) => o.item.id === id).item;
  G.match.wallet.cash = 400; G.match.wallet.crystal = 20;
  for (const id of ${process.env.BUY ?? "['pistol', 'builder', 'ammo-pistol', 'grenade']"}) G.eco.buy(shop(id));
  G.match.wallet.cash = ${process.env.CASH ?? 33}; G.match.wallet.crystal = ${process.env.CRYSTAL ?? 3};
  const base = G.map.bases.find((b) => b.team === 'red');
  G.sim.state.pos.set(base.shop[0] + 2.4, base.shop[1] + 0.2, base.shop[2] + 0.5); G.sim.mover.place(G.sim.state); G.local.snap();
})()`);
await page.waitForTimeout(300);
await g(`__game.look(Math.PI / 2, 0.03)`);
await page.waitForTimeout(300);
await page.keyboard.press('KeyE');
await page.waitForTimeout(200);
await g(`__game.ui.tab = 'buy'`);
const hoverOn = async (id: string) => {
  const r = await g(`(() => { const e = document.querySelector('#shop [data-id="${id}"]'); if (!e) return null; const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`) as number[] | null;
  if (r) await g(`__game.cursor.moveTo(${r[0]}, ${r[1]})`);
  await page.waitForTimeout(250);
};
for (const id of (process.env.HOVER ?? 'shotgun,rocket').split(',')) { await hoverOn(id); await page.screenshot({ path: `${out}/shop-${id}.png` }); }
await g(`(() => { const G = __game; G.eco.items.apple = 3; G.eco.items.fish = 2; G.eco.items.bottle = 5; G.ui.tab = 'sell'; })()`);
await page.waitForTimeout(200);
await hoverOn('fish');
await page.screenshot({ path: `${out}/shop-sell.png` });
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
