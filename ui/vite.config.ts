import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('./', import.meta.url)), build: { outDir: fileURLToPath(new URL('../dist/ui-assets/', import.meta.url)), emptyOutDir: true, target: 'es2022', sourcemap: false } });
