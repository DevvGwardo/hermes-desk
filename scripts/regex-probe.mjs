#!/usr/bin/env node
// Finds regex literals in src/ and electron/ whose match time grows
// super-linearly with input length (ReDoS candidates). ESLint's
// detect-unsafe-regex only checks star height; this times each literal
// against pumped inputs instead. Every literal runs in its own child process
// so a catastrophic one is killed at the timeout rather than hanging the run.
//
//   node scripts/regex-probe.mjs [--timeout=4000] [dir-or-file ...]
//
// Advisory: prints one line per finding and exits 0. A finding is a lead, not
// proof; confirm with a benchmark and fix with a differential fuzz.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const self = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(self), '..')
const SKIP_DIR = /(^|\/)(node_modules|__tests__|mascot-lab|grok-orb)(\/|$)/
const SOURCE = /\.(ts|tsx|js|cjs|mjs)$/
const UNITS = [' ', '\n', 'a', '0', 'a ', ' \n', '\t', '-', '.', 'a.', '"', "'", '#', ':', '/', '_', 'A', ', ', '\\', '=']
const SUFFIXES = ['!', '\u0001', '']

/** Regex literals in one source file, with 1-based line numbers. */
export function regexLiterals(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const out = []
  const visit = node => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, source: node.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function sourceFiles(target) {
  const stat = fs.statSync(target)
  if (stat.isFile()) return SOURCE.test(target) ? [target] : []
  const files = []
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const p = path.join(target, entry.name)
    if (entry.isDirectory()) { if (!SKIP_DIR.test(p)) files.push(...sourceFiles(p)) }
    else if (SOURCE.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name)) files.push(p)
  }
  return files
}

/** Worst pumped input for one literal, or null when it scales linearly. */
export function probeRegex(literal, { small = 3000, large = 12000, minMs = 30, ratio = 6 } = {}) {
  const slash = literal.lastIndexOf('/')
  let re
  try { re = new RegExp(literal.slice(1, slash), literal.slice(slash + 1).replace(/[gy]/g, '')) } catch { return null }
  const body = literal.slice(1, slash).replace(/\\[dDwWsSbBnrtv]/g, ' ').replace(/\\(.)/g, '$1')
  const prefixes = ['', ...new Set(body.match(/[^\\^$.|?*+()[\]{}]{1,12}/g) ?? [])].slice(0, 7)
  let worst = null
  for (const prefix of prefixes) for (const unit of UNITS) for (const suffix of SUFFIXES) {
    const time = n => {
      const input = prefix + unit.repeat(n) + suffix
      const started = performance.now()
      re.test(input)
      return performance.now() - started
    }
    const a = time(small)
    let b = time(large)
    // Re-time candidates so a GC pause or a busy core is not a finding.
    if (b > minMs && b > a * ratio) b = Math.min(b, time(large))
    if (b > minMs && b > a * ratio && (!worst || b > worst.ms)) {
      worst = { input: { prefix, unit, suffix }, ms: Math.round(b), smallMs: Math.round(a) }
    }
  }
  return worst
}

/** Probes one literal in a child process; a timeout counts as a finding. */
export function probeInChild(literal, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [self, '--child'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true }) }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.on('close', () => {
      clearTimeout(timer)
      try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
    })
    child.stdin.end(literal)
  })
}

async function main(argv) {
  const timeoutMs = Number(argv.find(a => a.startsWith('--timeout='))?.slice(10) ?? 4000)
  const targets = argv.filter(a => !a.startsWith('--'))
  const files = (targets.length ? targets : ['src', 'electron']).flatMap(t => sourceFiles(path.resolve(root, t)))
  const literals = files.flatMap(f => regexLiterals(path.relative(root, f), fs.readFileSync(f, 'utf8')))
  console.error(`probing ${literals.length} regex literals in ${files.length} files…`)
  const findings = []
  let next = 0
  const worker = async () => {
    while (next < literals.length) {
      const lit = literals[next++]
      const result = await probeInChild(lit.source, timeoutMs)
      if (result) findings.push({ ...lit, ...result })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, os.availableParallelism() - 1) }, worker))
  findings.sort((x, y) => (y.timedOut ? Infinity : y.ms) - (x.timedOut ? Infinity : x.ms))
  for (const f of findings) {
    const cost = f.timedOut ? `timed out after ${timeoutMs} ms` : `${f.smallMs} → ${f.ms} ms`
    const input = f.input ? ` on ${JSON.stringify(f.input.prefix)} + ${JSON.stringify(f.input.unit)}×n + ${JSON.stringify(f.input.suffix)}` : ''
    console.log(`${f.file}:${f.line}  ${f.source.slice(0, 100)}  ${cost}${input}`)
  }
  console.error(`${findings.length} finding(s)`)
}

if (process.argv[2] === '--child') {
  let literal = ''
  process.stdin.on('data', chunk => { literal += chunk })
  process.stdin.on('end', () => { process.stdout.write(JSON.stringify(probeRegex(literal))) })
} else if (process.argv[1] === self) {
  await main(process.argv.slice(2))
}
