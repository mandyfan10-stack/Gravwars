import { chromium } from 'playwright';
const out = process.argv[2];
const only = process.env.ONLY?.split(',');
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
const snap = (name: string) => page.screenshot({ path: `${out}/${name}.png` });
const want = (k: string) => !only || only.includes(k);
const hold = (what: string | null) => g(`(() => { const H = __game.hands; ${what === null ? 'H.bare = true;'
  : `H.bare = false; const i = H.bar.slotOf('${what}'); if (i >= 0) H.bar.sel = i;`} })()`);
const put = (x: number, y: number, z: number, yaw: number, pitch: number) => g(`(() => { const G = __game; G.sim.setGravity(new G.sim.state.pos.constructor(0, -1, 0)); G.sim.state.frame.identity(); G.sim.state.pos.set(${x}, -138 + ${y}, ${z}); G.sim.state.vel.set(0,0,0); G.sim.mover.place(G.sim.state); G.local.snap(); G.look(${yaw}, ${pitch}); })()`);
// buy everything new
await g(`(() => {
  const G = __game, shop = (id) => G.eco.offers().find((o) => o.item.id === id).item;
  G.match.wallet.cash = 400; G.match.wallet.crystal = 20;
  for (const id of ['shotgun', 'rocket', 'hook', 'ammo-rocket', 'ammo-shotgun', 'builder']) console.log(id, G.eco.buy(shop(id)));
  G.combat.targets.find((t) => t.id === 0).hp = 100;
})()`);
await page.waitForTimeout(400);
const god = () => g(`(() => { const me = __game.combat.targets.find((t) => t.id === 0); if (me.alive) me.hp = 100; })()`);

if (want('shop')) {
  await put(5, 1.2, 6, 0, 0);
  await g(`(() => { const G = __game, base = G.map.bases.find((b) => b.team === 'red'); G.sim.state.pos.set(base.shop[0] + 2.4, base.shop[1] + 0.2, base.shop[2] + 0.5); G.sim.mover.place(G.sim.state); G.local.snap(); G.match.wallet.cash = 60; G.match.wallet.crystal = 5; })()`);
  await page.waitForTimeout(300);
  await g(`__game.look(Math.PI / 2, 0.03)`);
  await page.waitForTimeout(300);
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(300);
  await g(`__game.ui.tab = 'buy'`);
  await page.waitForTimeout(400);
  await snap('1-shop');
  await page.keyboard.press('KeyE');
}

// shotgun at a wall of the hall, then the blast
if (want('shotgun')) {
  await put(18, 1.2, -30, 0, 0.0);
  await hold('shotgun');
  await page.waitForTimeout(900);
  await snap('2-shotgun');
  await g('__game.player.forceFire = 1');
  await page.waitForTimeout(45);
  await snap('3-shotgun-fire');
  await page.waitForTimeout(400);
  await snap('3b-shotgun-pump');
}

// rocket: in hand, in flight, the blast
const blastNow = () => g(`__game.fx.blasts.some((b) => b.alive && b.t < 0.12)`);
if (want('rocket')) {
  await put(18, 1.2, -30, 0, -0.02);
  await hold('rocket');
  await page.waitForTimeout(900);
  await snap('4-rocket');
  await g('__game.player.forceFire = 1');
  await page.waitForTimeout(220);
  await snap('5-rocket-flight');
  await page.waitForTimeout(500);
  await snap('5b-rocket-trail');
  // the next one into the road ahead (as soon as it is reloaded)
  await page.waitForTimeout(1500);
  await g(`__game.look(0, -0.22)`);
  for (let i = 0; i < 100 && !(await g(`__game.weapons.reloadT === 0 && __game.weapons.ammo.rocket > 0`)); i++) await page.waitForTimeout(30);
  await g('__game.player.forceFire = 1');
  for (let i = 0; i < 150 && !(await blastNow()); i++) await page.waitForTimeout(15);
  await god();
  await snap('6-rocket-blast');
  await page.waitForTimeout(450);
  await god();
  await snap('6b-rocket-smoke');
}

