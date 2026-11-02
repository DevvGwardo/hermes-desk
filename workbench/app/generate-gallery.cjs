// generate-gallery.cjs — renders gallery.html from blueprint.json + inventory.json
// so every number on the page is generated, never hand-typed.
const fs = require('fs')
const path = require('path')

const bp = JSON.parse(fs.readFileSync(path.join(__dirname, 'blueprint.json'), 'utf8'))
const inv = JSON.parse(fs.readFileSync(path.join(__dirname, 'inventory.json'), 'utf8'))

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')

// ── KPI header ──
const s = bp.projectStats
const kpis = [
  ['version', 'v' + s.version],
  ['renderer LOC', s.loc.rendererSrc.toLocaleString()],
  ['test LOC', s.loc.tests.toLocaleString()],
  ['test cases', '~' + s.totalTestCases],
  ['total commits', bp.gitProgress.totalCommits],
  ['api endpoints', bp.transports.apiEndpoints.length],
]

// ── LOC bar ──
const locEntries = Object.entries(s.loc)
const locTotal = locEntries.reduce((a, [, v]) => a + v, 0)
const locColors = ['#b7d9ff', '#f5b13f', '#3fbe86', '#f9705c', '#9a72ee']
const locBar = locEntries.map(([k, v], i) =>
  `<div style="width:${(v / locTotal * 100).toFixed(1)}%;background:${locColors[i % locColors.length]}" title="${k}: ${v.toLocaleString()}"></div>`).join('')
const locLegend = locEntries.map(([k, v], i) =>
  `<span class="badge" style="border-color:${locColors[i % locColors.length]}">${k} · ${v.toLocaleString()}</span>`).join(' ')

// ── commits per day chart (30d) ──
const days = Object.entries(bp.gitProgress.commitsPerDayLast30).sort(([a], [b]) => a < b ? -1 : 1)
const maxDay = Math.max(...days.map(([, v]) => v), 1)
const commitBars = days.map(([d, v]) =>
  `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center" title="${d}: ${v}">
     <div style="width:70%;height:${Math.max(3, v / maxDay * 100)}%;background:var(--acid);border-radius:2px 2px 0 0"></div>
   </div>`).join('')

// ── architecture ──
const layerLabel = id => bp.architecture.layers.find(l => l.id === id)?.label || id
const archRows = bp.architecture.edges.map(e =>
  `<div class="arch-row">
     <span class="arch-box">${esc(layerLabel(e.from))}</span>
     <span class="arrow">──▶</span>
     <span class="arch-box">${esc(layerLabel(e.to))}</span>
   </div>`).join('')
const archCounts = bp.architecture.layers.map(l =>
  `<div class="kv"><span class="k">${esc(l.label)}</span><span class="v">${l.moduleCount} modules</span></div>`).join('')

// ── transports ──
const transportRows = bp.transports.transports.map(t =>
  `<div class="kv"><span class="k">${esc(t.name)}</span><span class="v">${esc(t.file)}</span></div>`).join('')
const endpointBadges = bp.transports.apiEndpoints.map(e => `<span class="badge">${esc(e)}</span>`).join(' ')

// ── build targets ──
const targetRows = bp.buildTargets.targets.map(t =>
  `<div class="kv"><span class="k">${esc(t.label)}</span><span class="v"><code>npm run ${esc(t.script)}</code></span></div>`).join('')
const scriptRows = bp.buildTargets.allScripts.map(sc =>
  `<tr><td><code>${esc(sc.name)}</code></td><td>${esc(sc.cmd)}</td></tr>`).join('')

// ── deps ──
const depRows = list => list.map(d => `<tr><td>${esc(d.name)}</td><td style="color:var(--muted)">${esc(d.version)}</td></tr>`).join('')

// ── git ──
const contributorRows = bp.gitProgress.contributors.map(c =>
  `<div class="kv"><span class="k">${esc(c.name)}</span><span class="v">${c.commits} commits</span></div>`).join('')
const logRows = bp.gitProgress.recentLog.slice(0, 15).map(l =>
  `<div class="commit"><span class="h">${esc(l.hash)}</span> ${esc(l.subject)}<div class="d">${esc(l.date)}</div></div>`).join('')

// ── inventory (from phase 1) ──
const invCard = it => `
  <div class="card">
    <h3>${esc(it.id)}</h3>
    <div class="kv"><span class="k">source</span><span class="v">${esc((it.file || '').split('/').pop())}</span></div>
    ${it.desc ? `<div class="kv"><span class="k">desc</span><span class="v">${esc(it.desc)}</span></div>` : ''}
    ${it.mount ? `<div class="kv"><span class="k">mount</span><span class="v">${esc(it.mount)}</span></div>` : ''}
    ${it.props ? `<table class="mini"><tr><th>props</th></tr>${it.props.map(p => `<tr><td><code>${esc(p)}</code></td></tr>`).join('')}</table>` : ''}
  </div>`

