// Menu backdrop shot candidates: SHOTS='[{"r":..},...]' renders each (overlay hidden unless UI=1).
import { chromium } from 'playwright';
const out = process.argv[2];
const shots: object[] = JSON.parse(process.env.SHOTS ?? '[{}]');
const times: number[] = JSON.parse(process.env.TIMES ?? '[0]');
const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(process.env.URL ?? 'http://localhost:5181/');
await page.waitForFunction(() => !(document.getElementById('start-game') as HTMLButtonElement).disabled, null, { timeout: 120000 });
if (!process.env.UI) await page.evaluate(() => { document.getElementById('overlay')!.style.visibility = 'hidden'; });
for (let i = 0; i < shots.length; i++) for (const t of times) {
  await page.evaluate(([s, t]) => { const m = (window as any).__menu; Object.assign(m.shot, s); m.seek(t); }, [shots[i], t] as const);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/shot${i}-t${t}.png` });
}
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