// hook: in hand, thrown at the hall wall, pulling
const hookState = () => g(`JSON.stringify(__game.sim.hook && { phase: __game.sim.hook.phase, dist: __game.sim.hook.dist })`);
if (want('hook')) {
  await put(18, 1.2, -30, Math.PI / 2 + 0.75, 0.2);
  await hold('hook');
  await page.waitForTimeout(900);
  await snap('7-hook');
  await g(`(() => { const G = __game; if (G.sim.throwHook(G.camera.position, G.camera.getWorldDirection(G.camera.position.clone()), G.combat.notCharacter)) G.hands.onHook(true); })()`);
  await page.waitForTimeout(70);
  console.log('hook', await hookState());
  await snap('8-hook-fly');
  for (let i = 0; i < 40 && !(await g(`__game.sim.hook?.phase === 'pull' && __game.sim.hook.t > 0.25`)); i++) await page.waitForTimeout(15);
  console.log('hook', await hookState());
  await snap('9-hook-pull');
  await page.waitForTimeout(1500);
}

// kick a crate on the home face
if (want('kick')) {
  const ok = await g(`(() => {
    const G = __game, P = G.props, V = G.sim.state.pos.constructor;
    let best = -1;
    for (let i = 0; i < G.map.crates.length; i++) {
      const c = G.map.crates[i];
      if (c.pos[1] > -125 || Math.abs(c.pos[0]) > 85 || Math.abs(c.pos[2]) > 85) continue;
      if (Math.max(...c.half) > 0.7) continue;
      // room in front of it: a clear ray 6 m across it
      const p = new V(...c.pos);
      const free = [[1,0],[0,1],[-1,0],[0,-1]].find(([x, z]) => !G.combat.rayWorld(p.clone().add(new V(x * 0.9, 0.3, z * 0.9)), p.clone().add(new V(x * 6, 0.3, z * 6)))
        && !G.combat.rayWorld(p.clone().add(new V(-x * 0.9, 0.3, -z * 0.9)), p.clone().add(new V(-x * 2.5, 0.3, -z * 2.5))));
      if (free) { best = i; window.__kd = free; break; }
    }
    if (best < 0) return false;
    window.__crate = best;
    const c = G.map.crates[best], [x, z] = window.__kd;
    G.sim.setGravity(new V(0, -1, 0)); G.sim.state.frame.identity();
    G.sim.state.pos.set(c.pos[0] - x * 1.5, -138 + 0.15 + 0.92, c.pos[2] - z * 1.5); G.sim.state.vel.set(0, 0, 0);
    G.sim.mover.place(G.sim.state); G.local.snap();
    G.look(Math.atan2(-x, -z), -0.35);
    return true;
  })()`);
  if (ok) {
    await hold(null);
    await page.waitForTimeout(800);
    await snap('10-crate');
    await page.keyboard.press('KeyV');
    await page.waitForTimeout(110);
    await snap('11-kick');
    await page.waitForTimeout(500);
    await snap('12-kicked');
  } else console.log('no crate found');
}

