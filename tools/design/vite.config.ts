import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Isolated, headless design lab. No application entry or configuration changes.
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [react()],
  optimizeDeps: { entries: ['tools/design/mockups.html'] },
  server: { host: '127.0.0.1', port: 5192, strictPort: true },
  build: {
    outDir: 'tools/design/out/site',
    rollupOptions: { input: fileURLToPath(new URL('./mockups.html', import.meta.url)) },
  },
})
