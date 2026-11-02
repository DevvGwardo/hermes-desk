// Actual Electron UI, disposable HOME and local model. Never use personal sessions.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, sandboxPolicy, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const baseline = process.argv.includes('--before')
const out = path.join(artifacts, `ui-refinement-${baseline ? 'before' : 'after'}-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { checks: [], screenshots: [], failure: null }
let h
async function resize(width, height) {
  await h.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
    assertUnfocused(window)
    window.setContentSize(...size)
    function assertUnfocused(win) { if (win.isFocused()) throw new Error('Fixture must remain unfocused') }
  }, [width, height])
  await h.page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height])
}
async function shot(name) {
  const file = path.join(out, `${name}.png`)
  await h.page.screenshot({ path: file })
  report.screenshots.push(file)
}
async function idle() {
  await waitFor(async () => (await h.app.evaluate(() =>
    globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'fixture turn finished')
}
async function seedLongHistory() {
  const script = `
import os, time
from pathlib import Path
from hermes_state import SessionDB
home = Path(os.environ["HERMES_HOME"]) / "profiles" / "alpha"
assert home.is_relative_to(Path(os.environ["HOME"]))
db = SessionDB(home / "state.db")
try:
    for i in range(42):
        sid = f"ui-refinement-history-{i}"
        db.create_session(sid, "desktop", profile_name="alpha", model="hermes-desk-fake")
        db.set_session_title(sid, f"Synthetic history {i:02d}")
        db.append_message(sid, "user", content=f"Synthetic task {i}", timestamp=time.time() - i * 60)
    sid = "ui-refinement-long"
    db.create_session(sid, "desktop", profile_name="alpha", model="hermes-desk-fake")
    db.set_session_title(sid, "Synthetic long response")
    for i in range(24):
        content = f"Synthetic message {i}."
        if i % 2:
            content += "\\n\\n" + "\\n\\n".join("## Section " + str(j) + "\\n\\n" + "Local-only reading fixture. " * 20 for j in range(4))
            content += "\\n\\n\`\`\`ts\\nconst wideFixture = '" + "x" * 250 + "'\\n\`\`\`"
        db.append_message(sid, "assistant" if i % 2 else "user", content=content, timestamp=time.time() - 24 + i)
finally:
    db.close()
`
  const child = spawn('/usr/bin/sandbox-exec', ['-p', sandboxPolicy(h.root, h.source),
    h.python, '-B', '-c', script], {
    cwd: h.root, env: h.env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
  try { assert.equal((await once(child, 'close'))[0], 0, output) } finally { clearTimeout(timer) }
  await writeFile(path.join(h.env.HERMES_HOME, 'profiles/beta/profile.yaml'),
    'ui_meta:\n  display_name: Beta with a deliberately long local agent identity for narrow windows\n')
}
try {
  h = await launchHarness({ home: true })
  await h.page.emulateMedia({ reducedMotion: 'reduce' })
  const home = h.page.getByRole('main', { name: 'Home', exact: true })
  await home.waitFor()
  await waitFor(() => h.page.getByRole('button', { name: 'Start a session', exact: true }).isEnabled(), 'roster ready')
  for (const [width, height] of [[1024, 768], [1280, 800], [1440, 900]]) {
    await resize(width, height)
    await shot(`${width}x${height}-home`)
  }
  await h.page.getByRole('button', { name: 'Start a session', exact: true }).click()
  if (!baseline) {
    const picker = h.page.getByRole('dialog', { name: 'New chat', exact: true })
    await picker.waitFor()
    await picker.getByRole('button', { name: /Alpha/ }).click()
  }
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  await h.send('alpha', 'chat', 'refinement-fixture')
  await h.page.getByText('Local-only and deterministic.', { exact: false }).first().waitFor()
  await idle()
  const setup = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await setup.isVisible()) await setup.click()
  for (const [width, height] of [[1024, 768], [1280, 800], [1440, 900]]) {
    await resize(width, height)
    await shot(`${width}x${height}-chat`)
    const input = h.page.getByRole('textbox', { name: 'Message the agent' })
    await input.fill('A draft stays with this conversation.\nAnd keeps its second line.')
    await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
    await h.page.getByRole('region', { name: 'Workspace on your Mac', exact: true }).waitFor()
    if (!baseline && width >= 1280) {
      const separator = h.page.getByRole('separator', { name: 'Resize panel', exact: true })
      const original = Number(await separator.getAttribute('aria-valuenow'))
      await h.page.keyboard.press('Tab')
      await separator.focus()
      assert(await separator.evaluate(element => getComputedStyle(element).outlineStyle !== 'none'))
      await separator.press('ArrowRight')
      await waitFor(async () => Number(await separator.getAttribute('aria-valuenow')) === original - 16, 'keyboard panel resize')
      await separator.press('ArrowLeft')
      await waitFor(async () => Number(await separator.getAttribute('aria-valuenow')) === original, 'panel width restored')
      report.checks.push(`${width}x${height}: workspace separator has visible focus and keyboard resizing restores its width`)
    }
    await shot(`${width}x${height}-workspace`)
    if (width === 1024) {
      await h.page.getByRole('group', { name: 'Main work area' }).getByRole('button', { name: 'Chat', exact: true }).click()
    }
    assert.equal(await input.inputValue(), 'A draft stays with this conversation.\nAnd keeps its second line.')
    assert(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
    await input.fill('')
    report.checks.push(`${width}x${height}: chat/workspace switching preserves draft without horizontal overflow`)
  }
  await h.page.getByRole('button', { name: 'Home', exact: true }).click()
  await home.waitFor()
  await shot('home-recent-work')
  await h.page.locator('.hd-home-row').first().click()
  await h.send('alpha', 'approve', 'refinement-approval')
  const permission = h.page.getByRole('region', { name: 'Local tool permissions', exact: true })
  await permission.waitFor()
  await shot('pending-approval')
  if (!baseline) {
    await h.page.getByRole('button', { name: 'Home', exact: true }).click()
    await home.waitFor()
    await h.page.getByRole('button', { name: 'Review approval', exact: true }).waitFor()
    await resize(1024, 768)
    assert(await h.page.locator('.hd-home-row[data-needs="approval"]').first().evaluate(element =>
      element.getBoundingClientRect().bottom <= innerHeight))
    await shot('home-approval')
    await h.page.getByRole('button', { name: 'Review approval', exact: true }).click()
    await permission.waitFor()
    report.checks.push('Home prioritizes the actual pending approval above the fold at 1024x768')
  }
  await permission.getByRole('button', { name: "Don't allow", exact: true }).click()
  await idle()
  if (!baseline) {
    const input = h.page.getByRole('textbox', { name: 'Message the agent' })
    await input.fill('Keep the keyboard here')
    await h.page.getByRole('button', { name: 'Add emoji', exact: true }).click()
    await h.page.keyboard.press('ArrowDown')
    await h.page.keyboard.press('Enter')
    await waitFor(() => input.evaluate(element => element === document.activeElement), 'composer focus restored')
    assert((await input.inputValue()).includes('👍'))
    await h.page.getByRole('button', { name: 'Composer menu', exact: true }).click()
    await h.page.keyboard.press('Escape')
    assert(await h.page.getByRole('button', { name: 'Composer menu', exact: true }).evaluate(element =>
      element === document.activeElement))
    const room = h.page.locator('.hd-sidebar').getByRole('button', { name: 'New shared room', exact: true })
    await room.focus()
    await h.page.keyboard.press('Enter')
    const dialog = h.page.getByRole('dialog', { name: 'Create group', exact: true })
    await dialog.waitFor()
    await h.page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert(await room.evaluate(element => element === document.activeElement))
    report.checks.push('Keyboard menu selection returns to the draft; Escape restores composer and shared-room triggers')

    await seedLongHistory()
    await h.restartApp()
    await h.page.emulateMedia({ reducedMotion: 'reduce' })
    await waitFor(async () => (await h.page.evaluate(() => window.nubAgent.host.status())).serve.state === 'up',
      'restarted fixture backend', 60000)
    const longName = 'Beta with a deliberately long local agent identity for narrow windows'
    await h.page.getByRole('main', { name: 'Home', exact: true }).waitFor()
    await h.page.getByRole('button', { name: 'Continue recent chat', exact: true }).waitFor()
    if (await h.page.getByRole('main', { name: 'Home', exact: true }).isVisible()) {
      await h.page.getByRole('button', { name: 'All conversations', exact: true }).click()
    } else await h.page.getByRole('button', { name: 'Chats', exact: true }).click()
    await h.page.getByRole('button', { name: longName, exact: true }).waitFor()
    await h.page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
    await h.page.getByRole('button', { name: /^Synthetic long response/ }).waitFor()
    assert.equal(await h.page.locator('.desk-chat-list > li').count(), 30)
    await h.page.getByRole('button', { name: 'Show more chats', exact: true }).click()
    assert(await h.page.locator('.desk-chat-list > li').count() >= 43)
    await h.page.getByRole('searchbox', { name: 'Search chats' }).fill('long response')
    assert.equal(await h.page.locator('.desk-chat-list > li').count(), 1)
    await h.page.getByRole('button', { name: /^Synthetic long response/ }).click()
    await h.page.getByTestId('chat-scroller').getByText('Synthetic message 23.', { exact: false }).waitFor()
    const attachmentName = 'synthetic-long-attachment-name-for-the-composer-preview.txt'
    const attachmentPath = path.join(h.root, attachmentName)
    await writeFile(attachmentPath, 'Local-only attachment fixture.\n')
    await h.app.evaluate(({ dialog }, file) => {
      const original = dialog.showOpenDialog.bind(dialog)
      dialog.showOpenDialog = async (...args) => args[1]?.title === 'Attach files to this Hermes chat'
        ? { canceled: false, filePaths: [file] } : original(...args)
    }, attachmentPath)
    await h.page.getByRole('button', { name: 'Attach a file', exact: true }).click()
    const remove = h.page.getByRole('button', { name: `Remove ${attachmentName}`, exact: true })
    await remove.waitFor()
    for (const [width, height] of [[1024, 768], [1280, 800], [1440, 900]]) {
      await resize(width, height)
      assert(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      assert(await remove.evaluate(element => getComputedStyle(element).opacity === '1' &&
        element.getBoundingClientRect().width >= 28))
      await shot(`${width}x${height}-long-response-attachment`)
      await h.page.getByRole('button', { name: longName, exact: true }).click()
      await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
      assert(await h.page.getByRole('button', { name: `Open computer preview for ${longName}`, exact: true })
        .evaluate(element => element.getBoundingClientRect().height <= 36), 'Long computer-lane identity wrapped the control')
      await shot(`${width}x${height}-long-name-workspace`)
      if (width === 1024) await h.page.getByRole('group', { name: 'Main work area' }).getByRole('button', { name: 'Chat', exact: true }).click()
      await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
      await h.page.getByRole('button', { name: 'Chats', exact: true }).click()
      await h.page.getByRole('button', { name: /^Synthetic long response/ }).click()
      await remove.waitFor()
      report.checks.push(`${width}x${height}: long names, long markdown/code, and a removable attachment fit without overflow and survive chat switching`)
    }
    await remove.click()
    const scroller = h.page.getByTestId('chat-scroller')
    // Exercise visible-window scroll logic without focusing or showing the native fixture.
    await h.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    })
    await h.page.getByRole('textbox', { name: 'Message the agent' }).fill('E2E:watchdog refinement-reading')
    await h.page.getByRole('textbox', { name: 'Message the agent' }).press('Enter')
    await scroller.getByText('Progress continues through this local-only fixture.', { exact: false }).first().waitFor()
    await scroller.evaluate(element => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true }))
      element.scrollTop = 0
      element.dispatchEvent(new Event('scroll'))
    })
    await h.page.getByTestId('jump-to-latest').waitFor()
    const before = await scroller.evaluate(element => element.scrollTop)
    await idle()
    assert(Math.abs(await scroller.evaluate(element => element.scrollTop) - before) <= 2,
      'Streaming pulled the reader away from older messages')
    await shot('streaming-retains-reader-position')
    report.checks.push('A long streamed response does not pull the reader away from older messages')

    await h.send('alpha', 'browse', 'alpha')
    await idle()
    const agentTab = await waitFor(async () => (await h.state()).lanes.find(lane => lane.id === 'profile:alpha')
      ?.tabs.find(tab => tab.url === `${h.fixture.url}/alpha`), 'real agent browser page')
    await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
    await h.page.getByRole('region', { name: 'Workspace on your Mac', exact: true }).waitFor()
    // The actual native page remains in its original isolated agent partition.
    await h.page.evaluate(id => window.nubAgent.workspace.activate(id), agentTab.id)
    await h.page.getByText('Watching agent', { exact: true }).waitFor()
    await shot('workspace-watching-agent')
    await h.page.getByRole('button', { name: 'Take control', exact: true }).click()
    await h.page.getByText('Paused, you took control', { exact: true }).waitFor()
    assert.equal((await h.state()).control.laneId, 'profile:alpha')
    await shot('workspace-you-in-control')
    await h.page.getByRole('button', { name: 'Resume agent', exact: true }).click()
    await h.page.getByText('Watching agent', { exact: true }).waitFor()
    await h.page.getByRole('button', { name: 'New workspace tab', exact: true }).click()
    const tabs = h.page.getByRole('tablist', { name: 'Workspace tabs', exact: true })
    await waitFor(async () => await tabs.getByRole('tab').count() === 2, 'second native tab')
    await tabs.getByRole('tab', { selected: true }).focus()
    await h.page.keyboard.press('Home')
    await waitFor(async () => (await h.state()).activeTabId === agentTab.id, 'keyboard tab activation')
    assert(await tabs.getByRole('tab').first().evaluate(element =>
      element === document.activeElement && element.getAttribute('aria-selected') === 'true'))
    await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
    report.checks.push('Actual agent lane clearly switches Watching → Take control → Resume; keyboard tab switching retains the native page')

    const draft = h.page.getByRole('textbox', { name: 'Message the agent' })
    await draft.fill('Offline draft\nRetained through recovery')
    await h.app.evaluate(() => globalThis.__hermesDeskE2E.serveClient.stop())
    const reconnect = h.page.getByRole('button', { name: 'Reconnect', exact: true })
    await reconnect.waitFor()
    assert.equal(await draft.inputValue(), 'Offline draft\nRetained through recovery')
    assert(await h.page.getByRole('button', { name: 'Send', exact: true }).isDisabled())
    await shot('offline-draft')
    if (await reconnect.isVisible()) {
      try { await reconnect.click({ timeout: 2000 }) }
      catch (error) { if (await reconnect.isVisible()) throw error }
    }
    await reconnect.waitFor({ state: 'hidden' })
    assert.equal(await draft.inputValue(), 'Offline draft\nRetained through recovery')
    report.checks.push('Disconnected state blocks Send honestly, then recovers without losing the multiline draft')
  }
  assert.deepEqual(h.consoleErrors, [])
  report.checks.push('Actual local approval is visible, denied, and leaves no renderer errors')
} catch (error) {
  report.failure = error.stack
  if (h) {
    try { report.host = await h.page.evaluate(() => window.nubAgent.host.status()) } catch { /* best effort */ }
  }
  try { await shot('failure') } catch { /* best effort */ }
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await h?.close()
  if (report.failure) process.exitCode = 1
}