// the enemy crystal from close up: prompt + HP bar, shooting it
if (want('crystal')) {
  await g(`(() => {
    const G = __game, V = G.sim.state.pos.constructor, Q = G.camera.quaternion.constructor;
    const bed = G.match.bed('blue'), up = bed.up.clone();
    for (const b of [...G.blocks.blocks.values()]) if (b.team === 'blue') G.blocks.damageCollider(b.collider.handle, b.hp);
    const fq = new Q().setFromUnitVectors(new V(0, 1, 0), up);
    const side = new V(1, 0, 0).applyQuaternion(fq);
    G.sim.setGravity(up.clone().negate());
    G.sim.state.frame.copy(fq);
    G.sim.state.pos.copy(bed.pos).addScaledVector(up, -4 + 0.92 + 0.1).addScaledVector(side, 3.2);
    G.sim.state.vel.set(0, 0, 0); G.sim.mover.place(G.sim.state); G.local.snap();
    const d = bed.pos.clone().sub(G.sim.state.pos).applyQuaternion(fq.clone().invert());
    G.look(Math.atan2(-d.x, -d.z), Math.atan2(d.y - 0.71, Math.hypot(d.x, d.z)));
    for (const b of G.bots.bots) if (b.team === 'blue') { b.target.hp = 0; b.target.alive = false; b.out = true; }
  })()`);
  await hold('rifle').catch(() => {});
  await g(`(() => { const ws = __game.weapons; ws.owned.rifle = true; ws.ammo.rifle = 30; ws.reserve.rifle = 90; })()`);
  await g(`(() => { const H = __game.hands; H.eco.blocks; })()`);
  await page.waitForTimeout(400);
  await hold('rifle');
  await page.waitForTimeout(900);
  await snap('13-crystal');
  await g('__game.player.forceFire = 40');
  await page.waitForTimeout(500);
  await god();
  await snap('14-crystal-hit');
  await page.waitForTimeout(500);
}

// a bot killed in front of you bursts into blood
if (want('blood')) {
  await g(`(() => {
    const G = __game, b = G.bots.bots.find((b) => b.team === 'green' && b.target.alive && !b.out) ?? G.bots.bots.find((b) => b.target.alive && !b.out);
    window.__bot = b;
    const up = b.target.up.clone();
    G.sim.setGravity(up.clone().negate());
    G.sim.state.frame.copy(b.sim.state.frame);
    const side = new b.sim.state.pos.constructor(1, 0, 0).applyQuaternion(b.sim.state.frame);
    G.sim.state.pos.copy(b.sim.state.pos).addScaledVector(side, 4.5);
    G.sim.state.vel.set(0, 0, 0); G.sim.mover.place(G.sim.state); G.local.snap();
    const d = b.sim.state.pos.clone().sub(G.sim.state.pos).applyQuaternion(G.sim.state.frame.clone().invert());
    G.look(Math.atan2(-d.x, -d.z), -0.1);
  })()`);
  await hold('shotgun');
  await page.waitForTimeout(700);
  await god();
  await g(`(() => { const t = __bot.target; __game.combat.damage(t, 999, 0, false, t.center.clone(), { raw: true, weapon: 'shotgun' }); })()`);
  await page.waitForTimeout(90);
  await snap('15-blood');
  await page.waitForTimeout(500);
  await snap('16-blood-after');
}

// the death screen: killed by a bot a few metres away
if (want('death')) {
  await g(`(() => {
    const G = __game, b = G.bots.bots.find((b) => b.target.alive && !b.out && b.team !== 'red');
    window.__bot = b;
    G.sim.setGravity(b.target.up.clone().negate());
    G.sim.state.frame.copy(b.sim.state.frame);
    const side = new b.sim.state.pos.constructor(1, 0, 0).applyQuaternion(b.sim.state.frame);
    G.sim.state.pos.copy(b.sim.state.pos).addScaledVector(side, 6);
    G.sim.state.vel.set(0, 0, 0); G.sim.mover.place(G.sim.state); G.local.snap();
    const d = b.sim.state.pos.clone().sub(G.sim.state.pos).applyQuaternion(G.sim.state.frame.clone().invert());
    G.look(Math.atan2(-d.x, -d.z), -0.05);
  })()`);
  await page.waitForTimeout(600);
  await g(`(() => { const G = __game, me = G.combat.targets.find((t) => t.id === 0); me.guard = null; G.combat.damage(me, 999, __bot.id, true, me.center.clone(), { raw: true, weapon: 'shotgun' }); })()`);
  await page.waitForTimeout(250);
  await snap('17-death-0');
  await page.waitForTimeout(1300);
  await snap('18-death-1');
  await page.waitForTimeout(1300);
  await snap('19-death-2');
  await page.waitForTimeout(1600);
  await snap('20-respawned');
}
console.log('errors', errors.slice(0, 10));
await browser.close();
