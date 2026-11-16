/**
 * Project file logger & off-thread freeze watchdog:
 * - Captures window errors, unhandled rejections, console.error, WebGL context loss, and slow-frame spikes (>200ms).
 * - Runs a background Web Worker watchdog that detects main-thread freezes (>1.8s without a heartbeat) and flushes
 *   a FREEZE report directly to Vite middleware `POST /__log` -> `game-errors.txt` in the project root.
 * - Maintains an in-memory / localStorage ring buffer so pressing F10 or calling `__downloadGameLog()` downloads
 *   `game-errors.txt` even in static builds without the dev server.
 */

const STORAGE_KEY = 'gravwars-debug-log';
const MAX_LOCAL_LINES = 400;
const SPIKE_WARN_MS = 180;

export interface TelemetrySnapshot {
  stage: string;
  mode: string;
  pos?: string;
  fps?: number;
  projectiles?: number;
  bots?: number;
  npcs?: number;
  propsActive?: boolean;
}

class GameLogger {
  private installed = false;
  private lines: string[] = [];
  private telemetry: TelemetrySnapshot = { stage: 'init', mode: 'menu' };
  private seenStacks = new Map<string, number>();
  private lastSpikeAt = 0;
  private worker: Worker | null = null;
  private lastBeatSent = 0;

  constructor() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) this.lines = saved.split('\n').filter(Boolean).slice(-MAX_LOCAL_LINES);
    } catch { /* ignore storage restrictions */ }
  }

  install() {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;

    this.write('INFO', 'session', `=== GravWars session started (${navigator.userAgent}) ===`);

    window.addEventListener('error', (e) => {
      const stack = e.error instanceof Error ? e.error.stack : `${e.filename}:${e.lineno}:${e.colno}`;
      this.error('window.error', e.message || String(e.error), stack);
    });

    window.addEventListener('unhandledrejection', (e) => {
      const err = e.reason;
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.error('unhandledrejection', msg, stack);
    });

    const origErr = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      origErr(...args);
      const msg = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' ');
      this.write('ERROR', 'console.error', msg);
    };

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F10') {
        e.preventDefault();
        this.download();
      }
    });

    this.startWatchdogWorker();

    (window as unknown as Record<string, unknown>).__downloadGameLog = () => this.download();
    (window as unknown as Record<string, unknown>).__getGameLog = () => this.lines.join('\n');
  }

  attachCanvas(canvas: HTMLCanvasElement) {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.error('webgl', 'webglcontextlost event triggered');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.write('INFO', 'webgl', 'webglcontextrestored');
    });
  }

  setStage(stage: string, extra?: Partial<TelemetrySnapshot>) {
    this.telemetry.stage = stage;
    if (extra) Object.assign(this.telemetry, extra);
  }

  private get hasServerEndpoint() {
    return typeof window !== 'undefined'
      && window.location.protocol.startsWith('http')
      && (!!import.meta.env?.DEV || document.cookie.includes('gravwars_log=1'));
  }

  heartbeat(nowMs = performance.now()) {
    if (!this.worker || nowMs - this.lastBeatSent < 300) return;
    this.lastBeatSent = nowMs;
    this.worker.postMessage({
      type: 'beat',
      snapshot: { ...this.telemetry },
      logUrl: this.hasServerEndpoint ? new URL('/__log', window.location.href).href : '',
    });
  }

  recordFrameTiming(totalMs: number, parts: Record<string, number>) {
    if (totalMs < SPIKE_WARN_MS) return;
    const now = performance.now();
    if (now - this.lastSpikeAt < 1000) return;
    this.lastSpikeAt = now;
    const sorted = Object.entries(parts)
      .filter(([, v]) => v >= 5)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v.toFixed(1)}ms`)
      .join(' ');
    this.write(
      'WARN',
      'frame-spike',
      `${totalMs.toFixed(1)}ms stage=${this.telemetry.stage} mode=${this.telemetry.mode} pos=${this.telemetry.pos ?? '?'} parts=[${sorted}]`,
    );
  }

  info(tag: string, message: string) {
    this.write('INFO', tag, message);
  }

  error(tag: string, err: unknown, explicitStack?: string) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = explicitStack ?? (err instanceof Error ? err.stack : '');
    const sig = `${tag}:${msg}`;
    const count = (this.seenStacks.get(sig) ?? 0) + 1;
    this.seenStacks.set(sig, count);
    if (count > 5 && count % 50 !== 0) return;
    const suffix = count > 1 ? ` (x${count})` : '';
    const detail = stack ? `\n${stack}` : '';
    this.write('ERROR', tag, `${msg}${suffix} [stage=${this.telemetry.stage}, mode=${this.telemetry.mode}, pos=${this.telemetry.pos ?? '?'}]${detail}`);
  }

  private write(level: 'INFO' | 'WARN' | 'ERROR', tag: string, text: string) {
    const line = `[${new Date().toISOString()}] [${level}] [${tag}] ${text}`;
    this.lines.push(line);
    if (this.lines.length > MAX_LOCAL_LINES) this.lines.shift();
    try {
      localStorage.setItem(STORAGE_KEY, this.lines.join('\n'));
    } catch { /* ignore */ }
    this.sendToServer(`${line}\n`);
  }

  private sendToServer(payload: string) {
    if (!this.hasServerEndpoint) return;
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/__log', new Blob([payload], { type: 'text/plain;charset=utf-8' }));
      } else {
        void fetch('/__log', { method: 'POST', body: payload, keepalive: true }).catch(() => {});
      }
    } catch { /* static / file:// host */ }
  }

  download() {
    const content = this.lines.join('\n') + '\n';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'game-errors.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private startWatchdogWorker() {
    if (typeof Worker === 'undefined' || navigator.webdriver) return;
    const code = `
      let lastBeat = Date.now();
      let lastSnapshot = null;
      let logUrl = '';
      let frozenReported = false;
      self.onmessage = (e) => {
        if (e.data && e.data.type === 'beat') {
          lastBeat = Date.now();
          lastSnapshot = e.data.snapshot;
          logUrl = e.data.logUrl || logUrl;
          frozenReported = false;
        }
      };
      setInterval(() => {
        const stalledMs = Date.now() - lastBeat;
        if (stalledMs > 1800 && !frozenReported && lastSnapshot && logUrl) {
          frozenReported = true;
          const line = '[' + new Date().toISOString() + '] [FREEZE] [watchdog] Main thread unresponsive for '
            + stalledMs + 'ms! last=' + JSON.stringify(lastSnapshot) + '\\n';
          try {
            fetch(logUrl, { method: 'POST', body: line }).catch(() => {});
          } catch {}
        }
      }, 600);
    `;
    try {
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);
    } catch { /* CSP / unsupported worker */ }
  }
}

export const gameLog = new GameLogger();
