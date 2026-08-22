import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const here = new URL('.', import.meta.url).pathname;
export default defineConfig({ root: here, base: './', plugins: [react()],
  build: { outDir: '../.verify-dist', emptyOutDir: true } });
