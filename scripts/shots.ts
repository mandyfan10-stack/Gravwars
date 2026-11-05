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
  // a rifle in its hands (bots get it later in the match)
  Object.assign(b.weapons, { current: 'rifle' });
  b.weapons.owned.rifle = true; b.weapons.ammo.rifle = 30;
  G.match.time = Math.max(G.match.time, 200);
})()`);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/3-bot.png` });

// back home; give the ladder up to the build tool and some pockets
const home = async (dx: number, dz: number, yaw: number, pitch = 0) => {
  await g(`(() => {
  const G = __game;
  G.sim.setGravity(new G.sim.state.pos.constructor(0, -1, 0));
  G.sim.respawn('manual');
  const base = G.map.bases.find((b) => b.team === 'red');
  G.sim.state.pos.set(base.shop[0] + ${dx}, base.shop[1] + 0.2, base.shop[2] + ${dz});
  G.sim.state.vel.set(0, 0, 0);
  G.sim.mover.place(G.sim.state);
  G.local.snap();
})()`);
  // the respawn resets the view on the next frame: look afterwards
  await page.waitForTimeout(200);
  await g(`__game.look(${yaw}, ${pitch})`);
};
await home(2.4, 0.5, Math.PI / 2, 0.03);
await g(`(() => {
  const G = __game, shop = (id) => G.eco.offers().find((o) => o.item.id === id).item;
  G.match.wallet.cash = 200;
  for (const id of ['rod', 'builder', 'pistol']) G.eco.buy(shop(id));
  G.eco.buy(shop('ammo-pistol'));
  G.match.wallet.cash = 23;
  Object.assign(G.eco.items, { bottle: 7, apple: 2, fish: 3 });
  G.hud.killfeed('<span style="color:#3b6bff">Синие</span>' + G.icon('swords') + '<span style="color:#3bff6b">Зелёные</span>');
})()`);
// shopkeeper close-up, pistol in hand
await page.keyboard.press('Digit2');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/4-keeper.png` });
// shop: opens on the sell tab when there is something to sell; then the buy tab
await page.keyboard.press('KeyE');
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/5-shop-sell.png` });
await page.keyboard.press('KeyQ');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/6-shop-buy.png` });
await page.keyboard.press('KeyE');

// fists, build tool
await page.keyboard.press('Digit1');
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/7-fists.png` });
await page.keyboard.press('Digit5');
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/8-build.png` });

// park: stand at the pond with the rod, cast, force a bite
await page.keyboard.press('Digit6');
await g(`(() => {
  const G = __game, p = G.map.ponds.find((q) => q.team === 'red');
  G.sim.state.pos.set(p.pos[0] - p.half[0] - 0.8, p.pos[1] + 0.25 + 0.1 + 0.95, p.pos[2]);
  G.sim.state.vel.set(0, 0, 0);
  G.sim.mover.place(G.sim.state);
  G.local.snap();
})()`);
await page.waitForTimeout(150);
await g(`__game.look(-Math.PI / 2, -0.45)`);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/9-pond.png` });
await page.mouse.down();
await page.waitForTimeout(50);
await page.mouse.up();
await page.waitForTimeout(800);
// skip the wait: the fish bites now
await g(`(() => { const f = __game.pockets.fishing; f.dur = 0; })()`);
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/10-bite.png` });

// apples under a tree on the home island
await g(`(() => {
  const G = __game, a = G.pickups.items.find((i) => i.kind === 'apple' && i.up.y > 0.99 && i.alive);
  G.sim.state.pos.set(a.pos.x + 1.1, a.pos.y + 0.95, a.pos.z + 1.1);
  G.sim.state.vel.set(0, 0, 0);
  G.sim.mover.place(G.sim.state);
  G.local.snap();
})()`);
await page.waitForTimeout(150);
await g(`__game.look(Math.PI / 4, -0.55)`);
await page.keyboard.press('Digit1');
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/11-apple.png` });

