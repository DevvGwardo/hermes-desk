import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Independent dev entry. The app's vite.config.ts and package.json are untouched.
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [react()],
  optimizeDeps: { entries: ['mascot-lab.html'] },
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
  build: { rollupOptions: { input: fileURLToPath(new URL('../../mascot-lab.html', import.meta.url)) } },
})
