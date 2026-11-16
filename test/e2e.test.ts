/* Headless Chromium E2E smoke test: solo launch, 1×1×1 block build, P2P lobby + live match across two isolated tabs. */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium, type BrowserContext, type WebSocketRoute } from 'playwright';

const DIST_DIR = resolve('dist');
if (!existsSync(join(DIST_DIR, 'index.html'))) {
  throw new Error('dist/index.html not found — run `npm run build` before `npm run test:e2e`.');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

let failed = 0;
function check(name: string, ok: boolean, info = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`);
  if (!ok) failed++;
}

function startStaticServer() {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolveServer, reject) => {
    const srv = createServer((req, res) => {
      const reqPath = (req.url ?? '/').split('?')[0];
      const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
      const full = resolve(DIST_DIR, rel);
      if (!full.startsWith(DIST_DIR) || !existsSync(full)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream' });
      res.end(readFileSync(full));
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('Invalid server address'));
      resolveServer({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => new Promise<void>((done) => srv.close(() => done())),
      });
    });
  });
}

/** In-memory PeerServer relay so real Chromium WebRTC connections work offline without external 0.peerjs.com traffic. */
function createPeerRelay() {
  let idSeq = 1;
  const peers = new Map<string, WebSocketRoute>();

  async function install(ctx: BrowserContext) {
    await ctx.route('https://0.peerjs.com/**', async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/id')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/plain',
          headers: { 'access-control-allow-origin': '*' },
          body: `e2epeer${idSeq++}`,
        });
        return;
      }
      await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' });
    });

    await ctx.routeWebSocket(/wss:\/\/0\.peerjs\.com\/peerjs/, (ws) => {
      const u = new URL(ws.url());
      const peerId = u.searchParams.get('id') || '';
      if (!peerId) {
        ws.close();
        return;
      }
      if (peers.has(peerId)) {
        ws.send(JSON.stringify({ type: 'ID-TAKEN', payload: { msg: 'ID is taken' } }));
        ws.close();
        return;
      }
      peers.set(peerId, ws);
      ws.send(JSON.stringify({ type: 'OPEN' }));

      ws.onMessage((raw) => {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type === 'HEARTBEAT') {
          ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
          return;
        }
        const dst = typeof msg.dst === 'string' ? msg.dst : '';
        if (!dst) return;
        const target = peers.get(dst);
        if (!target) {
          ws.send(JSON.stringify({ type: 'PEER-UNAVAILABLE', payload: { msg: `Peer ${dst} unavailable` }, dst: peerId, src: dst }));
          return;
        }
        target.send(JSON.stringify({ ...msg, src: peerId }));
      });

      ws.onClose(() => {
        if (peers.get(peerId) === ws) peers.delete(peerId);
      });
    });
  }

  return { install };
}

function trackErrors(page: Awaited<ReturnType<BrowserContext['newPage']>>, label: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label} console.error: ${m.text()}`);
  });
  return errors;
}

const server = await startStaticServer();
const browser = await chromium.launch({
  args: [
    '--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-dev-shm-usage',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ],
});

