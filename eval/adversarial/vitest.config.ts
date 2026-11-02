import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Adversarial-input suite. Mirrors the root vitest.config.ts (jsdom +
// react/tailwind plugins, explicit globals off) so app modules under src/
// load exactly as they do in root-suite tests. Rooted at the repo so the
// relative imports below resolve; include is restricted to this directory.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    // Root suite declares no setupFiles — none to mirror.
    include: ['eval/adversarial/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
    clearMocks: true,
  },
})
