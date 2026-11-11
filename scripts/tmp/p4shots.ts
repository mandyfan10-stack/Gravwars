// Phase 4 screenshots: bots at work (fast-forwarded match, the player is invulnerable and watches).
import { chromium } from 'playwright';
const out = process.argv[2];
const only = process.env.ONLY?.split(',');
const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else if (m.type() === 'log') console.log('  page:', m.text()); });
// you in red with two bot mates, two bots in every other team
await page.addInitScript(() => {
  const bot = { kind: 'bot', difficulty: 'normal' };
  const seats = { red: [{ kind: 'player' }, bot, bot, null, null], blue: [bot, bot, null, null, null], green: [bot, bot, null, null, null], yellow: [bot, bot, null, null, null] };
  localStorage.setItem('gravity-bedwars-lobby', JSON.stringify({ seats }));
});
await page.goto('http://localhost:5181/');
await page.waitForFunction(() => !(document.getElementById('start-game') as HTMLButtonElement).disabled, null, { timeout: 120000 });
await page.click('#start-game');
await page.waitForFunction(() => (window as any).__game?.ready, null, { timeout: 120000 });
const g = (fn: string) => page.evaluate(fn);
await g('__game.skipIntro()');
await page.waitForTimeout(500);
await g('__game.play()');
await page.waitForTimeout(600);
const snap = (name: string) => page.screenshot({ path: `${out}/${name}.png` });
const want = (k: string) => !only || only.includes(k);

// helpers in the page: fast-forward the match, find a bot, watch it from a spot with a clear view
await g(`(() => {
  const G = __game;
  window.__ff = (sec) => {
    const me = G.combat.targets.find((t) => t.id === 0);
    for (let k = 0; k < 64 * sec; k++) { if (me.alive) me.hp = 100; G.local.onTick(); G.pickups.tick(1 / 64); }
    return G.match.time;
  };
  window.__find = (pred) => G.bots.bots.find((b) => b.target.alive && !b.out && pred(b));
  window.__watch = (b, dist, h, side = 0, foe = false) => {
    const V = G.sim.state.pos.constructor;
    const R = G.bots.R, world = G.bots.world;
    const fr = b.sim.state.frame.clone(), inv = fr.clone().invert();
    const up = new V(0, 1, 0).applyQuaternion(fr);
    const at = b.sim.state.pos.clone();
    const ray = (o, d, len) => world.castRay(new R.Ray(o, d), len, true, undefined, undefined, undefined, undefined, G.combat.notCharacter);
    let best = null, look = at;
    if (foe && b.enemy) {
      // over the bot's shoulder, at its enemy
      look = b.enemy.center.clone();
      const d = look.clone().sub(at); d.addScaledVector(up, -d.dot(up)).normalize();
      const right = new V().crossVectors(d, up);
      best = at.clone().addScaledVector(d, -dist).addScaledVector(up, h).addScaledVector(right, 0.9);
    } else {
      // first from the given side of the bot's facing (0 = in front), then all around (in the bot's own frame)
      const a0 = Math.atan2(-Math.cos(b.sim.state.yaw), -Math.sin(b.sim.state.yaw)) - side;
      for (let i = 0; i < 16; i++) {
        const a = a0 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 8);
        const eye = at.clone().add(new V(Math.cos(a) * dist, h, Math.sin(a) * dist).applyQuaternion(fr));
        const dir = at.clone().sub(eye);
        const len = dir.length();
        dir.normalize();
        if (!ray(eye, dir, len - 0.8) && ray(eye, up.clone().negate(), h + 4)) { best = eye; break; }
      }
      if (!best) best = at.clone().add(new V(dist, h, 0).applyQuaternion(fr));
    }
    G.sim.setGravity(up.clone().negate()); G.sim.state.frame.copy(fr);
    G.sim.state.pos.copy(best).addScaledVector(up, -0.71); G.sim.state.vel.set(0, 0, 0); G.sim.mover.place(G.sim.state); G.local.snap();
    const d = look.clone().sub(best).applyQuaternion(inv);
    G.look(Math.atan2(-d.x, -d.z), Math.atan2(d.y + 0.3, Math.hypot(d.x, d.z)));
    return b.status;
  };
  // keep the camera where it is put (the player floats there for the shot)
  window.__hold = () => { G.sim.state.vel.set(0, 0, 0); };
})()`);
const ffUntil = async (pred: string, max: number, step = 2) => {
  for (let t = 0; t < max; t += step) {
    const ok = await g(`(() => { window.__ff(${step}); return !!window.__find(${pred}); })()`);
    if (ok) return true;
  }
  return false;
};
const show = async (name: string, pred: string, dist = 5, h = 1.6, side = 0, foe = false) => {
  const st = await g(`window.__watch(window.__find(${pred}), ${dist}, ${h}, ${side}, ${foe})`);
  const where = () => g(`__game.sim.state.pos.toArray().map((v) => v.toFixed(1)).join(',') + ' bot ' + window.__find(${pred})?.sim.state.pos.toArray().map((v) => v.toFixed(1)).join(',')`);
  console.log('  at', await where());
  await page.waitForTimeout(foe ? 160 : 450);
  console.log('  then', await where());
  await snap(name);
  console.log(name, '—', st, '@', ((await g('__game.match.time')) as number).toFixed(0), 's');
};
const onRed = `(b) => b.target.up.y > 0.99`;

if (want('fish')) {
  if (await ffUntil(`(b) => (${onRed})(b) && b.status === 'рыбачит'`, 120)) await show('1-bot-fishing', `(b) => (${onRed})(b) && b.status === 'рыбачит'`, 4, 1.0, 1.1);
}
if (want('shop')) {
  if (await ffUntil(`(b) => (${onRed})(b) && b.status === 'покупает'`, 150, 0.25))
    await show('3-bot-shopping', `(b) => (${onRed})(b) && b.status === 'покупает'`, 3.5, 1.2);
}
if (want('bridge')) {
  const pred = `(b) => b.status === 'строит мост' && b.built >= 8`;
  if (await ffUntil(pred, 260, 0.5)) await show('4-bot-bridge', pred, 4, 1.6, Math.PI * 0.85);
}
if (want('defend')) {
  const pred = `(b) => (${onRed})(b) && b.team === 'red' && b.task.kind === 'defend' && b.enemy && !b.enemy.npc && b.sim.state.onGround && b.enemy.center.distanceTo(b.sim.state.pos) < 16`;
  if (await ffUntil(pred, 300, 0.25)) await show('5-bots-defend', pred, 2.4, 0.5, 0, true);
}
if (want('score')) {
  await g('window.__ff(5)');
  await g(`__game.input.keys?.add?.('Tab')`);
  await page.keyboard.down('Tab');
  await page.waitForTimeout(500);
  await snap('2-scoreboard-allies');
  await page.keyboard.up('Tab');
}
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
