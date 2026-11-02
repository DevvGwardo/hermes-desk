/**
 * Isolated renderer golden, not a backend or native-picker E2E.
 * Run: node tools/blueprint/messenger-golden.mjs [--update]
 * Captures the real chat components with messenger-transcript.json.
 * Canonical decoded-pixel hashes are checked in below. --update stages PNGs in
 * gitignored blueprint-out/messenger-golden/baseline for review, never adoption.
 */
import { createServer } from 'vite'
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../../', import.meta.url))
const out = path.join(root, 'blueprint-out/messenger-golden')
const baseline = path.join(out, 'baseline')
const update = process.argv.includes('--update')
// Reviewed canonical decoded-pixel hashes. --update only stages local candidates,
// never rewrites these expectations. Pixel changes require explicit review.
const PIXEL_GOLDENS = {
  '360-transcript.png': 'e3d6db7356a337b69f53d0b1ace396ecb8d66e7fa9444d9e7c4f2d0c266ceb39',
  '360-markdown.png': 'dd9f48b191068978c5abb8eae5b938ad8b679651d3f39456c7a2a740f3818d8e',
  '360-markdown-top.png': 'c5354005fc2de6f0db640f29300fc7f3ff558bbde7ae15cec6fbe6f242a51364',
  '360-starters.png': '973bbaed9734dc6a49f5b2b42605bf8ecd0afbca51fc8fd08cadd7ffffdd72a8',
  '480-transcript.png': '8e892e835a0ead2fa94d0390add097a38dca6f049b530c75de9cdf9bcf863167',
  '480-markdown.png': '0e720206a557e1bf31eb3ab6561721c29e873d993f93d2a5c8be79ddc5b55b8f',
  '480-markdown-top.png': '160906a35943e602b245fbd217eb013b0a6a3831137fa45d18ffb0e8b3fd6a50',
  '480-starters.png': 'a832087a0952fdda890c88cbc68d82f80937eae75b84b51d88c0602ddaf71577',
  '640-transcript.png': '2a49c548a730200475b7e5e0fa0d0a83159cb3db3018a0c9dd998f1ba86291bf',
  '640-markdown.png': 'b61bba4950a1d437cab1a5d5d7f7bd6b08a52de9b5ce999598ec1a2ba7da151b',
  '640-markdown-top.png': 'e322775e0078043569904ce4b29d9f38fb6cd4ea6fade73bce9e76d4f967fe6f',
  '640-starters.png': '5bbc39b3a3280b89bfa083445bd97b15ab2231352b71479adf8c0271081c01b7',
}
const temp = await mkdtemp(path.join(os.tmpdir(), 'hermes-messenger-golden-'))
const entry = '/__messenger-golden.tsx'
const source = `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '/src/index.css'
import '/src/styles/desk-tokens.css'
import { ChatPanel } from '/src/components/ChatPanel'
import { TopBar } from '/src/components/TopBar'
import { loadMarkdown } from '/src/components/MessageBody'
import fixture from '/tests/fixtures/messenger-transcript.json'
await loadMarkdown()
const now = new Date(fixture.now).getTime()
const OriginalDate = Date
window.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
// Reduced-motion Pip still blinks in the shared engine. Keep fixture animation
// timestamps at zero while preserving real frame scheduling and DOM paint.
const originalRaf = window.requestAnimationFrame.bind(window)
window.requestAnimationFrame = callback => originalRaf(() => callback(0))
const params = new URLSearchParams(location.search)
const agent = { id: 'profile:fixture-scout', name: 'Fixture Scout with a deliberately long local profile name',
  hermesProfile: fixture.profile, createdAt: fixture.now, model: fixture.model, persona: {} }
const markdown = { id: 'contrast-fixture', threadId: 'messenger-fixture', role: 'agent', createdAt: fixture.now,
  fromAgentId: agent.id, content: 'Read \`inline code\` and [a link](https://example.invalid).\\n\\n| Area | Result |\\n| --- | --- |\\n| Chat | Clear |\\n\\n' + Array.from({length: 24}, (_, i) => 'Paragraph ' + i + ': this long answer exercises date scrolling without occluding words.').join('\\n\\n') }
function Golden() {
  const [messages, setMessages] = useState(params.has('starters') ? [] : params.has('markdown') ? [...fixture.messages, markdown] : fixture.messages)
  const [draft, setDraft] = useState('')
  return <div className="desk-theme flex h-screen overflow-hidden" data-skin="messenger" style={{background:'var(--desk-surface-0)'}}>
    <section data-testid="golden-chat" className="flex min-w-0 flex-col" style={{width:params.get('width')+'px'}}>
      <TopBar agent={agent} active showInfo={false} onToggleInfo={()=>{}} showFiles={false} onToggleFiles={()=>{}}
        live={false} skin="messenger" workspaceOpen onToggleWorkspace={()=>{}} />
      <ChatPanel messages={messages} skin="messenger" threadKey="messenger-fixture" parentAgentName="Fixture Scout"
        agents={[agent]} starterAgent={agent} profile={fixture.profile} model={fixture.model} composerValue={draft}
        onComposerChange={setDraft} permissionAsk={params.has('markdown') || params.has('starters') ? null : fixture.approval} onPermission={async ()=>{}}
        onSend={text=>{setMessages(rows=>[...rows,{id:'sent-fixture',threadId:'messenger-fixture',role:'user',content:text,createdAt:fixture.now}]);setDraft('')}}
        onReact={()=>{}} onReply={()=>{}} onBranch={()=>{}} onRetryTurn={()=>{}} onStopTurn={()=>{}}
        onPickAttachments={async ()=>[{name:'fixture.txt',path:'/fake/workspace/fixture.txt',kind:'file',size:7}]}
        todos={[{content:'Read fixture',status:'completed'},{content:'Explain lanes',status:'in_progress'}]}
        usage={{input_tokens:1200,output_tokens:200,cost_usd:0.01}} />
    </section>
    <aside className="flex-1" style={{background:'var(--desk-surface-1)'}}>Isolated workspace dock fixture</aside>
  </div>
}
createRoot(document.getElementById('root')).render(<Golden />)
`
let app, server, page
const results = []
const pixels = async png => {
  const decoded = await app.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
    return { size: image.getSize(), bitmap: image.toBitmap().toString('base64') }
  }, png.toString('base64'))
  return createHash('sha256').update(JSON.stringify(decoded.size)).update(Buffer.from(decoded.bitmap,'base64')).digest('hex')
}
try {
  await mkdir(baseline, { recursive: true })
  server = await createServer({
    root, cacheDir: path.join(temp, 'vite-cache'),
    optimizeDeps: { entries: [], noDiscovery: true,
      include: ['react', 'react-dom/client', 'react/jsx-runtime', 'framer-motion', 'react-markdown', 'remark-gfm'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error',
    plugins: [{
      name: 'messenger-golden-fixture',
      resolveId(id) { if (id === entry) return path.join(root, entry) },
      load(id) { if (id === path.join(root, entry)) return source },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/__messenger-golden?')) return next()
          const html = await vite.transformIndexHtml('/__messenger-golden', `<!doctype html><html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`)
          res.setHeader('Content-Type', 'text/html'); res.end(html)
        })
      },
    }],
  })
  await server.listen()
  const url = server.resolvedUrls.local[0]
  await writeFile(path.join(temp, 'main.cjs'), `
    const {app,BrowserWindow,session}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(temp, 'userData'))});
    app.whenReady().then(()=>{
      session.defaultSession.webRequest.onBeforeRequest((request,callback)=>callback({
        cancel:!request.url.startsWith(${JSON.stringify(url)})&&!request.url.startsWith('devtools:')&&!request.url.startsWith('data:')
      }));
      new BrowserWindow({show:false,width:960,height:800,useContentSize:true,backgroundColor:'#161618',
        webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}}).loadURL(${JSON.stringify(url + '__messenger-golden?width=360')});
    });
    app.on('window-all-closed',()=>app.quit());
  `)
  // Do not inherit model credentials or the owner's HOME into this background-only fixture.
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [path.join(temp, 'main.cjs')],
    env: { ...env, HOME: temp, HERMES_HOME: path.join(temp, '.hermes'), HERMES_DESK_E2E: '1', HERMES_DESK_E2E_BACKGROUND: '1' } })
  page = await app.firstWindow()
  page.on('pageerror', error => console.error('Fixture renderer:', error.message))
  page.on('requestfailed', request => console.error('Fixture request failed:', new URL(request.url()).pathname, request.failure()?.errorText))
  page.on('response', response => { if (response.status() >= 400) console.error('Fixture HTTP failure:', response.status(), new URL(response.url()).pathname) })
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })
  for (const width of [360, 480, 640]) {
    for (const state of ['transcript', 'markdown', 'markdown-top', 'starters']) {
      await page.goto(`${url}__messenger-golden?width=${width}${state === 'transcript' ? '' : `&${state.startsWith('markdown') ? 'markdown' : state}=1`}`)
      await page.getByTestId('chat-scroller').waitFor()
      if (state !== 'starters') await page.getByTestId('chat-scroller').evaluate(element => { element.scrollTop = element.scrollHeight })
      await page.locator(state === 'starters' ? '.messenger-starter-chip' : '.ca-bubble .nub-md table').first().waitFor({ state:'attached' })
      await page.waitForFunction(() => [...document.querySelectorAll('[data-character="owl"]')].length > 0 &&
        [...document.querySelectorAll('[data-character="owl"]')].every(owl=>owl.querySelector('svg')?.dataset.mascotProfile==='reduced'))
      await page.evaluate(async () => {
        await document.fonts.ready
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })
      // Geometry and contrast assertions are independent of baseline acceptance.
      const measured = await page.evaluate(() => {
        const box = element => { const r = element.getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height } }
        const header = document.querySelector('.messenger-header')
        const controls = [...header.querySelectorAll('button')].map(box)
        const headerBox = box(header)
        const collisions = controls.flatMap((a,i) => controls.slice(i+1).filter(b => Math.min(a.right,b.right)>Math.max(a.x,b.x)+1 && Math.min(a.bottom,b.bottom)>Math.max(a.y,b.y)+1))
        const foregroundBackground = selector => [...document.querySelectorAll(selector)].map(element => {
          const style = getComputedStyle(element)
          let bg = style.backgroundColor, parent = element
          while (bg === 'rgba(0, 0, 0, 0)' && parent.parentElement) { parent=parent.parentElement; bg=getComputedStyle(parent).backgroundColor }
          return { text:style.color, background:bg, opacity:style.opacity }
        })
        return { collisions, controls, headerBox, colors:foregroundBackground('.ca-bubble .nub-md :not(pre) > code, .ca-bubble .nub-md th, .ca-bubble .nub-md a, .messenger-stamp, .messenger-starter-chip'),
          dates:[...document.querySelectorAll('.messenger-date')].map(e => getComputedStyle(e).position),
          actionOverlap:[...document.querySelectorAll('.messenger-message-actions')].some(action=>[...document.querySelectorAll('.messenger-tool-chip')].some(tool=>{
            const a=box(action),b=box(tool);return Math.min(a.right,b.right)>Math.max(a.x,b.x)&&Math.min(a.bottom,b.bottom)>Math.max(a.y,b.y)
          })),
          gutter:document.querySelector('.messenger-date-gutter') ? box(document.querySelector('.messenger-date-gutter')) : null, scroller:box(document.querySelector('[data-testid="chat-scroller"]')) }
      })
      assert.equal(measured.collisions.length, 0, `Header collision at ${width}`)
      for (const box of measured.controls) {
        assert.ok(box.width >= 28 && box.height >= 28, `Small header target at ${width}`)
        assert.ok(box.x >= measured.headerBox.x - 1 && box.right <= measured.headerBox.right + 1, `Header overflow at ${width}`)
      }
      assert.ok(measured.dates.every(position=>position==='relative'), 'Dates overlap transcript')
      assert.ok(!measured.actionOverlap, 'Actions overlap preceding tools')
      assert.ok(!measured.gutter || measured.gutter.bottom <= measured.scroller.y + 1, 'Date gutter occludes transcript')
      assert.ok(measured.colors.length > 0, 'Contrast checks must measure actual rendered text')
      const luminance = color => {
        const values = color.match(/[\d.]+/g).slice(0,3).map(Number).map(v => {v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4})
        return values[0]*0.2126+values[1]*0.7152+values[2]*0.0722
      }
      for (const color of measured.colors) {
        const [light,dark] = [luminance(color.text),luminance(color.background)].sort((a,b)=>b-a)
        assert.ok((light+0.05)/(dark+0.05)>=4.5 && color.opacity==='1', `Text contrast below AA: ${JSON.stringify(color)}`)
      }
      const scroller = page.getByTestId('chat-scroller')
      await scroller.evaluate(element => { element.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true})); element.scrollTop = 0 })
      if (state !== 'starters') {
        await page.getByRole('button', { name: 'Expand tool activity' }).click()
        const caption = await page.getByTestId('tool-chip-row').textContent()
        assert.ok(!caption.includes('Running terminal'), 'Completed terminal caption is still running')
        await page.locator('[data-message-id="yesterday-agent"] .sand-message-action-anchor').hover()
        const overlap = await page.evaluate(() => [...document.querySelectorAll('.messenger-message-actions')].some(action=>[...document.querySelectorAll('.messenger-tool-chip')].some(tool=>{
          const a=action.getBoundingClientRect(),b=tool.getBoundingClientRect();return Math.min(a.right,b.right)>Math.max(a.left,b.left)&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)
        })))
        assert.ok(!overlap, 'Hovered actions occlude tool activity')
      }
      if (state === 'markdown') await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
      if (state === 'markdown-top') await scroller.evaluate(element => {
        element.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true}))
        const row = element.querySelector('[data-message-id="contrast-fixture"]')
        element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top
      })
      await page.mouse.move(950, 790)
      await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
      assert.ok(await page.evaluate(() => {
        const latest = document.querySelector('.messenger-latest')?.getBoundingClientRect()
        const scroller = document.querySelector('[data-testid="chat-scroller"]').getBoundingClientRect()
        return !latest || latest.top >= scroller.bottom - 1
      }), 'Jump to latest occludes transcript')
      const bytes = await page.getByTestId('golden-chat').screenshot({ animations: 'disabled', scale: 'css' })
      const name = `${width}-${state}.png`
      await writeFile(path.join(out, name), bytes)
      const hash = await pixels(bytes)
      if (update) await writeFile(path.join(baseline, name), bytes)
      else {
        assert.equal(hash, PIXEL_GOLDENS[name], `Pixel golden changed: ${name}. Inspect PNGs before changing canonical expectations.`)
      }
      results.push({ name, sha256: hash, header: 'pass', contrast: 'pass', dates: 'pass', actions: 'pass' })
    }
  }
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ passed:true, baselineUpdated:update, results },null,2))
  console.log(JSON.stringify({ passed:true, baselineUpdated:update, results }))
} catch (error) {
  console.error(error)
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ passed:false, error:error.message, results },null,2)).catch(()=>{})
  if (page) {
    await writeFile(path.join(out, 'failure.html'), await page.content()).catch(()=>{})
    await page.screenshot({ path:path.join(out, 'failure.png') }).catch(()=>{})
  }
  process.exitCode = 1
} finally {
  await app?.close()
  await server?.close()
  await rm(temp, { recursive: true, force: true })
}
