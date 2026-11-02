#!/usr/bin/env node
/** Nightly prod-readiness evals: run tiers sequentially, rewrite gates/prod-evals.md. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'eval/out')
const GATES_FILE = path.join(ROOT, 'gates/prod-evals.md')
const TAIL_LINES = 40

// file = entrypoint whose absence means SKIPPED (tiers land concurrently)
const TIERS = [
  {
    id: 'electron',
    file: 'eval/run-electron-smokes.mjs',
    cmd: 'node',
    args: ['eval/run-electron-smokes.mjs'],
    gate: 'G1',
    proves: 'packaged/dev app boots + core flows, zero pageerrors',
  },
  {
    id: 'chat',
    file: 'eval/run-chat-invariants.mjs',
    cmd: 'node',
    args: ['eval/run-chat-invariants.mjs'],
    gate: 'G2',
    proves: 'golden SSE replay corpus asserts single-bubble/no-reprint invariants',
  },
  {
    id: 'adversarial',
    file: 'eval/adversarial/vitest.config.ts',
    cmd: 'npx',
    args: ['vitest', 'run', '--config', 'eval/adversarial/vitest.config.ts'],
    gate: 'G3',
    proves: 'malformed SSE / XSS / store-flood suite holds up',
  },
]
const TIER_BY_ID = Object.fromEntries(TIERS.map((t) => [t.id, t]))

const USAGE = `usage: node scripts/eval-nightly.mjs [--tier=electron|chat|adversarial]... [--dry-run] [--strict]
  --tier=<id>     run a subset; repeatable and/or comma-separated (default: all three)
  --dry-run       print the plan, execute nothing
  --strict        count skipped tiers as failures
Exit codes: 0 = every executed tier passed (skips allowed), 1 = failure or strict skip, 2 = usage error`

function usageError(msg) {
  console.error(`eval-nightly: ${msg}\n${USAGE}`)
  process.exit(2)
}

function parseArgs(argv) {
  const selected = []
  let dryRun = false
  let strict = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--strict') strict = true
    else if (arg === '--tier' || arg.startsWith('--tier=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]
      if (!value) usageError('--tier needs a value')
      for (const raw of value.split(',')) {
        const id = raw.trim()
        if (!TIER_BY_ID[id]) usageError(`unknown tier "${id}" (known: ${TIERS.map((t) => t.id).join(', ')})`)
        if (!selected.includes(id)) selected.push(id)
      }
    } else if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else usageError(`unknown argument "${arg}"`)
  }
  return { selected: selected.length ? selected : TIERS.map((t) => t.id), dryRun, strict }
}

// Run one tier with live passthrough while keeping the last TAIL_LINES lines.
function runTier(tier) {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(tier.cmd, tier.args, { cwd: ROOT, env: process.env })
    const tail = []
    const collect = (stream, sink) => {
      stream.setEncoding('utf8')
      let buf = ''
      stream.on('data', (chunk) => {
        sink.write(chunk)
        buf += chunk.replace(/\r/g, '\n')
        let nl
        while ((nl = buf.indexOf('\n')) !== -1) {
          tail.push(buf.slice(0, nl).trim())
          buf = buf.slice(nl + 1)
        }
        if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES)
      })
      stream.on('end', () => {
        if (buf.trim()) tail.push(buf.trim())
      })
    }
    collect(child.stdout, process.stdout)
    collect(child.stderr, process.stderr)
    child.on('error', (err) => {
      process.stderr.write(`${err.message}\n`)
      tail.push(err.message)
      resolve({ exit: 127, tail })
    })
    child.on('close', (code) => resolve({ exit: code ?? 1, tail }))
  }).then(({ exit, tail }) => ({
    status: exit === 0 ? 'PASS' : 'FAIL',
    exit,
    seconds: ((Date.now() - startedAt) / 1000).toFixed(1),
    // single-line evidence material only
    tailLine: tail.filter(Boolean).join(' | ').replace(/\s+/g, ' ').trim(),
  }))
}

function planLine(tier, selectedIds) {
  const missing = existsSync(path.join(ROOT, tier.file)) ? '' : 'entrypoint MISSING -> will SKIP'
  const scope = selectedIds.length === TIERS.length ? '' : '(subset)'
  return [tier.id.padEnd(12), `${tier.cmd} ${tier.args.join(' ')}`, scope, missing].filter(Boolean).join('  ')
}

async function main() {
  const { selected, dryRun, strict } = parseArgs(process.argv.slice(2))
  const startedAtIso = new Date().toISOString()

  if (dryRun) {
    console.log('eval-nightly: DRY RUN — nothing will be executed')
    for (const id of selected) console.log(`  ${planLine(TIER_BY_ID[id], selected)}`)
    console.log('  post-run: write eval/out/ artifacts, rewrite gates/prod-evals.md')
    process.exit(0)
  }

  mkdirSync(OUT_DIR, { recursive: true })

  const results = {}
  for (const id of selected) {
    const tier = TIER_BY_ID[id]
    if (!existsSync(path.join(ROOT, tier.file))) {
      results[id] = {
        command: `${tier.cmd} ${tier.args.join(' ')}`,
        status: 'SKIPPED',
        reason: `missing entrypoint ${tier.file} (tier not built yet)`,
      }
      console.log(`>> ${id}: exit=skipped SKIPPED (${results[id].reason})`)
      continue
    }
    console.log(`\n== eval tier: ${id} == (${tier.proves})`)
    const run = await runTier(tier)
    results[id] = { command: `${tier.cmd} ${tier.args.join(' ')}`, ...run }
    console.log(`>> ${id}: exit=${run.exit} ${run.status} (${run.seconds}s)\n`)
  }

  const artifactFiles = [
    `nightly-${startedAtIso.replace(/[:.]/g, '-')}.json`,
    'nightly-latest.json',
  ]
  const summary = {
    startedAt: startedAtIso,
    finishedAt: new Date().toISOString(),
    argv: process.argv.slice(2),
    strict,
    results,
  }
  for (const name of artifactFiles) {
    writeFileSync(path.join(OUT_DIR, name), JSON.stringify(summary, null, 2) + '\n')
  }

  rewriteGates(results)

  const executed = Object.values(results).filter((r) => r.status !== 'SKIPPED')
  const passed = executed.filter((r) => r.status === 'PASS').length
  const failed = executed.length - passed
  const skips = Object.entries(results).filter(([, r]) => r.status === 'SKIPPED')

  if (skips.length) {
    console.log(`!! WARNING: ${skips.length} tier(s) SKIPPED — these are NOT verified:`)
    for (const [id, r] of skips) console.log(`!!   - ${id}: ${r.reason}`)
    console.log('!! a skip is not a pass; run again once the missing tier lands (or use --strict to fail on skips)')
  }

  const okRuns = failed === 0 && (!strict || skips.length === 0)
  console.log(
    `eval-nightly: ${okRuns ? 'PASS' : 'FAIL'} (executed=${executed.length} passed=${passed}` +
      ` failed=${failed} skipped=${skips.length})`,
  )
  console.log(`gates updated: ${path.relative(ROOT, GATES_FILE)} | artifacts: eval/out/{${artifactFiles.join(',')}}`)
  process.exit(okRuns ? 0 : 1)
}

// Keep static definitions; flip each checkbox per result and replace its EVIDENCE line.
// Checkbox state comes from the tier verdict, never parsed back out of the evidence string:
// only an executed exit=0 counts as met — skips and failures stay unchecked.
function rewriteGates(results) {
  let text
  try {
    text = readFileSync(GATES_FILE, 'utf8')
  } catch (err) {
    console.error(`eval-nightly: cannot update gates (${err.message})`)
    return
  }
  const gateRe = /^- \[([ xX])\] (G\d):/
  let current = null
  const lines = text.split('\n').map((line) => {
    const gateMatch = line.match(gateRe)
    if (gateMatch) {
      current = gateMatch[2]
      const state = stateFor(current, results)
      if (!state) return line // gate not part of this invocation — leave prior truth alone
      return line.replace(/^- \[[ xX]\]/, `- [${state.checked ? 'x' : ' '}]`)
    }
    if (current && /^(\s*)EVIDENCE:/.test(line)) {
      const state = stateFor(current, results)
      if (!state) return line
      return `${line.match(/^\s*/)[0]}EVIDENCE: ${state.text}`
    }
    return line
  })
  writeFileSync(GATES_FILE, lines.join('\n'))
}

function stateFor(gateId, results) {
  if (gateId === 'G4') {
    const count = listOutFiles().length
    return {
      checked: count > 0,
      text: count
        ? `${count} artifact file(s) in eval/out at ${new Date().toISOString()}`
        : 'no artifacts in eval/out',
    }
  }
  const tier = TIERS.find((t) => t.gate === gateId)
  const result = results?.[tier.id]
  if (!result) return null
  if (result.status === 'SKIPPED') {
    return { checked: false, text: `${tier.id}: exit=skipped SKIPPED (${result.reason})` }
  }
  const tail = result.tailLine.slice(0, 160)
  return {
    checked: result.exit === 0,
    text: `${tier.id}: exit=${result.exit} ${result.status} in ${result.seconds}s${tail ? ` — tail: ${tail}` : ''}`,
  }
}

function listOutFiles() {
  try {
    return readdirSync(OUT_DIR).filter((f) => !f.startsWith('.'))
  } catch {
    return []
  }
}

main()
