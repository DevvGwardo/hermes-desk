#!/usr/bin/env node
/**
 * Chat invariants eval — drives the REAL Nub Agent UI (vite dev server, web shell)
 * against a mock Hermes-deploy backend speaking the production wire:
 *
 *   POST /api/chat                          -> SSE stream (X-Hermes-Turn-Id / X-Hermes-Session-Id)
 *   GET  /api/chat/runs/:turnId/events      -> SSE reattach honoring Last-Event-Id
 *
 * The app is pointed at the mock by injecting a valid paired-session into
 * localStorage (`nub:mobile-session`) BEFORE page load, which makes
 * HermesDeployTransport win transport selection even in dev — the real
 * transport, parser, store coalescing and hydration all run unmodified.
 *
 * Invariants:
 *   INV1 (f1) golden path        -> exactly ONE assistant bubble, exact final text,
 *                                   no duplicate after hydrate settles, NO /events reattach
 *                                   after a clean [DONE] close, bubble rebound to turn_* id.
 *   INV2 (f2) reconnect          -> POST dropped mid-token; client must reattach with
 *                                   Last-Event-Id, append (never reprint): full text exactly once,
 *                                   at most one assistant bubble total.
 *   INV3 (f3) tool events        -> hermes.tool.progress renders live activity, stream completes
 *                                   past a malformed trailing frame, still exactly one bubble.
 *   INV4 (f4) multi-turn         -> two turns = two single bubbles; reply pill and reaction pill
 *                                   render without breaking either bubble's text.
 *   INV5 (f5) slow trickle       -> twelve 90ms deltas survive rAF coalescing; golden-path asserts.
 *
 * Usage:
 *   node eval/run-chat-invariants.mjs                 # all five
 *   node eval/run-chat-invariants.mjs --fixture=f2    # just one (f1..f5)
 *   BASE=http://127.0.0.1:5198 node eval/run-chat-invariants.mjs   # reuse a running server
 *
 * Artifacts (end-state screenshots, failure console logs) land in eval/out/chat/.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

import {
  createMockAgentServer,
  loadFixture,
  sseFramesForTurn,
  fullTextForTurn,
  maxEventId,
} from './lib/mock-agent-server.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') // eval/ -> repo root
const OUT_DIR = path.join(ROOT, 'eval/out/chat')
const PORT = Number(process.env.PORT || 5198)

const PAIRED_SESSION = { host: '', instanceId: 'inst-eval-b', desktopToken: 'tok-eval-b' }
const PROMPT_1 = 'Give me answer one'
const PROMPT_REPLY = 'Follow up on the quoted line'

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

function parseArgs(argv) {
  let fixture = null
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--fixture=')) fixture = a.slice('--fixture='.length)
    else if (a === '--fixture') fixture = argv[++i]
  }
  return { fixture }
}

async function httpUp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(url, { redirect: 'manual' })
      return true
    } catch {
      await sleep(500)
    }
  }
  return false
}

/** Resolve a Chromium-for-Testing binary from the local ms-playwright cache. */
function chromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const cacheRoot = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  if (existsSync(cacheRoot)) {
    const dirs = readdirSync(cacheRoot)
      .filter((d) => d.startsWith('chromium-'))
      .sort((a, b) => Number(b.split('-')[1] || 0) - Number(a.split('-')[1] || 0))
    for (const d of dirs) {
      for (const layout of ['chrome-mac-arm64', 'chrome-mac']) {
        const p = path.join(
          cacheRoot,
          d,
          layout,
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        )
        if (existsSync(p)) return p
      }
    }
  }
  throw new Error(
    'no Chrome for Testing found under ~/Library/Caches/ms-playwright — set CHROME_PATH or run the workbench capture once',
  )
}

async function ensureBaseServer() {
  if (process.env.BASE) {
    const base = process.env.BASE.replace(/\/+$/, '')
    if (!(await httpUp(base, 10000))) throw new Error(`BASE=${base} is not reachable`)
    console.log(`[base ] reusing BASE ${base}`)
    return { base, vitePid: null }
  }
  const base = `http://127.0.0.1:${PORT}`
  if (await httpUp(base, 1500)) {
    console.log(`[base ] reusing already-running dev server at ${base}`)
    return { base, vitePid: null }
  }
  console.log(`[base ] spawning vite on ${PORT}...`)
  // Launch vite's bin directly with our own node — npx resolution is flaky in
  // non-interactive shells, and vite.js only needs a node interpreter.
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteBin)) throw new Error(`vite binary not found at ${viteBin} (run npm install)`)
  const viteLog = path.join(OUT_DIR, 'vite-dev.log')
  const logFd = openSync(viteLog, 'w')
  const child = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  child.on('error', (e) => console.error(`[base ] vite spawn error: ${e.message}`))
  child.on('exit', (code, sig) => console.error(`[base ] vite exited (code=${code} sig=${sig}) see ${viteLog}`))
  const up = await httpUp(base, 120000)
  if (!up) {
    killGroup(child.pid)
    throw new Error(`vite did not come up on ${base} within 120s`)
  }
  console.log(`[base ] vite up at ${base} (pid ${child.pid})`)
  return { base, vitePid: child.pid }
}

