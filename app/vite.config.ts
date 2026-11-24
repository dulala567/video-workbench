import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5199, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
  // 界面右下角的版本号，打包时从 package.json 读
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
});
