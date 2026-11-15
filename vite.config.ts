import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
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