function killGroup(pid) {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-pid, 0)
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }, 2500).unref?.()
}

// ------------------------------------------------------------- results book

const results = []
function record(inv, pass, msg, detail) {
  results.push({ inv, pass, msg, detail })
  console.log(`  ${pass ? '✓' : '✗ FAIL'} ${msg}${pass ? '' : detail ? ` :: ${JSON.stringify(detail)}` : ''}`)
  return pass
}

// ------------------------------------------------------------ page helpers

async function dismissOverlays(page) {
  const re = /^(Skip for now|Not now|Maybe later|Later|Got it|Dismiss)/i
  for (let i = 0; i < 6; i++) {
    const btn = page.getByRole('button', { name: re }).first()
    if (!(await btn.isVisible().catch(() => false))) break
    await btn.click({ timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(350)
  }
}

/** Open a fresh chat with the Nub stub agent via '+ New' -> roster picker.
 *  Commit through the palette's keyboard path (fill + Enter): row buttons sit
 *  under the popover footer strip, so pointer clicks get intercepted. */
async function openNubChat(page) {
  const newBtn = page.locator('[aria-label="New conversation"]').first()
  await newBtn.waitFor({ state: 'visible', timeout: 30000 })
  await newBtn.click()
  const search = page.getByPlaceholder(/Search or create/)
  try {
    await search.waitFor({ state: 'visible', timeout: 4000 })
    await search.fill('Nub')
    await search.press('Enter')
  } catch {
    /* picker never opened — default thread is fine */
  }
  await page.getByPlaceholder(/Message the agent/).waitFor({ state: 'visible', timeout: 20000 })
  const stillOpen = await search.isVisible().catch(() => false)
  if (stillOpen) await page.keyboard.press('Escape')
}

async function sendMessage(page, text) {
  const box = page.getByPlaceholder(/Message the agent/)
  await box.fill(text)
  const send = page.getByRole('button', { name: 'Send', exact: true })
  await send
    .click({ timeout: 5000 })
    .catch(async () => {
      await box.press('Enter')
    })
}

/**
 * Assistant bubble ids: local placeholder msg_* or rebound turn_* ids.
 * System/user/subagent rows never carry these prefixes.
 */
const allMessageIds = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-message-id]')].map((el) => el.getAttribute('data-message-id')),
  )
const assistantIdsOf = (ids) => [...new Set((ids ?? []).filter((id) => /^(msg_|turn_)/.test(id || '')))]

/** Visible text of one bubble, stripped of interactive chrome (buttons, pills, caret). */
async function bubbleText(page, id) {
  return page.evaluate((mid) => {
    const el = document.querySelector(`[data-message-id="${mid}"]`)
    if (!el) return null
    const clone = el.cloneNode(true)
    clone
      .querySelectorAll('button, [role="button"], .sand-reaction-pill, .sand-reply-quote, .streaming-caret')
      .forEach((n) => n.remove())
    return clone.textContent || ''
  }, id)
}

/** Stream done: an assistant bubble exists, no caret, no live activity line. */
async function waitSettled(page, timeoutMs = 45000) {
  await page.waitForFunction(
    () => {
      const ids = [...document.querySelectorAll('[data-message-id]')].map((e) =>
        e.getAttribute('data-message-id'),
      )
      const hasAssistant = ids.some((i) => /^(msg_|turn_)/.test(i || ''))
      return (
        hasAssistant && !document.querySelector('.streaming-caret') && !document.querySelector('[data-activity]')
      )
    },
    undefined,
    { timeout: timeoutMs },
  )
}

const eventsGets = (mock) =>
  mock.requests.filter((r) => r.method === 'GET' && /\/api\/chat\/runs\/.+\/events$/.test(r.path))
const chatPosts = (mock) => mock.requests.filter((r) => r.method === 'POST' && r.path === '/api/chat')

