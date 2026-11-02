import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { devModeExpression, normalStartup } from './main-source.test.support.mjs'

/**
 * Red-team regression tripwires.
 *
 * Behavioral coverage lives in the dedicated host, serve-auth and bin-guard test files. This suite locks the STRUCTURAL
 * invariants in place — if a refactor silently reverts a red-team fix,
 * these fail loudly instead of the property disappearing unnoticed.
 */

const require = createRequire(import.meta.url)
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('process-spawn hardening invariants (M1/M4/M5/L2/L3)', () => {
  it('git invocations neutralize hooks and fsmonitor', () => {
    const src = read('../electron/main.cjs')
    expect(src).toMatch(/core\.fsmonitor=false/)
    expect(src).toMatch(/core\.hooksPath=\/dev\/null/)
  })

  it('fs door uses hardened reads/writes, not raw fs.readFile/writeFile', () => {
    const src = read('../electron/main.cjs')
    expect(src).toMatch(/hardenedReadFile\(file/)
    expect(src).toMatch(/hardenedWriteTextFile\(file/)
    expect(src).not.toMatch(/await fs\.mkdir\(path\.dirname\(file\)/) // moved inside hardenedWriteTextFile
  })

  it('task CLI spawn is gated by bin-guard', () => {
    const src = read('../electron/main.cjs')
    expect(src).toMatch(/inspectBinTrust\(TASK_CLI\)/)
  })

  it('hermes and git spawn through bin-guard resolution, never bare PATH names', () => {
    const src = read('../electron/main.cjs')
    expect(src).not.toMatch(/spawn\('hermes'/)
    expect(src).not.toMatch(/execFile\('git'/)
    expect(src.match(/binGuard\.resolveTrustedBin\('hermes'\)/)?.length).toBe(1)
    expect(src.match(/binGuard\.resolveTrustedBin\('git'\)/)?.length).toBe(1)
  })

  it('STT transcription is concurrency-capped', () => {
    const src = read('../electron/main.cjs')
    expect(src).toMatch(/MAX_STT_INFLIGHT = 1/)
  })

  it('plugin-door file reads are jailed to the plugin roots, not just home', () => {
    const src = read('../electron/plugin-host.cjs')
    expect(src).toMatch(/outside plugin roots/)
    const handler = src.slice(src.indexOf("maia:plugins:readFileText"))
    expect(handler.slice(0, handler.indexOf("maia:plugins:watchFile"))).toContain('readPlugin(rawFile)')
    expect(src).toContain("assertInsidePluginRoots(validatePluginPath(file, 'file'), 'file')")
  })
})

describe('renderer bridge invariants (H4)', () => {
  it('preload never touches shell directly — opens go through main-process confirmation', () => {
    const src = read('../electron/preload.cjs')
    expect(src).not.toMatch(/\bshell\b/)
    expect(src).not.toMatch(/require\('electron\/shell'\)/)
  })

  it('all IPC external opens require the confirmation dialog', () => {
    const src = read('../electron/main.cjs')
    const openHttps = src.slice(src.indexOf("ipcHandle('maia:openHttps'"), src.indexOf('function runHermes'))
    expect(openHttps).toMatch(/showMessageBox/)
    expect(openHttps).toMatch(/async function openConfirmedHttps/)
    expect(src).toContain("ipcHandle('maia:openExternal', openConfirmedHttps)")
    expect(src).not.toMatch(/isIpcSafeExternalUrl/)
  })
})

describe('red-team sweep 5 hardening invariants (D-03/D-04/D-05/D-06)', () => {
  it('D-06: no bare-name osascript/cliclick spawn remains in the act path', () => {
    const main = read('../electron/main.cjs')
    // typeText must resolve through screen-act, not exec a bare name.
    expect(main).not.toMatch(/spawnSync\('osascript'/)
    expect(main).toMatch(/screenAct\.defaultResolveActFile\('osascript'\)/)
    const screenActSrc = read('../electron/screen-act.cjs')
    // Backend argv uses ctx resolution; no bare 'cliclick'/'osascript' file.
    expect(screenActSrc).not.toMatch(/file:\s*'cliclick'/)
    expect(screenActSrc).not.toMatch(/file:\s*'osascript'/)
    expect(screenActSrc).toMatch(/OSA_PATH = '\/usr\/bin\/osascript'/)
  })



  it('D-04: local HTML preview has no app-origin, network, form, or popup authority', () => {
    const modal = read('../src/components/PreviewModal.tsx')
    const frames = modal.match(/<iframe\b[\s\S]*?\/>/g) ?? []
    expect(frames).toHaveLength(1)
    for (const frame of frames) {
      expect(frame).toContain('srcDoc={srcDoc}')
      expect(frame).toContain('sandbox="allow-scripts"')
      expect(frame).toContain('referrerPolicy="no-referrer"')
      expect(frame).not.toMatch(/\bsrc=|allow-same-origin|allow-forms|allow-modals|allow-popups|allow-top-navigation/)
    }
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
      expect(modal).toContain(directive)
    }
    expect(modal).toContain('<meta http-equiv="Content-Security-Policy" content="${policy}">${html}')
  })

  it('D-04: will-navigate guard installed on both app windows', () => {
    const main = read('../electron/main.cjs')
    expect(main).toMatch(/mainWindow\.webContents\.on\('will-navigate', vmNavGuard\.willNavigateGuard/)
    expect(main).toMatch(/hudWindow\.webContents\.on\('will-navigate', vmNavGuard\.willNavigateGuard/)
  })

  it('D-03: both act handlers run the visibility gate before acting', () => {
    const main = read('../electron/main.cjs')
    const clickStart = main.indexOf('function hudClickAt')
    const clickBlock = main.slice(clickStart, main.indexOf("ipcHandle('maia:hud:actStatus'"))
    expect(clickBlock).toContain('hudActVisibilityGate')
    // The gate module is a single require at the top of main.cjs.
    expect(main).toContain("require('./hud-act-gate.cjs')")
    const typeStart = main.indexOf("ipcHandle('maia:hud:typeText'")
    const typeEnd = main.indexOf("ipcHandle('maia:openExternal'", typeStart)
    expect(typeStart).toBeGreaterThan(-1)
    expect(typeEnd).toBeGreaterThan(typeStart)
    const typeBlock = main.slice(typeStart, typeEnd)
    expect(typeBlock.indexOf('hudActVisibilityGate')).toBeGreaterThan(-1)
    expect(typeBlock.indexOf('hudActVisibilityGate')).toBeLessThan(typeBlock.indexOf('execFile(osascript'))
  })
})

describe('red-team sweep 5 low batch invariants (D-07/D-08/D-09)', () => {
  it('D-07: packaged app ignores MAIA_ELECTRON_DEV/VITE_DEV_SERVER_URL without the explicit argv hatch', () => {
    const main = read('../electron/main.cjs')
    // The old hole: packaged + env flag => dev-server origin.
    expect(main).not.toMatch(/const isDev = !app\.isPackaged \|\| process\.env\.MAIA_ELECTRON_DEV/)
    expect(main).toMatch(/--enable-packaged-dev/)
    expect(devModeExpression(main)).toBe("!nativeQualification && (!app.isPackaged || (packagedDevAllowed && process.env.MAIA_ELECTRON_DEV === '1'))")
  })




})

describe('red-team sweep 5 D-07..D-11 behavioral pins', () => {
  it('D-07 hatch: explicit --enable-packaged-dev argv gate exists', () => {
    const main = read('../electron/main.cjs')
    expect(main).toMatch(/packagedDevAllowed = process\.argv\.includes\('--enable-packaged-dev'\)/)
  })

  it('D-07 negation: isDev pins packaged+env+no-hatch to file origin (exact shape)', () => {
    const main = read('../electron/main.cjs')
    expect(devModeExpression(main)).toBe("!nativeQualification && (!app.isPackaged || (packagedDevAllowed && process.env.MAIA_ELECTRON_DEV === '1'))")
    // Old hole shapes must be gone: bare env-OR and loose truthiness (no === '1').
    expect(main).not.toMatch(/!app\.isPackaged \|\| process\.env\.MAIA_ELECTRON_DEV/)
    expect(main).toMatch(/MAIA_ELECTRON_DEV === '1'/)
    expect(main).not.toMatch(/MAIA_ELECTRON_DEV\)/) // every use is a strict comparison, never truthy-check-then-close-paren
  })

  it.each([false, true].flatMap(native => [false, true].flatMap(packaged =>
    [false, true].flatMap(hatch => [undefined, '0', '1', 'true'].map(flag =>
      ({ native, packaged, hatch, flag }))))))('executes the actual development-origin policy for %j', ({ native, packaged, hatch, flag }) => {
    const expression = devModeExpression(read('./main.cjs'))
    const value = runInNewContext(expression, {
      nativeQualification: native, app: { isPackaged: packaged },
      packagedDevAllowed: hatch, process: { env: { MAIA_ELECTRON_DEV: flag } },
    })
    expect(value).toBe(!native && (!packaged || hatch && flag === '1'))
  })

  it.each(['installServeAuthForAppWindows()', "require('./local/boot.cjs')({})", 'installAppMenu()'])(
    'refuses live bootstrap added to the isolated native branch: %s', call => {
      const main = read('./main.cjs')
      const mutated = main.replace('    createWindow()\n    return', `    createWindow()\n    ${call}\n    return`)
      expect(mutated).not.toBe(main)
      expect(() => normalStartup(mutated)).toThrow('Native startup must not bootstrap live app services')
    })

  it('D-07 negation: VITE_DEV_SERVER_URL only consumed under isDev branches', () => {
    const main = read('../electron/main.cjs')
    const uses = main.split('VITE_DEV_SERVER_URL').length - 1
    expect(uses).toBeGreaterThanOrEqual(2)
    // Both consumers (hudUrl + mainWindow load) sit inside an isDev guard.
    const hudFn = main.slice(main.indexOf('function hudUrl()'), main.indexOf('function createHudWindow()'))
    expect(hudFn).toMatch(/if \(isDev\)/)
    expect(hudFn).toMatch(/VITE_DEV_SERVER_URL/)
    const loadBlock = main.slice(main.indexOf('if (isDev) {\n    const url = process.env.VITE_DEV_SERVER_URL'))
    expect(loadBlock.startsWith('if (isDev)'))
  })








})

describe('secrets write-path invariants (#16: create + update-value, no delete)', () => {
  it('main.cjs registers create/update handlers through the assertMainSender gate', () => {
    const main = read('../electron/main.cjs')
    expect(main).toMatch(/ipcHandle\('maia:secretsCreate'/)
    expect(main).toMatch(/ipcHandle\('maia:secretsUpdateValue'/)
    expect(main).toMatch(/secretsOp\.createSecret\(/)
    expect(main).toMatch(/secretsOp\.updateSecretValue\(/)
  })

  it('the write handlers delegate to secrets-op — no inline spawn/exec', () => {
    const main = read('../electron/main.cjs')
    const start = main.indexOf("ipcHandle('maia:secretsCreate'")
    const block = main.slice(start, main.indexOf("ipcHandle('maia:serveConfig'"))
    expect(block).not.toMatch(/spawnSync|execFile|spawn\(/)
    expect(block).toMatch(/payload\?\.title/)
  })

  it('no secret value can be logged from the write path', () => {
    const main = read('../electron/main.cjs')
    const start = main.indexOf("ipcHandle('maia:secretsCreate'")
    const block = main.slice(start, main.indexOf("ipcHandle('maia:serveConfig'"))
    expect(block).not.toMatch(/console\.(log|info|debug|warn|error)/)
    const op = read('../electron/secrets-op.cjs')
    expect(op).not.toMatch(/console\.(log|info|debug)/)
  })

  it('preload guards junk for both write calls before any IPC', () => {
    const preload = read('../electron/preload.cjs')
    expect(preload).toMatch(/secretsCreate requires \{title, value\}/)
    expect(preload).toMatch(/secretsUpdateValue requires \{id, value\}/)
    expect(preload).toMatch(/ipcRenderer\.invoke\('maia:secretsCreate'/)
    expect(preload).toMatch(/ipcRenderer\.invoke\('maia:secretsUpdateValue'/)
  })

  it('preload forwards only whitelisted fields — no whole-payload passthrough', () => {
    const preload = read('../electron/preload.cjs')
    const start = preload.indexOf('secretsCreate: (payload)')
    const block = preload.slice(start, preload.indexOf('sttTranscribe:'))
    expect(block).not.toMatch(/invoke\('maia:secrets(Create|UpdateValue)', payload\)/)
    expect(block).toMatch(/title: p\.title/)
    expect(block).toMatch(/id: p\.id/)
  })

  it('no delete API exists anywhere in the secrets write path', () => {
    for (const p of ['../electron/secrets-op.cjs', '../electron/main.cjs', '../electron/preload.cjs']) {
      const src = read(p)
      expect(src, p).not.toMatch(/secretsDelete/i)
      expect(src, p).not.toMatch(/deleteSecret/i)
    }
    const op = read('../electron/secrets-op.cjs')
    expect(op).not.toMatch(/'item', 'delete'|"item", "delete"/)
  })
})

/**
 * Behavioral runtime pins — the same properties the structural greps above
 * lock, but driven through the real exports. A refactor that keeps the
 * text but breaks the behavior fails HERE.
 */
describe('behavioral runtime pins (drive the exports, not the text)', () => {
  it('willNavigateGuard allows the app origin, denies attacker top-nav + nub-vm: top-nav', () => {
    // Contract flip (peer security crew, Sep 2026): nub-vm: previews stay
    // IN-FRAME via the protocol handler — a top-navigation to nub-vm: would
    // swap the preload-bearing window onto VM-controlled content, which is
    // the D-04 attack itself. So top-nav to nub-vm: is DENIED.
    const { willNavigateGuard } = require('./vm-nav-guard.cjs')
    const guard = willNavigateGuard((url) => url === 'http://127.0.0.1:5173/')
    const attempt = (url) => {
      let prevented = false
      guard({ preventDefault: () => { prevented = true } }, url)
      return prevented
    }
    expect(attempt('http://127.0.0.1:5173/')).toBe(false)
    expect(attempt('nub-vm://file/opt/data/workspace/index.html')).toBe(true)
    expect(attempt('https://evil.example/login-lookalike')).toBe(true)
    expect(attempt('not a url')).toBe(true)
  })

  it('isInsideRoot rejects sibling-prefix escapes at runtime', () => {
    const { isInsideRoot } = require('./fs-guard.cjs')
    expect(isInsideRoot('/Users/dev', '/Users/dev-evil/secret')).toBe(false)
    expect(isInsideRoot('/Users/dev', '/Users/dev/project')).toBe(true)
  })

  it('parseHash routes panels from the hash at runtime (not just text-pinned)', async () => {
    const { parseHash } = await import('../src/lib/router.ts')
    const route = parseHash('#/c/conv-1?settings=1&tools=cron&preview=%2Fopt%2Fdata%2Ff.md')
    expect(route.conversationId).toBe('conv-1')
    expect(route.settings).toBe(true)
    expect(route.toolsTab).toBe('cron')
    expect(route.previewPath).toBe('/opt/data/f.md')
    expect(parseHash('garbage').conversationId).toBeNull()
  })

  it('the app CSP permits only self and loopback connects, never inline scripts', () => {
    const html = read('../index.html')
    const policy = /content="(default-src[^"\n]+)"/.exec(html)?.[1]
    expect(policy).toBeTruthy()
    const directives = new Map(policy.split(';').filter((v) => v.trim()).map((part) => {
      const [key, ...values] = part.trim().split(/\s+/)
      return [key, values]
    }))
    expect(directives.get('connect-src')).toEqual(["'self'", 'ws://127.0.0.1:*', 'http://127.0.0.1:*'])
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'")
    expect(directives.get('object-src')).toEqual(["'none'"])
    expect(directives.get('frame-src')).toEqual(["'self'"])
  })

  it('anchored slices stay tight: handler blocks exist and bounded (no silent drift)', () => {
    // Every slice below asserts EXISTENCE (indexOf > -1) plus an UPPER BOUND
    // on length — if the handler moves or balloons, the structural pins
    // above may be asserting on the wrong bytes and this fails first.
    const main = read('../electron/main.cjs')
    const openHttpsStart = main.indexOf("ipcHandle('maia:openHttps'")
    expect(openHttpsStart).toBeGreaterThan(-1)
    const openHttpsEnd = main.indexOf('function runHermes', openHttpsStart)
    expect(openHttpsEnd).toBeGreaterThan(openHttpsStart)
    const openHttps = main.slice(openHttpsStart, openHttpsEnd)
    expect(openHttps.length).toBeLessThan(20_000)
    expect(openHttps).toMatch(/showMessageBox/)

    const createStart = main.indexOf("ipcHandle('maia:secretsCreate'")
    expect(createStart).toBeGreaterThan(-1)
    const createEnd = main.indexOf("ipcHandle('maia:serveConfig'", createStart)
    expect(createEnd).toBeGreaterThan(createStart)
    const createBlock = main.slice(createStart, createEnd)
    expect(createBlock.length).toBeLessThan(20_000)
    expect(createBlock).not.toMatch(/spawnSync|execFile/)
  })
})

describe('dashboard route allowlist invariants (S1 defense in depth)', () => {
  const routes = require('./dashboard-routes.cjs')
  it('blocked result shape and core denies hold', () => {
    expect(routes.blockedResult()).toEqual({ ok: false, status: 403, error: 'blocked by Nub Agent' })
    for (const [m, p] of [
      ['POST', '/api/env/reveal'],
      ['GET', '/api/config/raw'],
      ['POST', '/api/model/set'],
      ['POST', '/api/hermes/update'],
      ['POST', '/api/ops/import'],
      ['POST', '/api/ops/import-upload'],
      ['POST', '/api/ops/backup'],
      ['GET', '/api/ops/backup/download?archive=b.zip'],
      ['POST', '/api/ops/hooks'],
      ['GET', '/api/pty'],
    ]) {
      expect(routes.isDashboardRouteAllowed(m, p)).toBe(false)
      expect(routes.isDashboardRouteAllowed(m, p, { internal: true })).toBe(false)
    }
    expect(routes.isDashboardRouteAllowed('POST', '/api/fs/write-text')).toBe(false)
  })
})

describe('HUD drag IPC (window move) is HUD-only', () => {
  it('every drag handler rejects senders other than the HUD window', () => {
    const src = read('../electron/main.cjs')
    for (const ch of ['maia:hud:dragStart', 'maia:hud:dragMove', 'maia:hud:dragEnd']) {
      const start = src.indexOf(`ipcHandle('${ch}'`)
      expect(start, `${ch} registered`).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('\n})', start))
      expect(body, `${ch} checks the sender`).toMatch(/isHudSender\(event\)/)
    }
    expect(src).toContain('const isHudSender = (event) => hudEventFromHud(event)')
    expect(src).toContain('event.senderFrame === hudWindow.webContents.mainFrame')
  })

  it('a drag clamps the cat to the display work area', () => {
    const src = read('../electron/main.cjs')
    const move = src.slice(src.indexOf("ipcHandle('maia:hud:dragMove'"), src.indexOf("ipcHandle('maia:hud:dragEnd'"))
    expect(move).toMatch(/getDisplayNearestPoint\(p\)\.workArea/)
    expect(move).toMatch(/Math\.min\(Math\.max\(x, wa\.x - mx\)/)
  })
})

describe('token exposure invariants (#160 / #161)', () => {
  const main = read('../electron/main.cjs')
  const preload = read('../electron/preload.cjs')

  it('maia:serveConfig answers through serveConfigForRenderer — no token leaves main', () => {
    const at = main.indexOf("ipcHandle('maia:serveConfig'")
    expect(at).toBeGreaterThan(-1)
    const handler = main.slice(at, main.indexOf('\n})', at))
    expect(handler).toMatch(/serveAuth\.serveConfigForRenderer\(/)
    const { serveConfigForRenderer } = require('./serve-auth.cjs')
    const cfg = serveConfigForRenderer({ token: 'tripwire-token', source: 'env' }, {})
    expect(JSON.stringify(cfg)).not.toContain('tripwire-token')
    expect(Object.keys(cfg)).not.toContain('token')
  })

  it('the serve header is injected by main, scoped to the app windows\' top frames', () => {
    expect(main).toMatch(/serveAuth\.installServeAuth\(session\.defaultSession,/)
    // Installed before the first live app window can issue a request.
    const boot = normalStartup(main)
    expect(boot.indexOf('installServeAuthForAppWindows()')).toBeGreaterThan(-1)
    expect(boot.indexOf('installServeAuthForAppWindows()')).toBeLessThan(boot.indexOf('createWindow()'))
    const src = read('../electron/serve-auth.cjs')
    expect(src).toMatch(/details\.frame !== wc\.mainFrame/)
    expect(src).toMatch(/details\.resourceType !== 'xhr'/)
  })

  it('preload never exposes a raw serve token or a secret value', () => {
    const serveStart = preload.indexOf('serveConfig: ()')
    expect(serveStart).toBeGreaterThan(-1)
    // Pass-through only: no token field is minted or forwarded preload-side.
    const serveBlock = preload.slice(serveStart, preload.indexOf('sttStatus:', serveStart))
    expect(serveBlock).not.toMatch(/\btoken\s*:/)
    expect(preload).not.toMatch(/secretsResolve/)
    expect(main).not.toMatch(/'maia:secretsResolve'/)
    expect(main).toMatch(/secretsOp\.copySecretToClipboard\(reference, clipboard\)/)
  })

  it('only serve-bridge.ts turns serveConfig into a connection; nobody reads a token from it', () => {
    const ts = require('typescript')
    const consumers = []
    function scan(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
        if (entry.isDirectory()) scan(url)
        else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.(?:test|d)\./.test(entry.name)) {
          const text = readFileSync(url, 'utf8')
          const tree = ts.createSourceFile(url.pathname, text, ts.ScriptTarget.Latest, true)
          function visit(node) {
            if ((ts.isPropertyAccessExpression(node) && node.name.text === 'serveConfig') ||
              (ts.isElementAccessExpression(node) && node.argumentExpression?.text === 'serveConfig')) {
              consumers.push(url.pathname.replace(new URL('../src/', import.meta.url).pathname, ''))
              let scope = node.parent
              while (scope && !ts.isFunctionDeclaration(scope)) scope = scope.parent
              expect(scope, 'serveConfig is scoped to a reviewed resolver').toBeTruthy()
              const body = scope.getText(tree)
              expect(body).not.toMatch(/(?:\?*\.\s*token\b|\[\s*['"]token['"]\s*\]|\{[^}]*\btoken\b[^}]*\}\s*=|\.\.\.)/)
            }
            ts.forEachChild(node, visit)
          }
          visit(tree)
        }
      }
    }
    scan(new URL('../src/', import.meta.url))
    expect(consumers.sort()).toEqual(['lib/hermes-agents.ts', 'lib/serve-bridge.ts'])
    const resolver = read('../src/lib/serve-bridge.ts').split('/** Auth header')[0]
    expect(resolver).toContain("return { baseUrl: c.baseUrl.replace(/\\/+$/, ''), token: '' }")
    const declaration = read('../src/vite-env.d.ts')
    const configType = declaration.slice(declaration.indexOf('serveConfig?:'), declaration.indexOf('/** Main-process serve WebSocket'))
    expect(configType).not.toMatch(/\btoken\s*[?:]/)
  })





  it('agent spawns never inherit the raw process env', () => {
    expect(main).not.toMatch(/env:\s*process\.env\b/)
    expect(main).toMatch(/env: agentEnv\.gitEnv\(\)/)
  })
})


describe('local-only Electron control plane', () => {
  it('only agent-lane execution and the fixed native denial guard reference the debugger', async () => {
    function scan(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
        if (entry.isDirectory()) scan(url)
        else if (entry.name.endsWith('.cjs') && entry.name !== 'cdp-exec.cjs') {
          const source = readFileSync(url, 'utf8')
          if (url.href === new URL('./self-modification-native-mode.cjs', import.meta.url).href) {
            const ts = require('typescript')
            const tree = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
            const references = [], commands = [], uses = []
            function visit(node) {
              if (ts.isPropertyAccessExpression(node) && node.name.text === 'debugger') references.push(node.getText(tree))
              if (ts.isIdentifier(node) && node.text === 'debuggerClient') {
                const parent = node.parent
                expect(ts.isVariableDeclaration(parent) && parent.name === node ||
                  ts.isPropertyAccessExpression(parent) && parent.expression === node &&
                  ['attach', 'sendCommand', 'on'].includes(parent.name.text), 'No debugger alias or arbitrary access').toBe(true)
                uses.push(parent.getText(tree))
              }
              if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
                node.expression.expression.getText(tree) === 'debuggerClient') commands.push(node.getText(tree).replace(/\s+/g, ''))
              ts.forEachChild(node, visit)
            }
            visit(tree)
            expect(references).toEqual(['win.webContents.debugger'])
            expect(uses).toHaveLength(6)
            expect(commands.filter(command => !command.startsWith('debuggerClient.on('))).toEqual([
              "debuggerClient.attach('1.3')",
              "debuggerClient.sendCommand('Page.enable')",
              "debuggerClient.sendCommand('Page.setInterceptFileChooserDialog',{enabled:true})",
              "debuggerClient.sendCommand('Page.handleJavaScriptDialog',{accept:false})",
            ])
            expect(commands.filter(command => command.startsWith('debuggerClient.on('))).toHaveLength(1)
            const inertLoad = source.indexOf("await win.loadURL(URL_ROOT+'index.html')")
            expect(inertLoad).toBeGreaterThan(-1)
            expect(inertLoad).toBeLessThan(source.indexOf('const debuggerClient='))
            expect(source).toContain("const BOOT=Buffer.from('<!doctype html><meta charset=\"utf-8\"><title>Trusted native preflight</title><div id=\"root\">TRUSTED INERT PREFLIGHT</div>')")
          } else expect(source, url.pathname).not.toMatch(/\.debugger\b/)
        }
      }
    }
    scan(new URL('./', import.meta.url))
    const { createCdpExecutor } = require('./local/workspace/cdp-exec.cjs')
    const contents = () => {
      const wc = new EventEmitter()
      wc.isDestroyed = () => false
      wc.debugger = { isAttached: () => false, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(async () => ({})) }
      wc.setBackgroundThrottling = vi.fn()
      return wc
    }
    const tab = { id: 't_1', laneId: 'profile:scout', webContents: contents() }
    tab.ensureLive = async () => tab.webContents
    const lanes = { getTab: (id) => id === tab.id ? tab : null,
      listTabs: () => [tab], isPaused: () => false, setTabState: vi.fn() }
    const executor = createCdpExecutor({ lanes })
    try {
      for (const id of ['app', 'overlay', 'pip']) {
        const wc = contents()
        await expect(executor.run({ id, laneId: 'profile:scout', webContents: wc,
          ensureLive: async () => wc }, 'browser_press', { key: 'ArrowLeft' })).rejects.toMatchObject({ code: 'tab_closed' })
        expect(wc.debugger.attach).not.toHaveBeenCalled()
      }
      tab.laneId = 'you'
      await expect(executor.run(tab, 'browser_press', { key: 'ArrowLeft' })).rejects.toMatchObject({ code: 'tab_closed' })
      expect(tab.webContents.debugger.attach).not.toHaveBeenCalled()
      tab.laneId = 'profile:scout'
      await expect(executor.run(tab, 'browser_press', { key: 'ArrowLeft' })).resolves.toEqual({ text: 'pressed' })
      expect(tab.webContents.debugger.attach).toHaveBeenCalledExactlyOnceWith('1.3')
    } finally { executor.dispose() }
  })

  it('secret server frames, including replayed open requests, never reach the renderer even without handlers', async () => {
    const { createServeClient } = require('./local/serve-client.cjs')
    const client = createServeClient()
    const sender = new EventEmitter()
    sender.isDestroyed = () => false
    sender.send = vi.fn()
    let proxy
    const replies = []
    const broker = client.bindRendererBroker({
      open: async (value) => { proxy = value; return { ok: true } },
      send: (_sender, payload) => { replies.push(JSON.parse(payload.data)); return { ok: true } },
      close() {}, closeAllFor() {},
    })
    try {
      await broker.open(sender, { id: 'renderer_security', path: '/api/ws' })
      proxy.send('maia:serveSocketEvent', { id: 'renderer_security', type: 'open' })
      const secure = ['secret', 'sudo', 'vault.code', 'vault.save_login', 'vault.future'].map((method, index) =>
        ({ jsonrpc: '2.0', id: `secure-${index}`, method, params: { session_id: 'fake-runtime' } }))
      proxy.send('maia:serveSocketEvent', { id: 'renderer_security', type: 'message',
        data: [...secure, { jsonrpc: '2.0', id: 'replay', result: { open_requests: secure } },
          { jsonrpc: '2.0', id: 'approval', method: 'approval', params: {} }].map(JSON.stringify).join('\n') })
      await vi.waitFor(() => expect(replies).toHaveLength(secure.length))
      const visible = sender.send.mock.calls.flatMap(([, event]) =>
        (event.data || '').split('\n').filter(Boolean).map(JSON.parse))
      expect(visible).toEqual([
        { jsonrpc: '2.0', id: 'replay', result: { open_requests: [] } },
        { jsonrpc: '2.0', id: 'approval', method: 'approval', params: {} },
      ])
      expect(replies.every((frame) => frame.result.value === '')).toBe(true)
    } finally { client.stop() }
  })

  it('has no platform linking, VM scheme, updater, or publishing feed', () => {
    const main = read('./main.cjs')
    const preload = read('./preload.cjs')
    for (const code of [main, preload]) {
      expect(code).not.toMatch(/maia:(?:nub|update)/)
      expect(code).not.toMatch(/nub-vm:|download\.maiavm\.com|require\('\.\/(?:nub-link|vm-preview|update-signature)/)
    }
    for (const file of ['nub-link.cjs', 'vm-preview.cjs', 'vm-copy.cjs', 'vm-save.cjs', 'link-raise.cjs', 'update-signature.cjs']) {
      expect(existsSync(new URL(file, import.meta.url))).toBe(false)
    }
    const pkg = JSON.parse(read('../package.json'))
    expect(pkg.build.appId).toBe('com.devgwardo.hermesdesk')
    expect(pkg.build.productName).toBe('Hermes Desk')
    expect(pkg.build).not.toHaveProperty('publish')
    expect(pkg.build).not.toHaveProperty('protocols')
  })

  it('never exposes a global browser debugging port anywhere in electron', () => {
    const forbidden = ['--remote', 'debugging-port'].join('-')
    function scan(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
        if (entry.isDirectory()) scan(url)
        else if (/\.(?:cjs|mjs|js|html)$/.test(entry.name)) {
          expect(readFileSync(url, 'utf8'), url.pathname).not.toContain(forbidden)
        }
      }
    }
    scan(new URL('./', import.meta.url))
  })

  it('wires the host once after the main window exists and keeps the hardened app windows', () => {
    const main = read('./main.cjs')
    const ready = main.slice(main.indexOf('app.whenReady()'))
    expect(ready.indexOf("require('./local/boot.cjs')")).toBeGreaterThan(ready.indexOf('createWindow()'))
    for (const dep of ['WebContentsView', 'session', 'dialog', 'secretsOp', 'ipcHandle', 'assertMainSender']) {
      expect(ready).toContain(dep)
    }
    expect(main.match(/require\('\.\/local\/boot\.cjs'\)/g)).toHaveLength(1)
    expect(main).toContain('contextIsolation: true')
    expect(main).toContain('nodeIntegration: false')
    expect(main).toContain('sandbox: true')
    expect(main).toContain('webviewTag: false')
  })
})
