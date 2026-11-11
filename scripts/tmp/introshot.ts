// The start: menu → flight into the player's eyes (frames at fixed delays after the click).
import { chromium } from 'playwright';
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else if (m.type() === 'log') console.log('  page:', m.text()); });
await page.goto(process.env.URL ?? 'http://localhost:5181/');
await page.waitForFunction(() => !(document.getElementById('start-game') as HTMLButtonElement).disabled, null, { timeout: 120000 });
for (const sel of JSON.parse(process.env.LOBBY ?? "[]")) { await page.click(sel); await page.waitForTimeout(100); }
await page.waitForTimeout(1500);
const t0 = Date.now();
await page.click('#start-game');
await page.evaluate(() => { document.getElementById('overlay')!.classList.add('hidden'); });
await page.waitForFunction(() => (window as any).__game?.ready, null, { timeout: 120000 });
console.log('ready after', Date.now() - t0, 'ms');
const at: number[] = JSON.parse(process.env.AT ?? '[300,900,1500,2100,2700,3300,3700,4300]');
for (const [i, ms] of at.entries()) {
  await page.waitForTimeout(i ? ms - at[i - 1] : ms);
  await page.screenshot({ path: `${out}/intro-${i}.png` });
}
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