/** Cumulative SSE byte count through the frame carrying `eventId` (for dropAfterBytes cuts). */
function bytesThroughEvent(fixture, eventId) {
  let bytes = 0
  for (const frame of sseFramesForTurn(fixture.turns[0])) {
    bytes += Buffer.byteLength(frame)
    const m = /^id: (\d+)\n/.exec(frame)
    if (m && Number(m[1]) === eventId) return bytes
  }
  throw new Error(`no frame with id ${eventId}`)
}

// ---------------------------------------------------------------- scenarios

async function assertSingleBubbleExactText(page, mock, fixture, inv, opts = {}) {
  const turn = fixture.turns[0]
  const expected = norm(fullTextForTurn(turn))

  const ids = assistantIdsOf(await allMessageIds(page))
  record(inv, ids.length === 1, `exactly one assistant bubble (got ${ids.length}: ${ids.join(', ') || 'none'})`)

  const got = norm(await bubbleText(page, ids[0]))
  const exact = got === expected
  record(inv, exact, 'final bubble text equals the fixture full text', { expected, got })

  if (!exact && opts.allowToolChipForensics) {
    // Tool chips may legally add label text; verify every token chunk still
    // appears exactly once so duplication vs. legitimate chip text is separable.
    const dupes = []
    for (const e of turn.events) {
      if (typeof e.delta !== 'string' || !e.delta.trim()) continue
      const parts = got.split(norm(e.delta))
      if (parts.length - 1 !== 1) dupes.push({ delta: e.delta, occurrences: parts.length - 1 })
    }
    record(inv, dupes.length === 0, 'forensic: every streamed chunk appears exactly once', { mismatches: dupes })
  }
  return { ids, expected }
}

async function inv1(page, mock, fixture, inv) {
  await sendMessage(page, PROMPT_1)
  await waitSettled(page)
  const { ids, expected } = await assertSingleBubbleExactText(page, mock, fixture, inv)

  record(inv, /^turn_/.test(ids[0]), 'bubble rebound to server turn id (X-Hermes-Turn-Id honored)', { id: ids[0] })
  const post = chatPosts(mock)[0]
  record(inv, !!post && /^Bearer tok-eval-b$/.test(post.authorization ?? ''), 'POST /api/chat carried bearer auth', {
    authorization: post?.authorization,
  })

  const cleanGets = eventsGets(mock)
  record(inv, cleanGets.length === 0, 'clean [DONE] close did NOT hit /events (no reprint reattach)', {
    requests: cleanGets.map((r) => r.url),
  })

  // Let one App poll cycle (15s) + hydration settle, then re-check for late duplicates.
  await page.waitForTimeout(16000)
  const ids2 = assistantIdsOf(await allMessageIds(page))
  record(inv, ids2.length === 1, 'still exactly one assistant bubble after hydrate settles', { ids: ids2 })
  if (ids2.length === 1) {
    const got2 = norm(await bubbleText(page, ids2[0]))
    record(inv, got2 === expected, 'text unchanged after hydrate settles', { expected, got: got2 })
  }
}

async function inv2(page, mock, fixture, inv) {
  const cutBytes = bytesThroughEvent(fixture, 3)
  mock.setFaults({ dropAfterBytes: cutBytes }) // graceful close right after id 3, no [DONE]
  await sendMessage(page, PROMPT_1)
  await waitSettled(page, 60000)

  const gets = eventsGets(mock)
  record(inv, gets.length >= 1, 'client reattached via GET /events after the drop', {
    count: gets.length,
    urls: gets.map((r) => r.url),
  })
  const le = gets[0]?.lastEventId ?? 0
  const maxId = maxEventId(fixture.turns[0])
  record(inv, le >= 1 && le < maxId, `reattach carried Last-Event-Id in [1, ${maxId})`, { lastEventId: le })
  record(
    inv,
    gets.length === 1,
    'exactly one reattach (resume completed cleanly, no retry storm)',
    { count: gets.length },
  )

  await assertSingleBubbleExactText(page, mock, fixture, inv)
}

