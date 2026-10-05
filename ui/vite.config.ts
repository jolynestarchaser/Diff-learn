import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ root: fileURLToPath(new URL('./', import.meta.url)), plugins: [tailwindcss()], resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } }, build: { outDir: fileURLToPath(new URL('../dist/ui-assets/', import.meta.url)), emptyOutDir: true, target: 'es2022', sourcemap: false } });
