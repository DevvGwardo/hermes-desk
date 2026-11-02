import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Inlines the boot-splash mark (src/assets/boot-mark.svg) into index.html at
 *  the `<!--boot-mark-->` slot, so the splash paints with the HTML instead of
 *  waiting on an image request. main.tsx re-renders this same markup (read
 *  back from the static splash), so the file stays the single source. */
function bootMarkPlugin(): PluginOption {
  const svg = readFileSync(fileURLToPath(new URL('./src/assets/boot-mark.svg', import.meta.url)), 'utf8').trim()
  return {
    name: 'nub-boot-mark',
    transformIndexHtml(html) {
      return html.replace('<!--boot-mark-->', svg)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), bootMarkPlugin()],
  base: './',
  // Only the root index.html is a real entry. Vite's default scan crawls
  // every *.html in the repo — including the Capacitor webview copy at
  // android/app/src/main/assets/public/ and android build intermediates,
  // whose prebuilt bundles import deps (e.g. @emotion/is-prop-valid) that
  // aren't installed here, crashing the dev server before it starts.
  optimizeDeps: {
    entries: ['index.html'],
  },
  build: {
    chunkSizeWarningLimit: 600,
    // CI ships thousands of chunk-size lines otherwise; the warning limit
    // above is the budget that matters.
    reportCompressedSize: false,
    // Don't wrap dynamic imports in the __vitePreload helper. Rollup parks the
    // helper in whichever vendor chunk sorts first (currently mermaid), which
    // makes the ENTRY statically import that chunk — so index.html emits
    // <link rel="modulepreload"> for mermaid + cytoscape and the pairing
    // screen downloads ~3.4MB it never runs. Native Chromium (Electron,
    // Capacitor WebView, browsers) loads module deps on demand; lazy chunks
    // stay truly lazy.
    modulePreload: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vite's __vitePreload helper (module id \0vite/preload-helper.js,
          // NOT under node_modules) gets parked in the first vendor chunk
          // (currently mermaid), making the entry STATICALLY import mermaid →
          // browser downloads it at first paint. Isolate it so the entry's
          // only static edge to it is a ~1KB helper chunk.
          if (id.includes('preload-helper')) return 'preload-helper'
          // HUD now uses Pip. Keep the old engine shared while the remaining
          // app surfaces migrate, rather than folding its ~100KB into App.
          if (id.includes('/src/lib/grok-orb/') || id.includes('/src/lib/blob-fx/')) return 'legacy-mascot'
          if (id.includes('node_modules')) {
            // cytoscape folds into mermaid: one diagram bucket, and the SW
            // SKIP_PRECACHE regex only tracks the surviving names.
            if (id.includes('mermaid') || id.includes('cytoscape')) return 'mermaid'
            if (id.includes('katex')) return 'katex'
            if (id.includes('pdfjs-dist')) return 'pdf'
            // exceljs (xlsx parsing, lazy via sheet.ts) — replaces SheetJS.
            // Match the package dir so nested chunks stay in one bucket.
            if (id.includes('exceljs')) return 'xlsx'
            // DOMPurify-backed sanitizer — lazy via preview/markdown.
            if (id.includes('dompurify')) return 'sanitize'
            if (id.includes('react-markdown') || id.includes('remark-gfm')) return 'markdown'
            // React gets its own vendor chunk. Without it rollup co-locates
            // react/jsx-runtime into the first manual chunk that uses it
            // ('motion'), and every surface (pairing gate, HUD, phone shell)
            // downloads framer-motion before first render.
            if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
            if (id.includes('framer-motion')) return 'motion'
          }
          return undefined
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