async function inv3(page, mock, fixture, inv) {
  mock.setFaults({ malformedAtEnd: true }) // truncated JSON frame right before [DONE]
  await sendMessage(page, PROMPT_1)

  let sawActivity = null
  try {
    // The line shows generic "Working…" before the first delta, so poll until
    // the hermes.tool.progress sentence actually appears (f3 keeps each tool
    // running > ACTIVITY_HOLD_MS so the sentence clears the anti-flicker hold),
    // recording the last seen value for diagnostics.
    await page.waitForFunction(
      () => {
        const v = document.querySelector('[data-activity]')?.getAttribute('data-activity') || ''
        window.__maiaLastActivity = v
        return /search/i.test(v)
      },
      undefined,
      { timeout: 15000 },
    )
    sawActivity = await page.evaluate(() => window.__maiaLastActivity)
  } catch {
    sawActivity = await page
      .evaluate(() => window.__maiaLastActivity ?? null)
      .catch(() => null) /* checked below */
  }
  record(
    inv,
    typeof sawActivity === 'string' && /search/i.test(sawActivity),
    'tool progress rendered the live activity line ("Searching the web")',
    { sawActivity },
  )

  await waitSettled(page, 45000)
  record(inv, true, 'stream completed through tool events + malformed trailing frame')
  await assertSingleBubbleExactText(page, mock, fixture, inv, { allowToolChipForensics: true })
}

async function inv4(page, mock, fixture, inv) {
  const [turnA, turnB] = fixture.turns
  const expectedA = norm(fullTextForTurn(turnA))
  const expectedB = norm(fullTextForTurn(turnB))

  // Turn 1
  await sendMessage(page, PROMPT_1)
  await waitSettled(page)
  let ids = assistantIdsOf(await allMessageIds(page))
  record(inv, ids.length === 1, `turn A renders exactly one assistant bubble (got ${ids.length})`, { ids })
  const idA = ids[0]
  const gotA = norm(await bubbleText(page, idA))
  record(inv, gotA === expectedA, 'turn A text exact', { expected: expectedA, got: gotA })

  // Turn 2 as a reply-quote of bubble A
  const anchorA = page.locator(`[data-message-id="${idA}"] .sand-message-action-anchor`).first()
  await anchorA.hover()
  await page.getByRole('button', { name: /^Reply to / }).first().click()
  // "Cancel reply" is an aria-label on an icon-only button — match by role/name,
  // not by text content (mirrors scripts/reactions-replies-smoke.mjs).
  await page.getByRole('button', { name: 'Cancel reply' }).waitFor({ state: 'visible', timeout: 5000 })
  record(inv, true, 'reply pill armed (Cancel reply visible)')
  await sendMessage(page, PROMPT_REPLY)
  await waitSettled(page, 60000)

  const midPath = path.join(OUT_DIR, 'inv4-f4-multiturn.png')
  await page.screenshot({ path: midPath, fullPage: true })

  ids = assistantIdsOf(await allMessageIds(page))
  record(inv, ids.length === 2, `both turns render as separate single bubbles (got ${ids.length}: ${ids.join(', ')})`, {
    ids,
  })
  const idB = ids[ids.length - 1]
  const gotB = norm(await bubbleText(page, idB))
  record(inv, gotB === expectedB, 'turn B text exact', { expected: expectedB, got: gotB })
  const gotA2 = norm(await bubbleText(page, idA))
  record(inv, gotA2 === expectedA, 'turn A text untouched after turn B', { expected: expectedA, got: gotA2 })

  // Quote pill lives inside the newest user bubble
  const usrIds = (await allMessageIds(page)).filter((i) => /^usr_/.test(i || ''))
  const lastUsr = usrIds[usrIds.length - 1]
  const quoteCount = lastUsr
    ? await page.locator(`[data-message-id="${lastUsr}"] .sand-reply-quote`).count()
    : 0
  record(inv, quoteCount > 0, 'reply quote renders inside the outgoing message', { lastUsr, quoteCount })

  // Reaction LAST so its pill text cannot contaminate the text assertions above
  await anchorA.hover()
  await page.getByRole('button', { name: 'Add reaction' }).first().click()
  await page.getByRole('button', { name: '🎉' }).first().click()
  const pill = page.locator(`[data-message-id="${idA}"] .sand-reaction-pill`).first()
  await pill.waitFor({ state: 'visible', timeout: 5000 })
  const pillLabel = (await pill.getAttribute('aria-label')) ?? ''
  record(inv, pillLabel.includes('reacted with 🎉'), 'reaction pill renders on bubble A', { pillLabel })

  const idsFinal = assistantIdsOf(await allMessageIds(page))
  record(inv, idsFinal.length === 2, 'still exactly two assistant bubbles after reaction', { ids: idsFinal })
  const gotAFinal = norm(await bubbleText(page, idA))
  record(inv, gotAFinal === expectedA, 'turn A text intact after reaction', { expected: expectedA, got: gotAFinal })
}