try {
  // 1. Solo launch, reused MenuBackdrop, starter wood + 1×1×1 block placement
  {
    const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
    const page = await ctx.newPage();
    const errors = trackErrors(page, 'solo');
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => {
      const btn = document.getElementById('start-game') as HTMLButtonElement | null;
      return !!btn && !btn.disabled;
    }, null, { timeout: 60_000 });
    await page.click('#start-game');
    await page.waitForFunction(() => Boolean((window as unknown as { __game?: { ready?: boolean } }).__game?.ready), null, { timeout: 60_000 });

    const soloState = await page.evaluate(() => {
      const g = (window as unknown as {
        __game: {
          reusedBackdrop: boolean;
          blocks: { inventory: { wood: number }; blocks: Map<number, unknown>; plan: Function; place: Function };
          build: { next: string };
          sim: { state: { pos: unknown; frame: unknown } };
          match: { team: string; bed: Function };
          skipIntro: () => void;
          play: () => void;
        };
      }).__game;
      g.skipIntro();
      g.play();
      const bed = g.match.bed(g.match.team);
      const up = bed.up.clone();
      const floorPt = bed.pos.clone().addScaledVector(up, -2.8);
      const side = new up.constructor(1, 0, 0);
      const eye = floorPt.clone().addScaledVector(up, 1.625).addScaledVector(side, 4.5);
      const dir = floorPt.clone().addScaledVector(side, 2).sub(eye).normalize();
      const plan = g.blocks.plan('block', eye, up, dir, eye, dir);
      const woodBefore = g.blocks.inventory.wood;
      const placeRes = plan ? g.blocks.place(plan, 'wood', g.match.team) : 'null';
      return {
        reusedBackdrop: g.reusedBackdrop,
        woodBefore,
        woodAfter: g.blocks.inventory.wood,
        buildNext: g.build.next,
        placeRes,
        totalBlocks: g.blocks.blocks.size,
      };
    });

    check('solo: client loads without console or page errors', errors.length === 0, errors.join(' | '));
    check('solo: reuses pre-built MenuBackdrop world', soloState.reusedBackdrop === true);
    check('solo: player starts with 16 wood, "block" tool selected, and places 1x1 block',
      soloState.woodBefore === 16 && soloState.woodAfter === 15 && soloState.buildNext === 'block'
      && soloState.placeRes === 'ok' && soloState.totalBlocks > 0, JSON.stringify(soloState));

    await ctx.close();
  }

  // 2. Two-tab P2P flow: create room, join via ?room= link, sync lobby, launch match on both tabs
  {
    const relay = createPeerRelay();
    const hostCtx = await browser.newContext({ viewport: { width: 640, height: 360 } });
    const clientCtx = await browser.newContext({ viewport: { width: 640, height: 360 } });
    await relay.install(hostCtx);
    await relay.install(clientCtx);

    const hostPage = await hostCtx.newPage();
    const clientPage = await clientCtx.newPage();
    const hostErrors = trackErrors(hostPage, 'host');
    const clientErrors = trackErrors(clientPage, 'client');

    await hostPage.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await hostPage.waitForFunction(() => {
      const btn = document.getElementById('start-game') as HTMLButtonElement | null;
      return !!btn && !btn.disabled;
    }, null, { timeout: 60_000 });

    await hostPage.click('#show-multiplayer');
    await hostPage.fill('#net-name-input', 'HostE2E');
    await hostPage.click('#net-create-btn');
    await hostPage.waitForFunction(() => {
      const el = document.getElementById('net-room-code');
      const info = document.getElementById('net-room-info');
      return !!el && !!info && !info.hidden && (el.textContent?.trim().length ?? 0) >= 4;
    }, null, { timeout: 20_000 });
    const roomCode = (await hostPage.textContent('#net-room-code'))?.trim() ?? '';
    check('p2p: host creates room with short code', roomCode.length >= 4, `code=${roomCode}`);

    await clientPage.goto(`${server.url}?room=${encodeURIComponent(roomCode)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try {
      await clientPage.waitForFunction(() => {
        const lobbyHtml = document.getElementById('menu-lobby')?.textContent ?? '';
        const start = document.getElementById('start-game') as HTMLButtonElement | null;
        return lobbyHtml.includes('HostE2E') && !!start && start.disabled && start.textContent?.includes('Ждём хоста');
      }, null, { timeout: 25_000 });
    } catch (err) {
      const diag = await Promise.all([
        hostPage.evaluate(() => ({ status: document.getElementById('net-status')?.textContent, lobby: document.getElementById('menu-lobby')?.textContent?.slice(0, 200) })),
        clientPage.evaluate(() => ({ status: document.getElementById('net-status')?.textContent, start: document.getElementById('start-game')?.textContent, lobby: document.getElementById('menu-lobby')?.textContent?.slice(0, 200) })),
      ]);
      console.error('P2P join diagnostic:', JSON.stringify(diag), 'errors:', [...hostErrors, ...clientErrors]);
      throw err;
    }
    await clientPage.fill('#net-name-input', 'GuestE2E');
    await hostPage.waitForFunction(() => (document.getElementById('menu-lobby')?.textContent ?? '').includes('GuestE2E'),
      null, { timeout: 15_000 });
    check('p2p: client joins via ?room= invite link and syncs lobby seat/name with host', true);

    await hostPage.waitForFunction(() => {
      const btn = document.getElementById('start-game') as HTMLButtonElement | null;
      return !!btn && !btn.disabled;
    }, null, { timeout: 30_000 });
    await hostPage.click('#start-game');

    await Promise.all([
      hostPage.waitForFunction(() => Boolean((window as unknown as { __game?: { ready?: boolean } }).__game?.ready), null, { timeout: 60_000 }),
      clientPage.waitForFunction(() => Boolean((window as unknown as { __game?: { ready?: boolean } }).__game?.ready), null, { timeout: 60_000 }),
    ]);

    type ClientGame = {
      reusedBackdrop: boolean;
      match: { team: string; remoteClientMode: boolean };
      blocks: { inventory: { wood: number }; blocks: Map<number, { team: string | null }> };
    };

    const readMatch = () => {
      const g = (window as unknown as { __game: ClientGame }).__game;
      let redFort = 0, blueFort = 0, greenFort = 0;
      for (const b of g.blocks.blocks.values()) {
        if (b.team === 'red') redFort++;
        else if (b.team === 'blue') blueFort++;
        else if (b.team === 'green') greenFort++;
      }
      return {
        reusedBackdrop: g.reusedBackdrop,
        team: g.match.team,
        remoteClientMode: g.match.remoteClientMode,
        wood: g.blocks.inventory.wood,
        redFort,
        blueFort,
        greenFort,
      };
    };

    const hostMatch = await hostPage.evaluate(readMatch);
    const clientMatch = await clientPage.evaluate(readMatch);

    check('p2p: both host and client enter live match cleanly',
      hostMatch.team === 'red' && !hostMatch.remoteClientMode && clientMatch.team === 'blue' && clientMatch.remoteClientMode
      && hostMatch.wood === 16 && clientMatch.wood === 16,
      `host=${JSON.stringify(hostMatch)} client=${JSON.stringify(clientMatch)}`);
    check('p2p: both host and client reuse cached MenuBackdrop world',
      hostMatch.reusedBackdrop && clientMatch.reusedBackdrop);
    check('p2p: fortifySkipTeams leaves human beds unfortified on both tabs while keeping bot forts',
      hostMatch.redFort === 0 && hostMatch.blueFort === 0 && hostMatch.greenFort >= 12
      && clientMatch.redFort === 0 && clientMatch.blueFort === 0 && clientMatch.greenFort >= 12);
    check('p2p: zero console or page errors on host and client tabs',
      hostErrors.length === 0 && clientErrors.length === 0,
      [...hostErrors, ...clientErrors].join(' | '));

    await hostCtx.close();
    await clientCtx.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(failed ? `\n${failed} E2E check(s) failed` : '\ne2e all good');
process.exit(failed ? 1 : 0);
