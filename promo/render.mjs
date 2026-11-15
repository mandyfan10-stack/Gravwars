// Renders promo.html frame by frame and pipes it into ffmpeg.
// node promo/render.mjs preview  -> PNG stills in promo/out/preview
// node promo/render.mjs          -> promo/out/gravwars_tiktok.mp4
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(out, { recursive: true });
const FPS = 30;
const preview = process.argv[2] === 'preview';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(pathToFileURL(join(here, 'promo.html')).href);
const T = await page.evaluate(() => window.DURATION);
const grab = async (t) => {
  const url = await page.evaluate((t) => { window.render(t); return document.getElementById('c').toDataURL('image/png'); }, t);
  return Buffer.from(url.split(',')[1], 'base64');
};

if (preview) {
  const times = (process.argv[3] || '0.5,2.5,6,8,12,14,15.5,19,21.5,24,26.5,28.8,30.5,32.2,35.5,39').split(',').map(Number);
  mkdirSync(join(out, 'preview'), { recursive: true });
  for (const t of times) writeFileSync(join(out, 'preview', `t${t.toFixed(1)}.png`), await grab(t));
} else {
  const ffmpeg = execSync('python -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"').toString().trim();
  const ff = spawn(ffmpeg, ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-i', join(here, 'out', 'music.wav'),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart', join(out, 'gravwars_tiktok.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round(T * FPS);
  for (let f = 0; f < n; f++) {
    const buf = await grab(f / FPS);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 150 === 0) console.log(`frame ${f}/${n}`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
}
await browser.close();
if (errors.length) { console.error('PAGE ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('done');