async function inv5Trickle(page, mock, fixture, inv) {
  await sendMessage(page, PROMPT_1)
  await waitSettled(page)
  const turn = fixture.turns[0]
  const expected = norm(fullTextForTurn(turn))
  const ids = assistantIdsOf(await allMessageIds(page))
  record(inv, ids.length === 1, `trickle: exactly one assistant bubble (got ${ids.length})`, { ids })
  const got = norm(await bubbleText(page, ids[0]))
  record(inv, got === expected, 'trickle: all twelve chunks delivered in order, exact text', { expected, got })
  const gets = eventsGets(mock)
  record(inv, gets.length === 0, 'trickle: clean close produced zero /events reattach', { count: gets.length })
}

// ------------------------------------------------------------- orchestration

const SCENARIOS = [
  { key: 'f1', inv: 'INV1', fixtureRef: 'f1', shot: 'inv1-f1-golden.png', run: inv1 },
  { key: 'f2', inv: 'INV2', fixtureRef: 'f2', shot: 'inv2-f2-reattach.png', run: inv2 },
  { key: 'f3', inv: 'INV3', fixtureRef: 'f3', shot: 'inv3-f3-tools.png', run: inv3 },
  { key: 'f4', inv: 'INV4', fixtureRef: 'f4', shot: 'inv4-f4-end.png', run: inv4 },
  { key: 'f5', inv: 'INV5', fixtureRef: 'f5', shot: 'inv5-f5-trickle.png', run: inv5Trickle },
]

async function runScenario(browser, base, sc) {
  console.log(`\n=== ${sc.inv} (${sc.key}) ===`)
  const fixture = loadFixture(sc.fixtureRef)
  const mock = await createMockAgentServer({ fixture })

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const logs = []
  let page
  try {
    await ctx.addInitScript((cfg) => {
      // Point HermesDeployTransport at the mock before any app code runs.
      window.localStorage.setItem('nub:mobile-session', JSON.stringify(cfg))
    }, { ...PAIRED_SESSION, host: mock.url })

    page = await ctx.newPage()
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`)
    })
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await dismissOverlays(page)
    await openNubChat(page)

    // mock.setFaults is called inside scenario runners (faults depend on fixture math).
    mock.setFaults({})
    await sc.run(page, mock, fixture, sc.inv)

    await page.screenshot({ path: path.join(OUT_DIR, sc.shot), fullPage: true })
    console.log(`  📸 ${path.join('eval/out/chat', sc.shot)}`)
  } catch (err) {
    record(sc.inv, false, `scenario crashed: ${err.message}`, { stack: (err.stack || '').split('\n')[1] })
    if (page) {
      try {
        const crashShot = path.join(OUT_DIR, `${sc.key}-crash.png`)
        await page.screenshot({ path: crashShot, fullPage: true })
        console.log(`  📸 crash evidence: eval/out/chat/${path.basename(crashShot)}`)
      } catch {}
    }
  } finally {
    if (logs.length) {
      const logPath = path.join(OUT_DIR, `${sc.key}-console.log`)
      writeFileSync(logPath, logs.join('\n'))
      console.log(`  ℹ️  ${logs.length} console error/warning lines -> eval/out/chat/${path.basename(logPath)}`)
    }
    await ctx.close().catch(() => {})
    await mock.close()
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const { fixture } = parseArgs(process.argv)

  let selected = SCENARIOS
  if (fixture) {
    selected = SCENARIOS.filter((s) => s.key === fixture || s.fixtureRef === fixture || s.inv.toLowerCase() === fixture.toLowerCase())
    if (selected.length === 0) {
      console.error(`--fixture=${fixture} matched nothing. Valid keys: ${SCENARIOS.map((s) => s.key).join(', ')}`)
      process.exit(2)
    }
  }

  const { base, vitePid } = await ensureBaseServer()
  const executablePath = chromePath()
  console.log(`[chrome] ${executablePath}`)

  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    for (const sc of selected) await runScenario(browser, base, sc)
  } finally {
    await browser.close().catch(() => {})
    if (vitePid) killGroup(vitePid)
  }

  const failed = results.filter((r) => !r.pass)
  console.log('\n──────── summary ────────')
  for (const inv of [...new Set(results.map((r) => r.inv))]) {
    const rs = results.filter((r) => r.inv === inv)
    const bad = rs.filter((r) => !r.pass)
    console.log(`${bad.length ? '✗' : '✓'} ${inv}: ${rs.length - bad.length}/${rs.length} checks passed`)
  }
  if (failed.length) {
    console.log(`\n${failed.length} FAILED check(s):`)
    for (const f of failed) console.log(`  ✗ [${f.inv}] ${f.msg}${f.detail ? ` :: ${JSON.stringify(f.detail)}` : ''}`)
    process.exit(1)
  }
  console.log('\nAll chat invariants green.')
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
