import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mainRuntimeAssetsPlugin: Plugin = {
  name: 'bundle-main-runtime-assets',
  generateBundle(): void {
    this.emitFile({
      type: 'asset',
      fileName: 'pdf.worker.mjs',
      source: readFileSync(path.resolve('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')),
    });
    this.emitFile({
      type: 'asset',
      fileName: 'licenses/Pretendard-LICENSE.txt',
      source: readFileSync(path.resolve('build/licenses/Pretendard-OFL-1.1.txt')),
    });
  },
};

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin(), mainRuntimeAssetsPlugin] },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: { plugins: [react()] },
});
