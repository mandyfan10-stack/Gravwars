// Menu screenshots: the pre-match menu (lobby), after a few seconds of the background animation.
import { chromium } from 'playwright';
const out = process.argv[2];
const wait = Number(process.env.WAIT ?? 2500);
const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else if (m.type() === 'log') console.log('  page:', m.text()); });
await page.goto(process.env.URL ?? 'http://localhost:5181/');
await page.waitForFunction(() => !(document.getElementById('start-game') as HTMLButtonElement).disabled, null, { timeout: 120000 });
await page.waitForTimeout(wait);
await page.screenshot({ path: `${out}/menu-a.png` });
await page.waitForTimeout(Number(process.env.WAIT2 ?? 3000));
await page.screenshot({ path: `${out}/menu-b.png` });
if (process.env.SETTINGS) { await page.click('#show-settings'); await page.waitForTimeout(300); await page.screenshot({ path: `${out}/menu-settings.png` }); }
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
