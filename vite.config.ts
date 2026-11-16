import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';

const LOG_FILE = path.resolve(process.cwd(), 'game-errors.txt');

type ConnectHandler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
type MiddlewareStack = {
  use: ((fn: ConnectHandler) => void) & ((route: string, fn: ConnectHandler) => void);
};

function attachLogMiddleware(middlewares: MiddlewareStack) {
  middlewares.use((req, res, next) => {
    const reqPath = (req.url ?? '/').split('?')[0];
    if (reqPath === '/' || reqPath === '/index.html') {
      res.setHeader('Set-Cookie', 'gravwars_log=1; Path=/; SameSite=Lax');
    }
    next();
  });
  middlewares.use('/__log', (req, res, next) => {
    if (req.method !== 'POST') {
      if (req.method === 'GET') {
        const body = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(body);
        return;
      }
      next();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text) fs.appendFileSync(LOG_FILE, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
      } catch { /* ignore disk errors */ }
      res.statusCode = 204;
      res.end();
    });
  });
}

function gameLogPlugin(): Plugin {
  return {
    name: 'gravwars-file-logger',
    configureServer(server) { attachLogMiddleware(server.middlewares); },
    configurePreviewServer(server) { attachLogMiddleware(server.middlewares); },
  };
}

export default defineConfig({
  base: './',
  plugins: [gameLogPlugin()],
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-three', test: /[\\/]node_modules[\\/]three[\\/]/ },
            { name: 'vendor-rapier', test: /[\\/]node_modules[\\/]@dimforge[\\/]rapier3d-compat[\\/]/ },
            { name: 'vendor-net', test: /[\\/]node_modules[\\/]peerjs[\\/]/ },
            { name: 'vendor-ui', test: /[\\/]node_modules[\\/]lil-gui[\\/]/ },
          ],
        },
      },
    },
  },
  server: { host: true },
});