// city NPCs on the home island (red: up = +y). Put the player `dist` m in front of one, facing it.
const faceNpc = async (pick: string, dist: number, side = 0, pitch = -0.08) => {
  await g(`(() => {
  const G = __game, n = G.npcs.npcs.find(${pick});
  window.__npc = n;
  const p = n.sim.state.pos, f = new p.constructor(0, 0, -1).applyQuaternion(n.sim.state.frame);
  f.applyAxisAngle(new p.constructor(0, 1, 0), n.sim.state.yaw);
  G.sim.state.pos.copy(p).addScaledVector(f, ${dist}).add(new p.constructor(${side}, 0, 0));
  G.sim.state.vel.set(0, 0, 0);
  G.sim.mover.place(G.sim.state);
  G.local.snap();
})()`);
  await page.waitForTimeout(150);
  await g(`(() => { const G = __game, d = __npc.sim.state.pos.clone().sub(G.sim.state.pos); G.look(Math.atan2(-d.x, -d.z), ${pitch}); })()`);
};
// a bum having a drink
await g(`(() => { const G = __game, n = G.npcs.npcs.find((n) => n.kind === 'bum' && n.island === 'red' && n.state !== 'dead');
  n.state = 'drink'; n.stateT = 0; window.__npc = n; })()`);
await faceNpc('(n) => n === __npc', 2.6, 0.6, -0.12);
await page.waitForTimeout(700);
await g(`__game.look(__game.input.yaw, -0.12)`);
await page.screenshot({ path: `${out}/12-bum.png` });
// a gang: stand in their view and let suspicion build (the "?"), then the "!"
await faceNpc(`(n) => n.kind === 'gang' && n.island === 'red' && n.state !== 'dead'`, 13, 1.5, -0.03);
await page.waitForTimeout(1400);
await page.screenshot({ path: `${out}/13-gang-suspicious.png` });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}/14-gang-alert.png` });
// drop a bandit: cash on the ground
await g(`(() => { const t = __npc.target; __game.combat.damage(t, 999, 0, false, t.center); })()`).catch((e) => errors.push(String(e)));
await page.waitForTimeout(1800);
await page.screenshot({ path: `${out}/15-cash.png` });

// guns: the rifle, a reload in progress, then building materials with damage (cracks)
await home(2.4, 0.5, -Math.PI / 2, 0.02);
await g(`(() => { const G = __game, ws = G.weapons; ws.owned.rifle = true; ws.ammo.rifle = 17; ws.reserve.rifle = 60; ws.ammo.pistol = 15; })()`);
await page.keyboard.press('Digit3');
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/16-rifle.png` });
await page.keyboard.press('KeyR');
await page.waitForTimeout(650);
await page.screenshot({ path: `${out}/17-reload.png` });
await page.waitForTimeout(1800);
await page.keyboard.press('Digit2');
await g(`__game.weapons.ammo.pistol = 0`);
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/18-pistol-empty.png` });
await g(`__game.look(-Math.PI / 2, -0.05)`);
await page.waitForTimeout(300);
await g(`(() => {
  const G = __game, P = G.sim.state.pos, V = P.constructor, Q = G.camera.quaternion.constructor;
  const f = G.camera.getWorldDirection(new V()); f.y = 0;
  const ax = Math.abs(f.x) > Math.abs(f.z) ? new V(Math.sign(f.x), 0, 0) : new V(0, 0, Math.sign(f.z));
  const side = new V(-ax.z, 0, ax.x);
  const q = new Q().setFromUnitVectors(new V(1, 0, 0), ax);
  const feet = P.y - 0.915;
  [['wood', 1], ['stone', 0.5], ['metal', 0.25], ['wood', 0.2]].forEach(([m, hp], i) => {
    const c = P.clone().addScaledVector(ax, 8).addScaledVector(side, (i - 1.5) * 4.1); c.y = feet + 1.5;
    const b = G.blocks.insertPiece('wall', c, new V(0.125, 1.5, 2), q, m);
    b.hp = Math.round(b.maxHp * hp);
  });
  G.blocks.version++;
})()`);
await page.keyboard.press('Digit1');
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/19-materials.png` });
await browser.close();
if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
console.log('saved to', out);