const testsByArea = Object.entries(s.testsByArea).sort((a, b) => b[1] - a[1])
const testRows = testsByArea.map(([area, n]) =>
  `<div class="kv"><span class="k">src/${esc(area)}</span><span class="v">${n} test files</span></div>`).join('')

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>maiavm-desktop — project blueprint</title>
<style>
  :root { --ink:#0d1117; --panel:#161b22; --line:rgba(240,246,252,.1); --paper:#e6edf3; --muted:#7d8590; --acid:#b7d9ff; --gold:#f5b13f; }
  * { box-sizing:border-box; margin:0 }
  body { background:var(--ink); color:var(--paper); font:13px/1.5 -apple-system,Menlo,monospace; padding:24px; max-width:1400px }
  h1 { font-size:16px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin-bottom:4px }
  .sub { color:var(--muted); font-size:11px; margin-bottom:8px }
  .stamp { color:var(--muted); font-size:10px; margin-bottom:20px }
  h2.sec { font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--acid); margin:30px 0 12px; border-bottom:1px solid var(--line); padding-bottom:6px }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:14px }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px }
  .card h3 { font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); font-weight:normal; margin-bottom:10px }
  .kv { display:flex; justify-content:space-between; padding:3px 0; border-bottom:1px solid var(--line); font-size:11px; gap:10px }
  .kv:last-child { border-bottom:none }
  .kv .k { color:var(--muted); white-space:nowrap }
  .kv .v { text-align:right; word-break:break-word }
  table.mini { width:100%; border-collapse:collapse; font-size:10.5px; margin-top:8px }
  table.mini td, table.mini th { padding:3px 6px; text-align:left; border-bottom:1px solid var(--line); color:#8b949e }
  table.mini th { color:var(--muted); font-weight:normal }
  .kpi-row { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; margin-bottom:14px }
  .kpi { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px }
  .kpi .lbl { font-size:9.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted) }
  .kpi .val { font-size:22px; font-weight:700; color:var(--paper); font-variant-numeric:tabular-nums; margin-top:2px }
  .chartbox { background:#0a0e14; border:1px solid var(--line); border-radius:10px; padding:14px }
  .badge { display:inline-block; padding:1px 8px; border-radius:99px; font-size:10px; border:1px solid var(--line); color:#8b949e; margin:1px }
  .arch-row { display:flex; align-items:center; gap:8px; padding:5px 0; font-size:11px; flex-wrap:wrap }
  .arch-box { border:1px solid var(--line); border-radius:8px; padding:6px 10px; background:#0a0e14 }
  .arrow { color:var(--muted) }
  .commit { padding:4px 0; border-bottom:1px solid var(--line); font-size:11px }
  .commit:last-child { border-bottom:none }
  .commit .h { color:var(--gold); font-family:Menlo,monospace }
  .commit .d { color:var(--muted); font-size:10px }
  .bar { height:14px; background:#0a0e14; border-radius:4px; overflow:hidden; display:flex; margin:8px 0 }
  .bar > div { height:100% }
  code { color:var(--acid); font-size:10.5px }
</style>
</head>
<body>
<h1>maiavm-desktop — project blueprint</h1>
<div class="sub">the entire project as data · generated ${esc(bp.projectStats.generatedAt)} · regenerate: <code>node workbench/app/generate-blueprint.cjs</code></div>

<h2 class="sec">vitals</h2>
<div class="kpi-row">
  ${kpis.map(([l, v]) => `<div class="kpi"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('')}
</div>
<div class="chartbox">
  <div class="kv" style="border:none;padding:0"><span class="k">code distribution (LOC, total ${locTotal.toLocaleString()})</span></div>
  <div class="bar">${locBar}</div>
  <div>${locLegend}</div>
</div>

<h2 class="sec">git progress — commits per day, last 30 days</h2>
<div class="chartbox">
  <div style="display:flex;align-items:flex-end;height:90px;gap:2px">${commitBars || '<span style="color:var(--muted)">no commits in window</span>'}</div>
  <div style="display:flex;justify-content:space-between;font-size:9.5px;color:var(--muted);margin-top:6px">
    <span>${esc(days[0]?.[0] || '')}</span><span>${esc(days[days.length - 1]?.[0] || '')}</span>
  </div>
</div>
<div class="grid" style="margin-top:14px">
  <div class="card"><h3>contributors</h3>${contributorRows}</div>
  <div class="card"><h3>recent commits (15 of ${bp.gitProgress.totalCommits})</h3>${logRows}</div>
</div>

<h2 class="sec">architecture — layers &amp; import edges</h2>
<div class="grid">
  <div class="card"><h3>module counts per layer</h3>${archCounts}</div>
  <div class="card"><h3>cross-layer import edges (${bp.architecture.edges.length})</h3>${archRows}</div>
</div>

<h2 class="sec">transports &amp; api surface</h2>
<div class="grid">
  <div class="card"><h3>transport classes</h3>${transportRows}</div>
  <div class="card"><h3>api endpoints (${bp.transports.apiEndpoints.length})</h3>${endpointBadges}</div>
</div>

<h2 class="sec">tests</h2>
<div class="grid">
  <div class="card"><h3>test files by area (${s.fileCounts.testFiles} files, ~${s.totalTestCases} cases)</h3>${testRows}</div>
</div>

<h2 class="sec">build &amp; deploy topology</h2>
<div class="grid">
  <div class="card"><h3>release targets</h3>${targetRows}</div>
  <div class="card"><h3>all npm scripts</h3><table class="mini"><tr><th>script</th><th>command</th></tr>${scriptRows}</table></div>
</div>

<h2 class="sec">dependencies</h2>
<div class="grid">
  <div class="card"><h3>runtime (${bp.deps.runtime.length})</h3><table class="mini"><tr><th>package</th><th>version</th></tr>${depRows(bp.deps.runtime)}</table></div>
  <div class="card"><h3>dev (${bp.deps.dev.length})</h3><table class="mini"><tr><th>package</th><th>version</th></tr>${depRows(bp.deps.dev)}</table></div>
</div>

<h2 class="sec">screens (${inv.screens.length})</h2>
<div class="grid">${inv.screens.map(invCard).join('')}</div>

<h2 class="sec">components (${inv.components.length})</h2>
<div class="grid">${inv.components.map(invCard).join('')}</div>

</body>
</html>`

fs.writeFileSync(path.join(__dirname, 'gallery.html'), html)
console.log('gallery.html written,', html.length, 'bytes')
