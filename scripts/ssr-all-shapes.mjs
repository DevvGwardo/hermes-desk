// SSR-render every one of the 18 engine shapes to a static SVG preview.
// Eyes are rAF-populated so they render empty in SSR (expected) — the head
// silhouette is the point here. Vars replaced with literals for rsvg/browser.
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vzt, al } from '../src/lib/grok-orb/core.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..', 'docs', 'orb-shapes-ssr')
mkdirSync(outDir, { recursive: true })

const FG = '#b7dbff'
const BG = '#1a3d6b'
const shapes = Object.keys(al)
const svgs = []

for (const shape of shapes) {
  const el = createElement(
    'span',
    { style: { '--fg': FG, '--bg': BG } },
    createElement(vzt, { state: 'idle', shape, size: 240 }),
  )
  let html = renderToString(el)
  html = html.replace('var(--fg)', FG).replaceAll('var(--bg)', BG)
  writeFileSync(join(outDir, `${shape}.svg`), html)
  svgs.push({ shape, html })
  console.log(`rendered ${shape}`)
}

// Contact sheet: grid of all shapes with labels
const COLS = 6
const CELL = 260
const LABEL = 28
const PAD = 20
const rows = Math.ceil(shapes.length / COLS)
const W = COLS * CELL + PAD * 2
const H = rows * (CELL + LABEL) + PAD * 2

let sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#14161a"/>
<g font-family="Menlo, monospace" font-size="16" fill="#e8e4da">`
shapes.forEach(({ shape }, i) => {
  const col = i % COLS
  const row = Math.floor(i / COLS)
  const x = PAD + col * CELL
  const y = PAD + row * (CELL + LABEL)
  // pull the <svg> out of the wrapper span and position it
  const inner = svgs[i].html.match(/<svg[\s\S]*?<\/svg>/)[0]
    .replace('<svg ', `<svg x="${x}" y="${y}" `)
    .replace(/width="240"/, `width="${CELL}"`)
    .replace(/height="240"/, `height="${CELL}"`)
  sheet += inner
  sheet += `<text x="${x + CELL / 2}" y="${y + CELL + 18}" text-anchor="middle">${shape}</text>`
})
sheet += '</g></svg>'
writeFileSync(join(outDir, 'all-shapes.svg'), sheet)
console.log('sheet written', join(outDir, 'all-shapes.svg'))
