// generate-blueprint.cjs — harvests REAL project data into blueprint.json
// Every number here comes from the repo itself: package.json, git, the
// filesystem, and source scans. Nothing hand-written.
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, exts, out)
    else if (exts.some(x => e.name.endsWith(x))) out.push(p)
  }
  return out
}

function countLines(files) {
  return files.reduce((n, f) => n + fs.readFileSync(f, 'utf8').split('\n').length, 0)
}

// ── 1. project stats ──
function projectStats() {
  const srcTs = walk(path.join(ROOT, 'src'), ['.ts', '.tsx'])
  const electron = walk(path.join(ROOT, 'electron'), ['.cjs', '.mjs', '.js'])
  const tests = srcTs.filter(f => f.includes('__tests__') || /\.test\./.test(f))
  const scripts = walk(path.join(ROOT, 'scripts'), ['.mjs', '.sh', '.py'])
  const workbench = walk(path.join(ROOT, 'workbench'), ['.js', '.cjs', '.html'])
  const loc = {
    rendererSrc: countLines(srcTs.filter(f => !f.includes('__tests__') && !/\.test\./.test(f))),
    tests: countLines(tests),
    electron: countLines(electron),
    scripts: countLines(scripts),
    workbench: countLines(workbench),
  }
  const testFiles = new Set(tests.map(f => path.relative(ROOT, f)))
  const suites = {}
  for (const f of testFiles) {
    const area = f.split('/')[1]
    suites[area] = (suites[area] || 0) + 1
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  return {
    generatedAt: new Date().toISOString(),
    version: pkg.version,
    loc,
    fileCounts: {
      rendererSourceFiles: srcTs.length - testFiles.size,
      testFiles: testFiles.size,
      electronFiles: electron.length,
      scripts: scripts.length,
      workbenchFiles: workbench.length,
    },
    testsByArea: suites,
    totalTestCases: (() => {
      // count it()/test() occurrences as a static approximation
      let n = 0
      for (const f of tests) n += (fs.readFileSync(f, 'utf8').match(/\b(it|test)\(/g) || []).length
      return n
    })(),
  }
}

// ── 2. dependencies ──
function deps() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  return {
    runtime: Object.entries(pkg.dependencies || {}).map(([name, version]) => ({ name, version })),
    dev: Object.entries(pkg.devDependencies || {}).map(([name, version]) => ({ name, version })),
  }
}

// ── 3. git progress ──
function gitProgress() {
  const total = parseInt(sh('git rev-list --count HEAD'))
  const contributors = sh(`git shortlog -sn HEAD | sed 's/^ *//'`).split('\n').map(l => {
    const [n, ...rest] = l.split('\t')
    return { commits: parseInt(n), name: rest.join('\t') }
  })
  const log = sh('git log --format="%h|%ad|%s" --date=format:"%Y-%m-%d %H:%M" -30')
    .split('\n').filter(Boolean).map(l => {
      const [hash, date, subject] = l.split('|')
      return { hash, date, subject }
    })
  // commits per day, last 30 days
  const byDay = sh(`git log --since="30 days ago" --date=format:"%Y-%m-%d" --format="%ad"`)
    .split('\n').filter(Boolean)
  const perDay = {}
  for (const d of byDay) perDay[d] = (perDay[d] || 0) + 1
  return { totalCommits: total, contributors, recentLog: log, commitsPerDayLast30: perDay }
}

// ── 4. architecture: layers + import edges ──
function arch() {
  const layers = [
    { id: 'electron-main', label: 'Electron main process', dir: 'electron' },
    { id: 'entry', label: 'Renderer entry', dir: 'src' },
    { id: 'components', label: 'UI components', dir: 'src/components' },
    { id: 'lib-agents', label: 'Agent transports & runtime', dir: 'src/lib/agents' },
    { id: 'lib-core', label: 'Core libs', dir: 'src/lib' },
    { id: 'plugins', label: 'Plugin host', dir: 'src/plugins' },
    { id: 'mobile', label: 'Mobile (Capacitor)', dir: 'src/mobile' },
  ]
  const layerOf = file => {
    const rel = path.relative(ROOT, file)
    if (rel.startsWith('electron')) return 'electron-main'
    if (rel.startsWith('src/plugins')) return 'plugins'
    if (rel.startsWith('src/mobile')) return 'mobile'
    if (rel.startsWith('src/lib/agents')) return 'lib-agents'
    if (rel.startsWith('src/components')) return 'components'
    if (rel.startsWith('src/lib')) return 'lib-core'
    return 'entry'
  }
  const files = walk(path.join(ROOT, 'src'), ['.ts', '.tsx']).filter(f => !f.includes('__tests__') && !/\.test\./.test(f))
  const counts = {}
  const edgeSet = new Set()
  const importRe = /(?:from|import\()\s*['"](\.[^'"]+)['"]/g
  for (const f of files) {
    const from = layerOf(f)
    counts[from] = (counts[from] || 0) + 1
    const src = fs.readFileSync(f, 'utf8')
    let m
    while ((m = importRe.exec(src))) {
      const target = path.resolve(path.dirname(f), m[1])
      if (!target.startsWith(ROOT + '/src')) continue
      const to = layerOf(target)
      if (to !== from) edgeSet.add(`${from}->${to}`)
    }
  }
  const edges = [...edgeSet].map(e => { const [from, to] = e.split('->'); return { from, to } })
  return { layers: layers.map(l => ({ ...l, moduleCount: counts[l.id] || 0 })), edges }
}

// ── 5. transports & API surface ──
function transports() {
  // known transport modes from lib/agents + maiavm-api
  const transportFiles = walk(path.join(ROOT, 'src/lib'), ['.ts']).filter(f =>
    /transport|maiavm-api|hermes-(serve|stream)|active-transport/.test(f) && !f.includes('__tests__'))
  const modes = []
  const seen = new Set()
  for (const f of transportFiles) {
    const src = fs.readFileSync(f, 'utf8')
    // class names like HermesServeTransport / HermesDeployTransport / MockTransport
    for (const m of src.matchAll(/export class (\w*Transport)/g)) {
      if (!seen.has(m[1])) { seen.add(m[1]); modes.push({ name: m[1], file: path.relative(ROOT, f) }) }
    }
  }
  // API endpoints: string literals starting with /api/
  const endpoints = new Set()
  for (const f of walk(path.join(ROOT, 'src'), ['.ts', '.tsx'])) {
    if (f.includes('__tests__')) continue
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/['"](\/api\/[a-z0-9\-/_:${}]*)['"]/g)) endpoints.add(m[1])
  }
  return {
    transports: modes,
    apiEndpoints: [...endpoints].sort(),
  }
}

// ── 6. build & deploy topology ──
function buildTargets() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  return {
    targets: [
      { id: 'electron-mac', label: 'Desktop macOS (arm64)', script: 'electron:build', output: 'release/' },
      { id: 'electron-win', label: 'Desktop Windows', script: 'electron:build:win', output: 'release/' },
      { id: 'web', label: 'Hosted web app (Vercel)', script: 'build:web', output: 'dist/' },
      { id: 'android-bundle', label: 'Android AAB (Play)', script: 'android:bundle', output: 'android/app/build/' },
      { id: 'android-apk', label: 'Android debug APK', script: 'android:debug', output: '~/Downloads/Nub-Agent-debug.apk' },
    ],
    allScripts: Object.entries(pkg.scripts).map(([name, cmd]) => ({ name, cmd })),
  }
}

// ── write ──
const bp = {
  projectStats: projectStats(),
  deps: deps(),
  gitProgress: gitProgress(),
  architecture: arch(),
  transports: transports(),
  buildTargets: buildTargets(),
}
fs.writeFileSync(path.join(__dirname, 'blueprint.json'), JSON.stringify(bp, null, 2))
console.log('sections:' + Object.keys(bp).length, '→ blueprint.json')
