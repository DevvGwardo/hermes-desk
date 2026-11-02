// Actual hover/focus geometry, never the user's profile or conversations.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const out = path.join(artifacts, `message-hover-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { checks: [], failure: null }
const placements = new Set()
let h

async function settle() {
  await h.page.evaluate(async () => {
    const animations = document.getAnimations().filter(animation =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

async function geometry() {
  return h.page.evaluate(() => {
    const rect = element => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x, y, width, height }
    }
    const scroller = document.querySelector('[data-testid="chat-scroller"]')
    return {
      rows: [...document.querySelectorAll('.ca-row')].map(rect),
      bubbles: [...document.querySelectorAll('.ca-bubble')].map(rect),
      scrollTop: scroller?.scrollTop, scrollHeight: scroller?.scrollHeight,
    }
  })
}

function unchanged(before, after, label) {
  for (const kind of ['rows', 'bubbles']) {
    assert.equal(after[kind].length, before[kind].length)
    for (let i = 0; i < before[kind].length; i += 1) {
      for (const axis of ['x', 'y', 'width', 'height']) {
        assert(Math.abs(after[kind][i][axis] - before[kind][i][axis]) <= 0.5,
          `${label}: ${kind}[${i}].${axis} changed from ${before[kind][i][axis]} to ${after[kind][i][axis]}`)
      }
    }
  }
  assert.equal(after.scrollTop, before.scrollTop, `${label}: transcript scrolled`)
  assert.equal(after.scrollHeight, before.scrollHeight, `${label}: transcript height changed`)
}

try {
  h = await launchHarness()
  await h.page.emulateMedia({ reducedMotion: 'reduce' })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  const welcome = h.page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }
  for (let i = 0; i < 8; i += 1) {
    await h.send('alpha', 'chat', `hover-${i}`)
    await h.page.getByTestId('stop-turn').waitFor({ state: 'hidden', timeout: 30000 })
    await h.page.getByTestId('chat-scroller')
      .getByText(`Fake streaming answer for hover-${i}.`, { exact: false }).waitFor()
  }
  const setup = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await setup.isVisible()) await setup.click()
  for (const [width, height] of [[1440, 900], [960, 640], [390, 844]]) {
    if (width < 960) {
      // The narrow workspace is intentionally a full-screen overlay.
      const toggle = h.page.getByRole('button', { name: 'Toggle workspace', exact: true })
      if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.click()
      await h.page.locator('[data-side-panel="workspace"]').waitFor({ state: 'hidden' })
      await h.page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
      await h.page.locator('.hd-sidebar[data-compact="true"]').waitFor()
    }
    await h.app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http://127.0.0.1:'))
      assertUnfocused(win)
      // Only this disposable window: also exercise the responsive CSS below
      // the desktop app's production minimum size.
      win.setMinimumSize(320, 400)
      win.setContentSize(...size)
      function assertUnfocused(window) { if (window.isFocused()) throw new Error('Fixture must remain unfocused') }
    }, [width, height])
    await h.page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height])
    await settle()
    for (const [role, index] of [['user', 0], ['user', 1], ['agent', 1]]) {
      const anchor = h.page.locator(`.sand-message-action-anchor[data-msg-role="${role}"]`).nth(index)
      if (index === 0) await h.page.getByTestId('chat-scroller').evaluate(element => { element.scrollTop = 0 })
      await anchor.scrollIntoViewIfNeeded()
      await h.page.mouse.move(2, 2)
      await h.page.evaluate(() => document.activeElement?.blur())
      await settle()
      if (index === 0) {
        await anchor.evaluate(element => {
          const scroller = element.closest('[data-testid="chat-scroller"]')
          scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8
        })
        await settle()
      }
      const before = await geometry()
      await anchor.hover()
      const toolbar = anchor.getByRole('toolbar')
      await toolbar.waitFor()
      await settle()
      unchanged(before, await geometry(), `${width}px ${role} hover`)
      const copy = toolbar.getByRole('button', { name: 'Copy', exact: true })
      const target = await copy.evaluate(button => {
        const box = button.getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        const rect = element => {
          const { x, y, width, height } = element.getBoundingClientRect()
          return { x, y, width, height }
        }
        return { usable: button.contains(hit), x: box.x + box.width / 2, y: box.y + box.height / 2,
          placement: button.closest('[role="toolbar"]').dataset.placement,
          coveredBy: hit?.getAttribute('class'),
          scroller: rect(document.querySelector('[data-testid="chat-scroller"]')),
          anchor: rect(button.closest('.sand-message-action-anchor')),
          toolbar: rect(button.closest('[role="toolbar"]')) }
      })
      assert(target.usable, `Copy is clipped or covered: ${JSON.stringify(target)}`)
      const box = await toolbar.boundingBox()
      assert(box.x >= 0 && box.x + box.width <= width, 'Toolbar extends outside the viewport')
      const below = target.placement === 'below'
      placements.add(target.placement)
      if (index === 0) assert(below, 'The first user message must exercise below placement')
      const transitX = Math.max(target.anchor.x + 1,
        Math.min(target.x, target.anchor.x + target.anchor.width - 1))
      const edgeY = below ? target.anchor.y + target.anchor.height : target.anchor.y
      const toolbarEdgeY = below ? target.toolbar.y : target.toolbar.y + target.toolbar.height
      await h.page.mouse.move(transitX, edgeY + (below ? -2 : 2))
      await settle()
      // Pause in the visual gap: a direct jump to the button misses pointer-leave bugs.
      await h.page.mouse.move(transitX, (edgeY + toolbarEdgeY) / 2)
      await settle()
      assert.equal(await toolbar.count(), 1, `${width}px ${role}: toolbar closed in the pointer gap`)
      await h.page.mouse.move(transitX, target.y)
      await h.page.mouse.move(target.x, target.y, { steps: 4 })
      await settle()
      assert(await copy.isVisible(), 'Copy disappeared while moving to its button')
      unchanged(before, await geometry(), `${width}px ${role} pointer traversal`)
      await h.page.mouse.move(2, 2)
      await settle()
      unchanged(before, await geometry(), `${width}px ${role} hover exit`)
      await anchor.focus()
      await settle()
      unchanged(before, await geometry(), `${width}px ${role} keyboard focus`)
      await h.page.evaluate(() => document.activeElement?.blur())
      report.checks.push(`${width}px ${role} ${target.placement}: pointer reaches Copy; hover, exit and keyboard focus preserve geometry`)
    }
  }
  assert(placements.has('above') && placements.has('below'), 'Exercise both toolbar placements')
  assert.deepEqual(h.consoleErrors, [])
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
  if (h) await h.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
} finally {
  await h?.close()
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ out, ...report }, null, 2))
}
