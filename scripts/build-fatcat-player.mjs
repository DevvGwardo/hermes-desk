// Self-contained browser IIFE for FatCatIcon + React + ReactDOM.
// Output assigns to window.FatCatBundle = { FatCatIcon, React, ReactDOM }.
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = resolve(root, 'dist/fatcat-player.js')

// esbuild IIFE with globalName produces `var FatCatBundle = (() => { ... })()`
// which attaches to the script's global scope. To be belt-and-suspenders in
// every host (including strict-mode sandboxes), we ALSO append an explicit
// window.FatCatBundle = FatCatBundle shim.
await build({
  entryPoints: [resolve(root, 'src/_fatcat-player-entry.tsx')],
  bundle: true,
  format: 'iife',
  globalName: 'FatCatBundle',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  loader: { '.tsx': 'tsx', '.ts': 'ts', '.js': 'js' },
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: out,
  logLevel: 'info',
  resolveExtensions: ['.tsx', '.ts', '.js', '.jsx'],
})

let js = readFileSync(out, 'utf8')
// Append the explicit window assignment after the IIFE closes
const shim = `
;(function(){
  try { window.FatCatBundle = FatCatBundle; } catch (e) {}
  try { self.FatCatBundle = FatCatBundle; } catch (e) {}
  try { globalThis.FatCatBundle = FatCatBundle; } catch (e) {}
})();
`
writeFileSync(out, js + shim)
console.log('built dist/fatcat-player.js (react inlined, window shim appended)')
