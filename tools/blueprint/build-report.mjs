// Builds docs/blueprint/nub-mobile-blueprint.html from its template and the
// harness reports in blueprint-out/data: fills the test table and every
// {{count}} so the page's numbers can't drift from the last run.
//
//   node tools/blueprint/build-report.mjs
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BP } from './lib.mjs'

const DOCS = fileURLToPath(new URL('../../docs/blueprint/', import.meta.url))
const SCRIPTS = ['mobile-parity', 'mobile-reach', 'themes', 'sweep', 'web-panels', 'routine-editor', 'phone-signin', 'phone-preview', 'phone-touch', 'phone-esc', 'web-esc', 'web-settings', 'bell-esc', 'preview-guard', 'delete-confirm', 'palette-enter', 'palette-focus', 'toast-contrast', 'desktop-themes', 'routine-resave', 'esc-layers', 'routine-switch-focus', 'files-refresh', 'bell-list', 'layers-on-top', 'slash-exact', 'message-toolbar', 'message-menu', 'phone-row-menu', 'telegram-focus', 'sign-in-screens', 'paste-race', 'quick-reply', 'analytics-off', 'replay-masking', 'demo-agent-info']
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function area(name, script) {
  const n = name.toLowerCase()
  if (n === 'no console errors') return 'General'
  if (script === 'sweep') return n.startsWith('desktop') ? 'Desktop' : 'Phone widths'
  if (script === 'web-panels') return 'Web shell'
  if (script === 'routine-editor') return 'Routines'
  if (script === 'phone-signin') return 'Settings'
  if (script === 'phone-preview') return 'Files'
  if (script === 'phone-touch') return 'Touch targets'
  if (script === 'phone-esc') return 'Keyboard'
  if (script === 'web-esc') return 'Keyboard'
  if (script === 'web-settings') return 'Settings'
  if (script === 'bell-esc') return 'Keyboard'
  if (script === 'preview-guard') return 'Files'
  if (script === 'palette-enter') return 'Search'
  if (script === 'palette-focus') return 'Keyboard'
  if (script === 'esc-layers') return 'Keyboard'
  if (script === 'routine-switch-focus') return 'Keyboard'
  if (script === 'files-refresh') return 'Files'
  if (script === 'layers-on-top') return 'Layering'
  if (script === 'slash-exact') return 'Chat'
  if (script === 'message-toolbar') return 'Keyboard'
  if (script === 'message-menu') return 'Keyboard'
  if (script === 'phone-row-menu') return 'Keyboard'
  if (script === 'telegram-focus') return 'Keyboard'
  if (script === 'sign-in-screens') return 'Sign-in'
  if (script === 'paste-race') return 'Sign-in'
  if (script === 'quick-reply') return 'Chat'
  if (script === 'bell-list') return n.includes('unread') || n.includes('name') ? 'Accessibility' : 'Notifications'
  if (script === 'routine-resave') return 'Routines'
  if (script === 'desktop-themes') return n.startsWith('dark') ? 'Dark theme' : 'Light theme'
  if (script === 'toast-contrast') return n.startsWith('dark') ? 'Dark theme' : n.startsWith('light') ? 'Light theme' : 'Accessibility'
  if (script === 'delete-confirm') return n.includes('esc') ? 'Keyboard' : 'Chat'
  if (script === 'analytics-off') return 'Privacy'
  if (script === 'replay-masking') return 'Privacy'
  if (script === 'demo-agent-info') return 'Agent info'
  if (script === 'themes') {
    if (n.startsWith('tablet')) return 'Tablets'
    if (/⌘|alt\+/.test(n)) return 'Keyboard'
    return n.startsWith('dark') ? 'Dark theme' : 'Light theme'
  }
  if (script === 'mobile-reach') {
    if (/search|jump|⌘k/.test(n)) return 'Search'
    if (/history|run output|run’s output/.test(n)) return n.includes('chat history') ? 'Chat history' : 'Routines'
    if (/task|board/.test(n)) return 'Tasks'
    if (/recipe|template|delivery|routine/.test(n)) return 'Routines'
    if (/file/.test(n)) return 'Files'
    if (/invite/.test(n)) return 'Invite links'
    if (/⌘,|shortcut/.test(n)) return n.includes('⌘,') ? 'Keyboard' : 'Home'
    return 'Home'
  }
  if (n.startsWith('home')) return 'Home'
  if (n.startsWith('#')) return 'Deep links'
  // Before the chat rule: a Settings row can name the "Chat apps" section.
  if (n.startsWith('settings ')) return 'Settings'
  if (n.startsWith('agent info') || n.includes('chat') || n.startsWith('find')) return n.includes('hidden') ? 'Hidden chats' : 'Chat'
  if (n.includes('routine')) return 'Routines'
  if (/settings|see usage|safety/.test(n)) return 'Settings'
  return 'General'
}

const reports = Object.fromEntries(SCRIPTS.map((s) => [s, JSON.parse(fs.readFileSync(`${BP}/data/report-${s}.json`, 'utf8'))]))
const rows = []
const counts = {}
let errors = 0
for (const s of SCRIPTS) {
  const r = reports[s]
  counts[s] = `${r.checks.filter((c) => c.ok).length}/${r.checks.length}`
  errors += r.errors.length
  for (const c of r.checks) {
    const pill = c.ok ? '<span class="pill ok">pass</span>' : '<span class="pill bad">fail</span>'
    rows.push(`      <tr><td>${esc(area(c.name, s))}</td><td>${esc(c.name)}</td><td class="num">${esc(c.detail) || '—'}</td><td>${pill}</td></tr>`)
  }
}

const values = {
  ...counts,
  errors: String(errors),
  'total-checks': String(rows.length),
  homeReadyMs: reports['mobile-parity'].perf.homeReadyMs?.toLocaleString('en-US') ?? '—',
  desktopReadyMs: reports.sweep.perf.desktopReadyMs?.toLocaleString('en-US') ?? '—',
}
let html = fs.readFileSync(`${DOCS}nub-mobile-blueprint.template.html`, 'utf8')
html = html.replace('<!--CHECK_ROWS-->', rows.join('\n'))
html = html.replace(/\{\{([a-zA-Z-]+)\}\}/g, (m, key) => {
  if (!(key in values)) throw new Error(`no value for ${m}`)
  return values[key]
})
fs.writeFileSync(`${DOCS}nub-mobile-blueprint.html`, html)
console.log(`wrote docs/blueprint/nub-mobile-blueprint.html · ${rows.length} checks · ${JSON.stringify(values)}`)
