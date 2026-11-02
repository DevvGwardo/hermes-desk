// Blueprint check: the sign-in screens speak plainly and let you type.
//
// Web sign-in (WebConnect) only appears in a production web build, so this
// part runs against one (WEB_URL, default :4329; build and serve commands
// below), with the platform's auth routes answered here or refused:
//  - a request that never reaches the server says so in words, not the
//    browser's "Failed to fetch";
//  - on that error screen, typing a code keeps focus in the code box (the
//    error used to pull focus back on every keystroke);
//  - while waiting, "Use this code" with a bad code says what's wrong (it
//    used to do nothing visible).
// Phone sign-in (MobileConnect) runs in the demo (APP_URL), where the
// pairing request is blocked: its error is in words too.
//
//   npx vite build --mode web --outDir /tmp/nub-web
//   npx vite preview --mode web --outDir /tmp/nub-web --port 4329 --strictPort --host 127.0.0.1 &
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1 &
//   node tools/blueprint/sign-in-screens.mjs
import { launch, makeReport, phoneHome } from './lib.mjs'

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:4329/'
const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'sign-in-screens')
const RAW = /failed to fetch|load failed|networkerror|timed out \(/i

async function web(answerStart) {
  const { browser, page } = await launch(report, { phone: false })
  // The production build talks to the platform; answer its sign-in routes
  // here (page routes win over the harness's block-everything route).
  if (answerStart) {
    await page.route('**/api/nub/desktop/auth/start**', (r) =>
      r.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 'AB3D-EF7H', pollInterval: 2, expiresAt: new Date(Date.now() + 600_000).toISOString() }) }),
    )
    await page.route('**/api/nub/desktop/auth/poll**', (r) =>
      r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'pending', pollInterval: 2 }) }),
    )
  }
  await page.goto(WEB)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByText('Link to your agent').waitFor({ timeout: 20000 })
  await page.waitForTimeout(1500)
  return { browser, page }
}
const pasteBox = (page) => page.locator('#web-paste')

{
  const { browser, page } = await web(false)
  await step('Web: a sign-in request that never arrives is said in words', async () => {
    const text = (await page.getByTestId('pairing-error').innerText()).trim()
    return { ok: !RAW.test(text) && text.length > 0, detail: `“${text.slice(0, 70)}”` }
  })
  await step('Web: on that error screen, typing a code keeps focus in the code box', async () => {
    await page.getByRole('button', { name: /I have a code/ }).click()
    await pasteBox(page).click()
    let lost = 0
    for (const ch of 'AB3D') {
      await page.keyboard.type(ch)
      await page.waitForTimeout(80)
      if (!(await pasteBox(page).evaluate((el) => el === document.activeElement))) lost++
    }
    const value = await pasteBox(page).inputValue()
    return { ok: lost === 0 && value === 'AB3D', detail: `focus left the box on ${lost}/4 keys; box holds ${JSON.stringify(value)}` }
  })
  await browser.close()
}

{
  const { browser, page } = await web(true)
  await step('Web: while waiting, "Use this code" with a bad code says what\'s wrong', async () => {
    await page.getByRole('button', { name: /I have a code/ }).click()
    await pasteBox(page).fill('AB3D-EF7')
    await page.getByRole('button', { name: 'Use this code' }).click()
    await page.waitForTimeout(300)
    const alert = page.getByRole('alert').filter({ hasText: /pairing|code/i })
    const shown = await alert.count()
    return { ok: shown > 0, detail: shown ? `“${(await alert.first().innerText()).slice(0, 60)}”` : 'nothing shown' }
  })
  await browser.close()
}

{
  const { browser, page } = await launch(report, { phone: true })
  await phoneHome(page)
  await step('Phone: "Link this phone" says a blocked request in words', async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('nub:open-settings', { detail: { pane: 'general' } })))
    const sheet = page.getByRole('dialog', { name: 'Settings' })
    await sheet.getByRole('button', { name: 'Sign in with Telegram' }).click({ timeout: 5000 })
    await page.getByRole('heading', { name: 'Link this phone' }).waitFor({ timeout: 5000 })
    await page.waitForTimeout(1500)
    const text = (await page.locator('.nub-mobile-error').first().innerText().catch(() => '')).trim()
    return { ok: text.length > 0 && !RAW.test(text), detail: text ? `“${text.slice(0, 70)}”` : 'no error shown' }
  })
  await browser.close()
}

process.exit(finish() ? 0 : 1)
