// Shared evidence writer for the Hermes Desk blueprint harness.
// One check() per promise a user relies on; the detail holds the measured value.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const BP_OUT = process.env.BP_OUT ? path.resolve(process.env.BP_OUT) : path.join(ROOT, 'blueprint-out')

export function createReport(script) {
  const report = { script, startedAt: new Date().toISOString(), commit: process.env.BP_COMMIT ?? null, checks: [], measures: [], console: [] }
  const dir = (sub) => { const d = path.join(BP_OUT, sub); mkdirSync(d, { recursive: true }); return d }
  return {
    report,
    dir,
    check(name, ok, detail = '') {
      report.checks.push({ name, ok: Boolean(ok), detail: typeof detail === 'string' ? detail : JSON.stringify(detail) })
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
      return Boolean(ok)
    },
    measure(name, value, unit, how) { report.measures.push({ name, value, unit, how }) },
    consoleError(msg) { report.console.push(String(msg)) },
    finish() {
      report.finishedAt = new Date().toISOString()
      const file = path.join(dir('data'), `report-${script}.json`)
      writeFileSync(file, JSON.stringify(report, null, 2))
      const failed = report.checks.filter((c) => !c.ok).length
      console.log(`\n${script}: ${report.checks.length - failed}/${report.checks.length} checks passed → ${file}`)
      process.exitCode = failed ? 1 : 0
      return report
    },
  }
}
