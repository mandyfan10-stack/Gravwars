// Renders promo/cartoon.html frame by frame and pipes it into ffmpeg with cartoon_music.wav.
// node promo/render_cartoon.mjs preview -> PNG stills in promo/out/cartoon_preview
// node promo/render_cartoon.mjs         -> promo/out/gravwars_cartoon.mp4
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(out, { recursive: true });
const FPS = 30;
const preview = process.argv[2] === 'preview';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(pathToFileURL(join(here, 'cartoon.html')).href);
const T = await page.evaluate(() => window.DURATION);

const grab = async (t) => {
  const url = await page.evaluate((tt) => {
    window.render(tt);
    return document.getElementById('c').toDataURL('image/png');
  }, t);
  return Buffer.from(url.split(',')[1], 'base64');
};

if (preview) {
  const times = (
    process.argv[3] ||
    '1.0,3.5,8.0,10.0,12.0,15.5,18.5,20.4,22.5,25.0,27.8,30.2,33.5,36.2,41.5,45.0,50.0'
  )
    .split(',')
    .map(Number);
  const prevDir = join(out, 'cartoon_preview');
  mkdirSync(prevDir, { recursive: true });
  for (const t of times) {
    writeFileSync(join(prevDir, `t${t.toFixed(1)}.png`), await grab(t));
  }
  console.log('Preview stills written to', prevDir);
} else {
  const outMp4 = join(out, 'gravwars_cartoon.mp4');
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'png',
      '-framerate', String(FPS),
      '-i', '-',
      '-i', join(out, 'cartoon_music.wav'),
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      outMp4,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );

  const n = Math.round(T * FPS);
  for (let f = 0; f < n; f++) {
    const buf = await grab(f / FPS);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 150 === 0) console.log(`frame ${f}/${n}`);
  }
  ff.stdin.end();
  const code = await new Promise((r) => ff.on('close', r));
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
  console.log('Video written to', outMp4);
}

await browser.close();
if (errors.length) {
  console.error('PAGE ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('done');
