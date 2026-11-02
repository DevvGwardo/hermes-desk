/** Generate src/lib/creature-mark/eyes-y3.ts from docs/grok-Y3-full.json */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const src = path.join(root, 'docs', 'grok-Y3-full.json')
const dest = path.join(root, 'src', 'lib', 'creature-mark', 'eyes-y3.ts')

const Y3 = JSON.parse(fs.readFileSync(src, 'utf8'))
if (!Array.isArray(Y3) || Y3.length !== 25) {
  throw new Error(`Expected 25 poses, got ${Array.isArray(Y3) ? Y3.length : typeof Y3}`)
}

function fmtPt([x, y]) {
  return `[${Number(x)}, ${Number(y)}]`
}

function fmtEye(eye) {
  const lines = []
  for (let i = 0; i < eye.length; i += 4) {
    const chunk = eye.slice(i, i + 4).map(fmtPt).join(', ')
    lines.push(`      ${chunk},`)
  }
  return `[\n${lines.join('\n')}\n    ]`
}

function fmtPose(pose, idx) {
  return `  // pose ${idx}\n  [\n    ${fmtEye(pose[0])},\n    ${fmtEye(pose[1])},\n  ]`
}

const body = Y3.map(fmtPose).join(',\n')

const out = `/**
 * Y3 — 25 eye outline pose templates (2 eyes × 48 points each).
 * Generated from docs/grok-Y3-full.json — do not hand-edit; re-run:
 *   node scripts/gen-y3-ts.mjs
 */
export const Y3: number[][][][] = [
${body},
]

/** Pose 0 convenience alias (idle open eyes). */
export const Y3_0: number[][][] = Y3[0]!

export function getY3Pose(index: number): number[][][] {
  const i = ((index % Y3.length) + Y3.length) % Y3.length
  return Y3[i]!
}

export function lerpEyePolylines(
  a: number[][][],
  b: number[][][],
  t: number,
): number[][][] {
  const lerpPt = (p: number[], q: number[]): number[] => [
    p[0]! + (q[0]! - p[0]!) * t,
    p[1]! + (q[1]! - p[1]!) * t,
  ]
  return [
    a[0]!.map((p, i) => lerpPt(p, b[0]![i]!)),
    a[1]!.map((p, i) => lerpPt(p, b[1]![i]!)),
  ]
}
`

fs.writeFileSync(dest, out)
console.log('wrote', dest, 'poses', Y3.length)
