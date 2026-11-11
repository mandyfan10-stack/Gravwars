import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'esnext' },
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
  },
  plugins: [
    {
      name: 'keep-stdin-alive',
      configureServer() {
        // Prevent Vite from exiting when spawned in non-TTY container environments where stdin sends EOF
        process.stdin.removeAllListeners('end');
        setInterval(() => {}, 1 << 30);
      },
    },
  ],
});
