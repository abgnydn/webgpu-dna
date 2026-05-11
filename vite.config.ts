import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        splat: resolve(__dirname, 'splat.html'),
        see: resolve(__dirname, 'see.html'),
        bench: resolve(__dirname, 'bench.html'),
        benchChem: resolve(__dirname, 'bench-chem.html'),
      },
    },
  },
  assetsInclude: ['**/*.wgsl'],
  server: {
    port: 8765,
    host: '127.0.0.1',
  },
});
