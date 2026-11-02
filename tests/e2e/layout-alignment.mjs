// Real app geometry in a disposable, unfocused Electron profile with fixture data.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const out = path.join(artifacts, `layout-alignment-${Date.now()}`)
await mkdir(out, { recursive: true })
const checks = [], failures = [], screenshots = []
const evidence = {}
let h, failure = null
const middle = box => box.y + box.height / 2

async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }) }
  catch (error) {
    failures.push(`${name}: ${error.message}`)
    checks.push({ name, passed: false, error: error.message })
    if (/^(Take control|More|Reader|Settings|Command|File preview|visible Stop|Chats)/.test(name)) throw error
  }
}
async function resize(width, height) {
  await h.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
    assertUnfocused(window)
    window.setContentSize(...size)
    function assertUnfocused(win) { if (win.isFocused()) throw new Error('Fixture must remain unfocused') }
  }, [width, height])
  await h.page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height])
  await h.page.evaluate(async () => {
    const finite = document.getAnimations().filter(animation =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))
    await Promise.all(finite.map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}
async function geometry() {
  return h.page.evaluate(() => {
    const rect = element => {
      const r = element?.getBoundingClientRect()
      if (!r) return null
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
    }
    const sidebar = document.querySelector('.hd-sidebar')
    const header = document.querySelector('.messenger-header')
    const composer = document.querySelector('.messenger-composer')
    const workspace = document.querySelector('[data-side-panel="workspace"]')
    return {
      sidebar: rect(sidebar), header: rect(header),
      chat: rect(document.querySelector('[data-retained-chat]')),
      workspace: rect(workspace), workspaceHidden: workspace.hidden,
      presentation: document.querySelector('.hermes-desk-shell').getAttribute('data-workspace-presentation'),
      sidebarHeader: rect(sidebar.querySelector('.hd-sidebar-header')),
      sidebarIdentity: rect(sidebar.querySelector('.hd-sidebar-header strong')),
      sidebarHeaderButtons: [...sidebar.querySelectorAll('.hd-sidebar-header .desk-icon-button')].map(rect),
      workspaceHeader: rect(document.querySelector('.workspace-header')),
      heading: rect(header.querySelector('h1')),
      identity: rect(header.querySelector('.desk-chat-identity')),
      identityText: (() => {
        const el = header.querySelector('.desk-chat-identity')
        if (!el) return null
        const style = getComputedStyle(el)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight }
      })(),
      headerButtons: [...header.querySelectorAll('.desk-icon-button')].map(rect),
      rows: [...sidebar.querySelectorAll('.hd-row-button')].map(row => ({
        box: rect(row), avatar: rect(row.querySelector('.hd-agent-avatar')),
        avatarOverflow: getComputedStyle(row.querySelector('.hd-agent-avatar')).overflow,
        text: rect(row.querySelector('.desk-list-row-content')),
      })),
      settings: rect(sidebar.querySelector('.hd-settings')),
      restore: rect(sidebar.querySelector('.hd-restore-trigger')),
      connectors: rect(sidebar.querySelector('.hd-connector-strip')),
      context: rect(composer.querySelector('.messenger-context')),
      field: rect(composer.querySelector('.messenger-input-field')),
      textarea: rect(composer.querySelector('textarea')),
      draft: composer.querySelector('textarea').value,
      controls: [...composer.querySelectorAll('.messenger-composer-row > button, .messenger-composer-row > .desk-tooltip-anchor > button')].map(button => ({
        label: button.getAttribute('aria-label'), ...rect(button),
      })),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
}
async function shot(name) {
  const screenshot = path.join(out, `${name}.png`)
  await h.page.screenshot({ path: screenshot })
  screenshots.push(screenshot)
}
async function nativeVisible(tabId) {
  return h.app.evaluate((_electron, id) => globalThis.__hermesDeskE2E.ws.views.isVisibleTab(id), tabId)
}

try {
  h = await launchHarness()
  // Freeze decorative motion for stable geometry evidence, not a mid-flight Pip.
  await h.page.emulateMedia({ reducedMotion: 'reduce' })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  const welcome = h.page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }
  await h.send('alpha', 'chat', 'layout-fixture')
  await h.page.getByText('Local-only and deterministic.', { exact: false }).first().waitFor()
  await waitFor(async () => (await h.app.evaluate(() =>
    globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'fixture turn complete')
  const setup = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await setup.isVisible()) await setup.click()
  await check('workspace starts closed for new preferences', async () => {
    assert.equal((await geometry()).presentation, 'closed')
    assert.equal(await h.page.getByRole('button', { name: 'Toggle workspace' }).getAttribute('aria-pressed'), 'false')
  })

  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 700], [960, 640]]) {
    await resize(width, height)
    // Each width leaves its three-line draft behind; clearing it is a state
    // update, so wait for the one-line composer the checks below describe
    // instead of measuring whatever the previous width left in flight.
    await h.page.getByRole('textbox', { name: 'Message the agent' }).fill('')
    await waitFor(() => h.page.locator('.messenger-input-field')
      .evaluate(element => element.getBoundingClientRect().height === 44), 'composer settled to one line')
    const state = await geometry()
    const name = `${width}x${height}`
    await check(`${name}: task heading and separate usable header actions`, () => {
      assert.equal(state.header.height, 64)
      assert(state.heading.width > 0)
      assert.equal(state.headerButtons.length, 4)
      for (const button of state.headerButtons) {
        assert.equal(button.height, 32)
        assert.equal(button.width, 32)
        assert(button.right <= state.heading.x || button.x >= state.heading.right, 'Header action overlaps the title')
      }
      // The sidebar top is one 32px identity row above New chat and the
      // destination strip (docs/sidebar-top-consolidation-2026-10-11.md), not a
      // 64px band mirroring the chat header, so the row is held to the chat
      // title's text line instead of to the header's full height.
      assert(state.sidebarIdentity, 'No sidebar identity text in the expanded sidebar')
      assert.equal(state.sidebarHeader.height, 32)
      assert(state.sidebarHeader.bottom <= state.header.bottom, 'The sidebar identity row falls below the chat header')
      assert.equal(state.sidebarHeaderButtons.length, 1, 'The identity row keeps exactly one Search action')
      for (const button of state.sidebarHeaderButtons) {
        assert.equal(button.height, 32)
        assert.equal(button.width, 32)
        assert(button.x >= state.sidebarIdentity.right, 'The Search action needs its own space beside the identity text')
      }
      assert(Math.abs(middle(state.sidebarIdentity) - middle(state.heading)) <= 1, 'The sidebar identity text and the chat title sit on different lines')
    })
    await check(`${name}: agent identity is a 28px hit target without growing its glyphs`, () => {
      assert(state.identity, 'No agent identity button in the header')
      assert(state.identity.height >= 28, `Identity hit target is ${state.identity.height}px tall`)
      assert(state.identity.width >= 28, `Identity hit target is ${state.identity.width}px wide`)
      assert.equal(state.identityText.fontSize, '12px', 'The label grew instead of the target')
      assert.equal(state.identityText.lineHeight, '16px', 'The label grew instead of the target')
    })
    await check(`${name}: consistent roster rows and unclipped native mascot`, () => {
      const offsets = state.rows.map(row => row.text.y - row.box.y)
      assert(Math.max(...offsets) - Math.min(...offsets) <= 0.5, 'Row text shifts when activity is absent')
      for (const row of state.rows) {
        assert.equal(row.box.height, 64)
        assert.equal(row.avatar.width, 40)
        assert.equal(row.avatar.height, 40)
        assert.equal(row.avatarOverflow, 'visible')
        assert(Math.abs(middle(row.avatar) - middle(row.box)) <= 0.5)
      }
    })
    await check(`${name}: stable Attach and Send, with protected writing space`, () => {
      assert.equal(state.field.height, 44)
      assert.equal(state.controls.length, 2)
      assert.deepEqual(state.controls.map(button => button.label), ['Attach a file', 'Send'])
      assert(state.textarea.width >= 280, 'The editable area is too narrow')
      assert(state.chat.width >= 480, 'Chat is below its usable width')
      for (const button of state.controls) {
        assert.equal(button.height, 36, `${button.label} has the wrong height`)
        assert.equal(button.width, 36)
        assert(Math.abs(middle(button) - middle(state.field)) <= 0.5, `${button.label} is not vertically centered`)
      }
      assert.equal(state.settings.height, 32)
      assert.equal(state.restore.height, 32)
      assert.equal(state.connectors.height, 32)
      assert.equal(state.context.height, 32)
      assert(!state.horizontalOverflow, 'The app scrolls horizontally')
    })
    checks.push({ name: `${name}: geometry`, state })
    await shot(`${name}-chat`)

    const input = h.page.getByRole('textbox', { name: 'Message the agent' })
    await input.fill('Fixture draft')
    await check(`${name}: Send never moves or replaces voice input`, async () => {
      const sent = await geometry()
      const button = sent.controls.find(button => button.label === 'Send')
      assert(button, 'Send button missing')
      assert.equal(button.height, 36)
      assert(Math.abs(middle(button) - middle(sent.field)) <= 0.5)
      assert.equal(button.x, state.controls[1].x)
    })
    await input.fill('First line\nSecond line\nThird line')
    await check(`${name}: multiline draft remains usable`, async () => {
      const field = h.page.locator('.messenger-input-field')
      assert(await field.evaluate(element => element.scrollWidth <= element.clientWidth))
      assert.equal(await input.inputValue(), 'First line\nSecond line\nThird line')
      assert(await input.evaluate(element => element.clientHeight >= 3 * 22))
    })
    await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
    await h.page.getByRole('region', { name: 'Workspace on your Mac' }).waitFor()
    await check(`${name}: actual navigation width determines dock versus main mode`, async () => {
      const split = await geometry()
      assert.equal(split.presentation, width >= 1280 ? 'docked' : 'main')
      assert(!split.horizontalOverflow)
      if (split.presentation === 'docked') {
        assert(split.chat.width >= 480)
        assert(split.workspace.width >= 360)
        assert(split.textarea.width >= 280)
        assert(split.chat.right <= split.workspace.x + 1)
      } else {
        assert.equal(split.chat.width, 0)
        assert(split.workspace.width >= width - split.sidebar.width - 1)
        const switcher = h.page.getByRole('group', { name: 'Main work area' })
        await switcher.getByRole('button', { name: 'Chat', exact: true }).click()
        await input.waitFor()
        assert.equal(await input.inputValue(), 'First line\nSecond line\nThird line')
        assert((await geometry()).textarea.width >= 280)
        await switcher.getByRole('button', { name: 'Workspace', exact: true }).click()
      }
    })
    await shot(`${name}-workspace`)
    if (width >= 1280) {
      await check(`${name}: keyboard resize changes the preference, not a cramped render clamp`, async () => {
        const separator = h.page.getByRole('separator', { name: 'Resize panel' })
        const before = Number(await separator.getAttribute('aria-valuenow'))
        await separator.focus()
        await separator.press('ArrowRight')
        await waitFor(async () => Number(await separator.getAttribute('aria-valuenow')) === before - 16, 'keyboard panel resize')
        assert.equal(await separator.evaluate(element => document.activeElement === element), true)
        await separator.press('ArrowLeft')
      })
    }
    await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
    await input.waitFor()
    assert.equal(await input.inputValue(), 'First line\nSecond line\nThird line')
    await input.fill('')
  }
  await check('chat-only: actions float above the bubble without obscuring its text', async () => {
    const anchor = h.page.getByRole('group', { name: 'Message actions for Alpha', exact: true }).last()
    await anchor.hover()
    const bar = anchor.locator('.messenger-message-actions')
    await bar.waitFor()
    const positions = await anchor.evaluate(element => {
      const bubble = element.querySelector('.ca-bubble').getBoundingClientRect()
      const bar = element.querySelector('.messenger-message-actions').getBoundingClientRect()
      return { bubbleTop: bubble.top, barBottom: bar.bottom,
        targets: [...element.querySelectorAll('.messenger-message-actions button')]
          .map(button => button.getBoundingClientRect().height) }
    })
    assert(positions.barBottom <= positions.bubbleTop - 4)
    assert(positions.targets.every(height => height === 32))
    assert(await bar.locator('button').count() <= 4)
  })
  await check('chat-only: a press 12px above the identity label opens Agent info', async () => {
    const identity = h.page.locator('.desk-chat-identity').first()
    await identity.waitFor()
    const box = await identity.boundingBox()
    assert(box && box.height >= 28, `Identity hit target is ${box?.height}px tall`)
    const before = await identity.getAttribute('aria-pressed')
    await h.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 - 12)
    await waitFor(async () => (await identity.getAttribute('aria-pressed')) !== before, 'agent info opened')
    // At this width the panel covers the header, so it closes like a user's would.
    await h.page.keyboard.press('Escape')
    await waitFor(async () => (await identity.getAttribute('aria-pressed')) === before, 'agent info closed')
  })
  await h.page.getByRole('textbox', { name: 'Message the agent' }).focus()
  await h.page.getByRole('tooltip').filter({ hasText: 'Toggle workspace' }).waitFor({ state: 'hidden' })
  await shot('960x640-chat-only')
  await h.page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
  await h.page.locator('.hd-sidebar[data-compact="true"]').waitFor()
  await resize(960, 640)
  await h.page.waitForFunction(() => {
    const nav = document.querySelector('.hd-agent-roster')
    return nav.scrollWidth === nav.clientWidth
  })
  await check('compact rail: consistent targets and centered avatars without horizontal overflow', async () => {
    const state = await h.page.locator('.hd-sidebar').evaluate(sidebar => {
      const center = element => {
        const rect = element.getBoundingClientRect()
        return rect.x + rect.width / 2
      }
      const nav = sidebar.querySelector('.hd-agent-roster')
      const rows = [...sidebar.querySelectorAll('.hd-row-button')]
      return {
        width: sidebar.getBoundingClientRect().width, noOverflow: nav.scrollWidth === nav.clientWidth,
        rows: rows.map(row => ({
          height: row.getBoundingClientRect().height,
          centered: Math.abs(center(row) - center(row.querySelector('.hd-agent-avatar'))) <= 0.5,
          textHidden: getComputedStyle(row.querySelector('.desk-list-row-content')).display === 'none',
        })),
        settingsCentered: Math.abs(center(sidebar.querySelector('.hd-settings')) - center(sidebar.querySelector('.hd-settings svg'))) <= 0.5,
      }
    })
    assert.equal(state.width, 60)
    checks.push({ name: 'compact rail: geometry', state })
    assert(state.noOverflow && state.settingsCentered, JSON.stringify(state))
    for (const row of state.rows) assert(row.height === 56 && row.centered && row.textHidden)
  })
  await h.page.getByRole('textbox', { name: 'Message the agent' }).focus()
  await h.page.mouse.move(800, 200)
  await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
  await check('compact navigation restores a usable split at 960px', async () => {
    const state = await geometry()
    assert.equal(state.presentation, 'docked')
    assert(state.chat.width >= 480 && state.workspace.width >= 360)
    assert(state.textarea.width >= 280)
  })
  await shot('960x640-compact')
  await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
  await h.page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await resize(1440, 900)
  await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
  await check('enlarged text switches to one work area without overwriting preferred widths', async () => {
    const preferred = await h.page.evaluate(() => localStorage.getItem('nub:side-panel-width:workspace'))
    await h.page.evaluate(() => document.documentElement.style.fontSize = '24px')
    await h.page.waitForFunction(() => document.querySelector('.hermes-desk-shell').dataset.workspacePresentation === 'main')
    await h.page.getByRole('group', { name: 'Main work area' }).getByRole('button', { name: 'Chat', exact: true }).click()
    assert((await geometry()).textarea.width >= 280)
    assert.equal(await h.page.evaluate(() => localStorage.getItem('nub:side-panel-width:workspace')), preferred)
    await shot('1440x900-enlarged-text')
    await h.page.evaluate(() => document.documentElement.style.fontSize = '')
    await h.page.waitForFunction(() => document.querySelector('.hermes-desk-shell').dataset.workspacePresentation === 'docked')
  })

  await h.page.getByRole('button', { name: 'Open a page', exact: true }).click()
  const address = h.page.getByRole('textbox', { name: 'Workspace address' })
  await address.fill(`${h.fixture.url}/alpha`)
  await address.press('Enter')
  const tab = await waitFor(async () => (await h.state()).lanes.flatMap(lane => lane.tabs)
    .find(tab => tab.url === `${h.fixture.url}/alpha`), 'native fixture page')
  await waitFor(() => h.app.evaluate((_electron, id) => {
    const wc = globalThis.__hermesDeskE2E.ws.lanes.getTab(id).webContents
    return !wc.isLoadingMainFrame() && wc.getURL().endsWith('/alpha')
  }, tab.id), 'native page load complete')
  await waitFor(() => nativeVisible(tab.id), 'native browser visible')
  await check('native viewport bounds match the rendered workspace', async () => {
    const bounds = await h.app.evaluate((_electron, id) => globalThis.__hermesDeskE2E.ws.views.get(id).getBounds(), tab.id)
    const rendered = await h.page.locator('.workspace-viewport').boundingBox()
    for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(bounds[key] - rendered[key]) <= 1)
  })
  await check('Take control and Resume preserve the isolated tab partition', async () => {
    const partition = await h.app.evaluate((_electron, id) => globalThis.__hermesDeskE2E.ws.lanes.getTab(id).partition, tab.id)
    const resume = h.page.getByRole('button', { name: 'Resume agent', exact: true })
    if (await resume.isVisible()) await resume.click()
    await h.page.getByRole('button', { name: 'Take control', exact: true }).click()
    await h.page.getByText('Paused, you took control', { exact: true }).waitFor()
    await h.page.getByRole('button', { name: 'Resume agent', exact: true }).click()
    await h.page.getByRole('button', { name: 'Take control', exact: true }).waitFor()
    assert.equal(await h.app.evaluate((_electron, id) => globalThis.__hermesDeskE2E.ws.lanes.getTab(id).partition, tab.id), partition)
  })
  await check('More is keyboard reachable and blocks native pixels under its modal', async () => {
    const trigger = h.page.getByRole('button', { name: 'More workspace actions', exact: true })
    await trigger.focus()
    await trigger.press('Enter')
    const dialog = h.page.getByRole('dialog', { name: 'More workspace actions', exact: true })
    await dialog.waitFor()
    await waitFor(async () => !await nativeVisible(tab.id), 'native browser hidden by More')
    await h.page.keyboard.press('Tab')
    assert(await dialog.evaluate(element => element.contains(document.activeElement)))
    await shot('1440x900-workspace-more')
    await h.page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await waitFor(() => nativeVisible(tab.id), 'native browser restored')
    assert(await trigger.evaluate(element => document.activeElement === element))
  })
  await check('Reader preview hides native pixels and restores the same tab', async () => {
    await h.app.evaluate((_electron, id) => {
      const debug = globalThis.__hermesDeskE2E.ws.lanes.getTab(id).webContents.debugger
      const original = debug.sendCommand
      globalThis.__e2eReaderCommands = []
      globalThis.__e2eRestoreReader = () => { debug.sendCommand = original }
      debug.sendCommand = async (...args) => {
        const command = { method: args[0] }
        globalThis.__e2eReaderCommands.push(command)
        try {
          const result = await original.apply(debug, args)
          command.completed = true
          return result
        } catch {
          command.failed = true
          throw new Error('Fixture reader protocol command failed')
        }
      }
    }, tab.id)
    try {
      await h.page.getByRole('button', { name: 'More workspace actions', exact: true }).click()
      await h.page.getByRole('dialog', { name: 'More workspace actions', exact: true })
        .getByRole('button', { name: 'Reader preview', exact: true }).click()
      const reader = h.page.getByRole('region', { name: 'Page snapshot preview', exact: true })
      await reader.waitFor()
      await waitFor(async () => !await nativeVisible(tab.id), 'native browser hidden by Reader')
      await reader.locator('pre').waitFor()
      await shot('1440x900-reader')
      await reader.getByRole('button', { name: 'Close preview', exact: true }).click()
      await waitFor(() => nativeVisible(tab.id), 'native browser restored after Reader')
    } finally {
      evidence.readerCommands = await h.app.evaluate(() => globalThis.__e2eReaderCommands)
      await h.app.evaluate(() => { globalThis.__e2eRestoreReader() })
    }
  })
  await check('Settings traps focus, makes the shell inert, and hides native browser content', async () => {
    await h.page.keyboard.press('Meta+,')
    const dialog = h.page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.waitFor()
    await waitFor(async () => !await nativeVisible(tab.id), 'native browser hidden by Settings')
    assert.equal(await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button').count(), 6)
    assert(await h.page.locator('.hd-sidebar').evaluate(element => Boolean(element.closest('[inert]'))))
    await dialog.getByRole('textbox', { name: 'Search settings' }).fill('audit log')
    await dialog.getByRole('button', { name: /Audit log/ }).click()
    await dialog.locator('[data-setting="audit"]').waitFor()
    await shot('1440x900-settings')
    await h.page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await waitFor(() => nativeVisible(tab.id), 'native browser restored after Settings')
  })
  await check('Command-K opens the palette above native content and returns safely', async () => {
    await h.page.keyboard.press('Meta+k')
    const dialog = h.page.getByRole('dialog', { name: 'Search', exact: true })
    await dialog.waitFor()
    await waitFor(async () => !await nativeVisible(tab.id), 'native browser hidden by palette')
    await h.page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await waitFor(() => nativeVisible(tab.id), 'native browser restored after palette')
  })
  await check('File preview deep link hides native content and restores the same tab', async () => {
    const file = path.join(h.root, 'Documents', 'fixture-preview.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '# Disposable preview\nOnly local fixture content.\n')
    await h.page.evaluate(file => {
      const [route, query = ''] = location.hash.split('?')
      const params = new URLSearchParams(query)
      params.set('preview', file)
      location.hash = `${route}?${params}`
    }, file)
    const preview = h.page.getByRole('dialog', { name: 'fixture-preview.md', exact: true })
    await preview.waitFor()
    await preview.getByText('Only local fixture content.', { exact: true }).waitFor()
    await waitFor(async () => !await nativeVisible(tab.id), 'native browser hidden by file preview')
    await shot('1440x900-file-preview')
    await preview.getByRole('button', { name: 'Close', exact: true }).click()
    await preview.waitFor({ state: 'hidden' })
    await waitFor(() => nativeVisible(tab.id), 'native browser restored after file preview')
  })

  await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
  const note = path.join(h.root, 'Documents', 'fixture-note.md')
  await mkdir(path.dirname(note), { recursive: true })
  await writeFile(note, '# Disposable attachment\nNo user data.\n')
  await check('visible Stop interrupts a real turn while preserving a multiline draft and attachment', async () => {
    await h.send('alpha', 'stop', 'visible-stop-fixture')
    await waitFor(async () => (await h.app.evaluate(() => globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length > 0, 'active slow turn')
    const input = h.page.getByRole('textbox', { name: 'Message the agent' })
    await input.fill('Follow-up draft\nKeep this text.')
    await h.app.evaluate(({ dialog }, file) => {
      globalThis.__e2eOpenDialog = dialog.showOpenDialog
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, note)
    try {
      await h.page.getByRole('button', { name: 'Attach a file', exact: true }).click()
      await h.page.locator('.messenger-composer').getByText('fixture-note.md', { exact: true }).first().waitFor()
    } finally {
      await h.app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__e2eOpenDialog })
    }
    const stop = h.page.getByRole('button', { name: 'Stop the agent', exact: true })
    await stop.waitFor()
    await shot('1440x900-stop-with-draft')
    await stop.click()
    await waitFor(async () => (await h.app.evaluate(() => globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'confirmed interruption')
    assert.equal(await input.inputValue(), 'Follow-up draft\nKeep this text.')
    await h.page.locator('.messenger-composer').getByText('fixture-note.md', { exact: true }).first().waitFor()
    await shot('1440x900-stopped-draft-preserved')
  })
  await check('Chats resumes retained work; New chat creates a fresh context and focuses the composer', async () => {
    const oldHash = await h.page.evaluate(() => location.hash)
    await h.page.getByRole('button', { name: 'Chats', exact: true }).click()
    await h.page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
    const archive = h.page.getByRole('list', { name: 'Chats', exact: true })
    await archive.getByRole('button').first().waitFor()
    await shot('1440x900-chats')
    await archive.getByRole('button').first().click()
    const input = h.page.getByRole('textbox', { name: 'Message the agent' })
    assert.equal(await h.page.evaluate(() => location.hash), oldHash)
    assert.equal(await input.inputValue(), 'Follow-up draft\nKeep this text.')
    await h.page.locator('.hd-primary-actions').getByRole('button', { name: 'New chat', exact: true }).click()
    await h.page.waitForFunction(hash => location.hash !== hash, oldHash)
    await h.page.getByRole('heading', { name: 'New chat', exact: true }).waitFor()
    assert.equal(await input.inputValue(), '')
    assert(await input.evaluate(element => document.activeElement === element))
    await shot('1440x900-new-chat')
  })
  assert.deepEqual(h.consoleErrors, [], 'Renderer errors')
  assert.deepEqual(failures, [], 'Layout alignment regression')
} catch (error) {
  failure = error.message
  process.exitCode = 1
  if (h) await h.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
} finally {
  await h?.close()
  await writeFile(path.join(out, 'report.json'), JSON.stringify({
    checks, failures, failure, screenshots, evidence, pageErrors: h?.consoleErrors ?? [], cleanedUp: true,
  }, null, 2))
  console.log(JSON.stringify({ out, failures, failure, screenshots, cleanedUp: true }, null, 2))
}
