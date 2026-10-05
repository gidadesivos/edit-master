import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * Ships MediaPipe's WebAssembly runtime with the app (served in dev, emitted in builds) so
 * background removal works fully offline. Only the SIMD build is needed (all current browsers).
 */
function mediapipeWasm(): Plugin {
  const dir = new URL('./node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url);
  const files = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];
  return {
    name: 'mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0].replace(/^.*\/mediapipe\//, '');
        if (!req.url?.includes('/mediapipe/') || !name || !files.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(new URL(name, dir)));
      });
    },
    generateBundle() {
      for (const name of files) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/${name}`, source: readFileSync(new URL(name, dir)) });
      }
    },
  };
}

// `base: './'` makes the same build work on GitHub Pages (/edit-master/) and inside Tauri.
export default defineConfig({
  base: './',
  plugins: [react(), mediapipeWasm()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
