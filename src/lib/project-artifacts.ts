/**
 * Detect HTML / React / Vite projects the agent created on the VM.
 *
 * Grok Bot does not ship a first-class "preview this site" widget — it
 * opens Chromium on the forever-box and screenshots land in the thread.
 * Nub derives a project artifact from the same signals (file writes,
 * `npm run dev`, localhost ports, screenshot paths) so the user can
 * Preview / Download / Host without knowing the VM path.
 */

import type { ChatMessage } from './agents/types'
import {
  basename,
  dirname,
  fileRefsFromMessages,
  isVmWorkspacePath,
} from './file-refs'
import { extractReplyMedia, isPrivateVmPath } from './reply-media'
import { markdownVmImagePaths, safeLinkUrl } from './safe-image-url'

export type ArtifactKind = 'html' | 'react' | 'vite' | 'static' | 'screenshot'
export { isVmWorkspacePath } from './file-refs'

export interface ProjectArtifact {
  id: string
  kind: ArtifactKind
  title: string
  /** Directory on the agent VM (`/opt/data/...`). */
  rootPath: string
  /** File to open for static preview (index.html). */
  entryFile?: string
  /** Live Vite/Node port on the VM loopback. */
  port?: number
  /** PNG/JPEG the agent captured on the box. */
  screenshotPath?: string
  /** Hosted URL if the agent already published. */
  hostedUrl?: string
}

const VM_ROOT = '/opt/data'
const PORT_RE = /(?:localhost|127\.0\.0\.1):(\d{2,5})/g
const PATH_RE = /(\/opt\/data\/[^\s"'`]+)/g
const HTML_FILE_RE = /(\/opt\/data\/[^\s"'`]+\.html)\b/gi
const PKG_RE = /(\/opt\/data\/[^\s"'`]+\/package\.json)\b/gi
// `(?:\s*[:=])?\s*`, not `\s*[:=]?\s*`: one way to split the gap, so a keyword
// followed by a long whitespace run is scanned once.
const SCREEN_RE =
  /(?:@image:|(?:\b(?:screenshot|saved|wrote|path)\b)(?:\s*[:=])?\s*)(\/opt\/data\/[^\s]+\.(?:png|jpe?g|webp|gif))/gi
const IMAGE_PATH_RE = /(\/opt\/data\/[^\s"'`]+\.(?:png|jpe?g|webp|gif))\b/gi
const HOSTED_RE = /https:\/\/[a-z0-9.-]+\.(?:vercel\.app|netlify\.app|railway\.app|pages\.dev|maiavm\.com|nub\.lol)(?:\/[^\s)'"]*)?/gi
/** Hosts a `hostedUrl` may point at: the platform's own domains plus the
 *  hosting platforms HOSTED_RE recognises. Mirrors HOSTED_RE's host list. */
const HOSTED_HOST_RE = /^(?:[a-z0-9-]+\.)+(?:vercel\.app|netlify\.app|railway\.app|pages\.dev|maiavm\.com|nub\.lol)$/i

/**
 * The href the "Open site" link may use, or null. https only (via
 * `safeLinkUrl`: no credentials, no javascript:/data:/nub-vm:), and only on a
 * HOSTED_HOST_RE host, so a stored or hand-crafted hostedUrl cannot send the
 * user to an arbitrary site.
 */
export function openableHostedUrl(raw?: string | null): string | null {
  const safe = safeLinkUrl(raw)
  if (!safe) return null
  try {
    const u = new URL(safe)
    if (u.protocol !== 'https:' || u.port) return null
    return HOSTED_HOST_RE.test(u.hostname) ? safe : null
  } catch {
    return null
  }
}
/**
 * `nub-publish` (the VM's bundled publisher, see hermes-deploy's nub-site
 * skill) prints `published: <dir>` then `url: <https url>`. That pair binds a
 * hosted URL to the exact directory, so it wins over the loose HOSTED_RE scan.
 * The URL is only taken on a platform host: Nub Sites (`<name>-xxxx-site.nub.lol`)
 * or the legacy per-VM artifact host (`*.nub.lol` / `*.maiavm.com`, used when
 * Nub Sites is off). Agent text is untrusted, so an arbitrary https host
 * after `url:` never becomes the card's "Open site" target.
 */
const PUBLISHED_RE = /published:\s*(\/opt\/data\/[^\s"'`\\]+)((?:(?!published:)[\s\S]){0,300}?)url:\s*(https:\/\/[a-z0-9.-]+\.(?:nub\.lol|maiavm\.com)(?=[/?#\s"'`)\\]|$)[^\s"'`)\\]*)/gi
const CREATE_VITE_RE = /(?:npm\s+create\s+vite|create-react-app|npm\s+run\s+dev|vite\s+--host)/i
const REACT_RE = /\breact\b/i
const INDEX_NAME = /index\.html/i
const DEV_SERVER_PORTS = new Set([5173, 4173, 3000, 3001])

export function isDevServerPort(port: number | undefined | null): port is number {
  return typeof port === 'number' && DEV_SERVER_PORTS.has(port)
}

function collectText(messages: ChatMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    if (msg.content) parts.push(msg.content)
    for (const ev of msg.toolEvents ?? []) {
      if (ev.args) parts.push(ev.args)
      if (ev.result) parts.push(ev.result)
      if (ev.summary) parts.push(ev.summary)
      if (ev.label) parts.push(ev.label)
    }
    for (const att of msg.attachments ?? []) {
      if (att.name) parts.push(att.name)
    }
  }
  return parts.join('\n')
}

function vmDirs(text: string): string[] {
  const out: string[] = []
  PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PATH_RE.exec(text))) {
    let p = m[1].replace(/[.,;:'")\]]+$/, '')
    if (!isVmWorkspacePath(p)) continue
    const name = basename(p)
    if (name.includes('.') && !name.startsWith('.')) p = dirname(p)
    if (!out.includes(p)) out.push(p)
  }
  return out
}

function firstPort(text: string): number | undefined {
  PORT_RE.lastIndex = 0
  let best: number | undefined
  let m: RegExpExecArray | null
  while ((m = PORT_RE.exec(text))) {
    const n = Number(m[1])
    if (!isDevServerPort(n)) continue
    best = n
    if (n === 5173 || n === 4173) return n
  }
  return best
}

function firstHostedUrl(text: string): string | undefined {
  HOSTED_RE.lastIndex = 0
  const m = HOSTED_RE.exec(text)
  return m?.[0]
}

/** Directory → public URL from `nub-publish` output, in transcript order. */
function publishedSites(text: string): Map<string, string> {
  const out = new Map<string, string>()
  PUBLISHED_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PUBLISHED_RE.exec(text))) {
    const dir = m[1].replace(/[.,;:'")\]]+$/, '').replace(/\/+$/, '')
    if (!isVmWorkspacePath(dir)) continue
    out.set(dir, m[3].replace(/[.,;:'")\]]+$/, ''))
  }
  return out
}

function screenshotPaths(text: string): string[] {
  const out: string[] = []
  SCREEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SCREEN_RE.exec(text))) {
    const raw = m[1]
    if (!raw) continue
    const path = raw.startsWith('/') ? raw : `/${raw}`
    if (!out.includes(path)) out.push(path)
  }
  IMAGE_PATH_RE.lastIndex = 0
  while ((m = IMAGE_PATH_RE.exec(text))) {
    const path = m[1].replace(/[.,;:'")\]]+$/, '')
    if (isVmWorkspacePath(path) && !out.includes(path)) out.push(path)
  }
  return out
}

function htmlFiles(text: string): string[] {
  const out: string[] = []
  HTML_FILE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HTML_FILE_RE.exec(text))) {
    const p = m[1].replace(/[.,;:]+$/, '')
    if (isVmWorkspacePath(p) && !out.includes(p)) out.push(p)
  }
  return out
}

function packageJsonFiles(text: string): string[] {
  const out: string[] = []
  PKG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PKG_RE.exec(text))) {
    const p = m[1].replace(/[.,;:]+$/, '')
    if (isVmWorkspacePath(p) && !out.includes(p)) out.push(p)
  }
  return out
}

function kindFor(text: string, html: string[]): ArtifactKind {
  const viteSignal = CREATE_VITE_RE.test(text) || /vite\.config/i.test(text)
  const vitePort = firstPort(text)
  if (viteSignal && (vitePort || html.length === 0)) return 'vite'
  if (REACT_RE.test(text) && (packageJsonFiles(text).length > 0 || CREATE_VITE_RE.test(text))) {
    return 'react'
  }
  if (html.length > 0 || INDEX_NAME.test(text)) return 'html'
  if (viteSignal) return 'vite'
  if (screenshotPaths(text).length > 0) return 'screenshot'
  return 'static'
}

function titleFor(kind: ArtifactKind, root: string): string {
  const name = basename(root) || 'project'
  if (kind === 'react') return `${name} (React)`
  if (kind === 'vite') return `${name} (Vite)`
  if (kind === 'html') return `${name} (HTML)`
  if (kind === 'screenshot') return 'Page screenshot'
  return name
}

/** Derive at most a few project cards from a conversation. */
function uniquePaths(paths: string[]): string[] {
  const out: string[] = []
  for (const p of paths) if (!out.includes(p)) out.push(p)
  return out
}

export function deriveProjectArtifacts(
  messages: ChatMessage[],
  cwd?: string | null,
): ProjectArtifact[] {
  const refs = fileRefsFromMessages(messages)
  const structuredWrites = refs.filter((r) => r.action !== 'read')
  const text = collectText(messages)
  const html = uniquePaths([
    ...structuredWrites.filter((r) => r.path.endsWith('.html')).map((r) => r.path),
    ...htmlFiles(text),
  ])
  const pkgs = uniquePaths([
    ...structuredWrites.filter((r) => r.path.endsWith('package.json')).map((r) => r.path),
    ...packageJsonFiles(text),
  ])
  const shots = screenshotPaths(text)
  const port = firstPort(text)
  const hostedUrl = firstHostedUrl(text)
  const published = publishedSites(text)
  const dirs = vmDirs(text)

  const roots = new Set<string>()
  for (const dir of published.keys()) roots.add(dir)
  for (const file of html) roots.add(dirname(file))
  for (const file of pkgs) roots.add(dirname(file))
  for (const dir of dirs) roots.add(dir)
  if (cwd && isVmWorkspacePath(cwd) && (html.length || pkgs.length || port || CREATE_VITE_RE.test(text))) {
    roots.add(cwd.replace(/\/+$/, ''))
  }
  if (roots.size === 0 && isVmWorkspacePath(cwd) && (INDEX_NAME.test(text) || CREATE_VITE_RE.test(text))) {
    roots.add(cwd.replace(/\/+$/, ''))
  }

  const artifacts: ProjectArtifact[] = []
  const kind = kindFor(text, html)
  const projectRoots = [...roots].filter(
    (root) => ![...roots].some((other) => other !== root && other.startsWith(`${root}/`)),
  )
  for (const root of projectRoots) {
    const publishedUrl = published.get(root)
    if (publishedUrl) {
      // nub-publish only ships static directories served from index.html, so
      // a published root is a static page whatever else the chat mentioned.
      const entry =
        html.find((f) => dirname(f) === root && INDEX_NAME.test(basename(f))) ??
        html.find((f) => dirname(f) === root) ??
        `${root}/index.html`
      artifacts.push({
        id: `proj:${root}`,
        kind: 'html',
        title: titleFor('html', root),
        rootPath: root,
        entryFile: entry,
        screenshotPath: shots[0],
        hostedUrl: publishedUrl,
      })
      continue
    }
    const entry = html.find((f) => f.startsWith(`${root}/`) || dirname(f) === root)
    const hasPkg = pkgs.some((f) => f.startsWith(`${root}/`) || dirname(f) === root)
    if (!entry && !hasPkg && kind !== 'vite' && kind !== 'react') continue
    artifacts.push({
      id: `proj:${root}`,
      kind: kind === 'screenshot' ? (port ? 'vite' : 'html') : kind,
      title: titleFor(kind === 'screenshot' ? 'html' : kind, root),
      rootPath: root,
      entryFile: entry,
      port: kind === 'html' ? undefined : port,
      screenshotPath: shots[0],
      hostedUrl,
    })
  }

  if (artifacts.length === 0 && shots.length > 0) {
    artifacts.push({
      id: `shot:${shots[0]}`,
      kind: 'screenshot',
      title: 'Page screenshot',
      rootPath: dirname(shots[0]),
      screenshotPath: shots[0],
      hostedUrl,
    })
  }

  if (artifacts.length === 0 && port) {
    const root = cwd && isVmWorkspacePath(cwd) ? cwd.replace(/\/+$/, '') : `${VM_ROOT}/workspace`
    artifacts.push({
      id: `port:${port}`,
      kind: 'vite',
      title: `Dev server :${port}`,
      rootPath: root,
      port,
      hostedUrl,
    })
  }

  return artifacts.slice(0, 4)
}

/**
 * Index of the first transcript message that produced an openable page.
 * Later turns (follow-ups, blank "Working…" bubbles) must not move the stack.
 *
 * C3 (docs/CHAT_LOAD_AND_MOTION_SPEC.md): the prefix scan derives artifacts
 * for every transcript prefix — O(n) full-text scans per call. Message
 * objects are immutable once appended (a content change mints a new object),
 * so each prefix's derive is cached on the prefix's LAST message: on the
 * next call every settled prefix is a WeakMap hit and only the new prefixes
 * compute.
 */
const prefixArtifactsCache = new WeakMap<
  ChatMessage,
  { cwd: string | null | undefined; artifacts: ProjectArtifact[] }
>()

function deriveProjectArtifactsForPrefix(
  messages: ChatMessage[],
  cwd?: string | null,
): ProjectArtifact[] {
  const last = messages[messages.length - 1]
  if (!last) return []
  const cached = prefixArtifactsCache.get(last)
  if (cached && cached.cwd === cwd) return cached.artifacts
  const artifacts = deriveProjectArtifacts(messages, cwd)
  prefixArtifactsCache.set(last, { cwd, artifacts })
  return artifacts
}

export function artifactAnchorIndex(
  messages: ChatMessage[],
  cwd?: string | null,
): number {
  if (!deriveProjectArtifactsForPrefix(messages, cwd).some(isOpenablePage)) return -1
  for (let i = 0; i < messages.length; i++) {
    if (deriveProjectArtifactsForPrefix(messages.slice(0, i + 1), cwd).some(isOpenablePage)) return i
  }
  return -1
}

// ChatPanel re-derives this per message on every render (including each
// streaming tick), and the scan concatenates full content + tool payloads
// before two global regex passes. Messages are immutable once appended, so a
// WeakMap cache skips the rescan for unchanged messages.
const screenshotPathsCache = new WeakMap<ChatMessage, string[]>()

export function screenshotPathsFromMessage(msg: ChatMessage): string[] {
  const cached = screenshotPathsCache.get(msg)
  if (cached) return cached
  // `MEDIA:` image tags come first (they are what the agent chose to show);
  // the rest of the reply is scanned with the tags already stripped.
  const media = msg.role === 'user' ? null : extractReplyMedia(msg.content)
  const parts = [media ? media.text : msg.content]
  for (const ev of msg.toolEvents ?? []) {
    if (ev.args) parts.push(ev.args)
    if (ev.result) parts.push(ev.result)
    if (ev.summary) parts.push(ev.summary)
  }
  for (const att of msg.attachments ?? []) {
    if (att.kind === 'image' && att.name.startsWith('/')) parts.push(att.name)
  }
  const out = media ? [...media.images] : []
  // A picture the reply shows as a markdown image already renders in place.
  const inline = markdownVmImagePaths(parts[0] ?? '')
  for (const path of screenshotPaths(parts.join('\n'))) {
    if (!out.includes(path) && !inline.includes(path) && !isPrivateVmPath(path)) out.push(path)
  }
  screenshotPathsCache.set(msg, out)
  return out
}

export function livePreviewUrl(artifact: ProjectArtifact): string | null {
  if (artifact.kind === 'html' && artifact.entryFile) {
    return `nub-vm://file${artifact.entryFile}`
  }
  if (artifact.port) return `nub-vm://p${artifact.port}/`
  if (artifact.kind === 'vite' || artifact.kind === 'react') return null
  if (artifact.entryFile) return `nub-vm://file${artifact.entryFile}`
  return null
}

/**
 * Hosted URL that can be framed in-app, or null.
 *
 * Only Nub Sites (`<name>-xxxx-site.nub.lol`): the sites Worker allows the Nub
 * apps as frame ancestors. Other hosts (vercel.app, the legacy per-VM
 * `app-agent-*` host…) send their own frame policy, so framing them would
 * show a browser error page instead of the site.
 */
const EMBEDDABLE_SITE_RE = /^https:\/\/[a-z0-9-]+-site\.nub\.lol(?:[/?#]|$)/i

export function embeddableSiteUrl(artifact: ProjectArtifact): string | null {
  const url = artifact.hostedUrl
  return url && EMBEDDABLE_SITE_RE.test(url) ? url : null
}

/** True when the artifact is a real page the user can scroll and click. */
export function isOpenablePage(artifact: ProjectArtifact): boolean {
  return livePreviewUrl(artifact) != null || embeddableSiteUrl(artifact) != null
}

/**
 * Host → the VM's own publisher. `nub-publish` hosts a static directory on
 * the platform (no account, no build, stays up while the VM is off), which is
 * what the bundled nub-site skill teaches the agent — so the Host button must
 * not steer it toward Vercel/Railway credentials the VM doesn't have.
 */
export function publishPrompt(artifact: ProjectArtifact): string {
  const where = artifact.rootPath
  const framework = artifact.kind === 'vite' || artifact.kind === 'react'
  return [
    `Publish the project at ${where} with \`nub-publish\` (see your nub-site skill).`,
    framework
      ? 'It is a framework app, so build it to static files first (e.g. `npm run build`) and publish the build output directory, not the source folder.'
      : 'Make sure it has an index.html at the top level first.',
    'Do it on this computer — do not tell me to run commands locally.',
    'When it is live, reply with the exact URL on its own line.',
  ].join(' ')
}

export function previewPrompt(artifact: ProjectArtifact): string {
  if ((artifact.kind === 'vite' || artifact.kind === 'react') && artifact.port) {
    return `The site is already on this VM at http://127.0.0.1:${artifact.port}/. Open it in Chromium on this computer and take a screenshot.`
  }
  const file = artifact.entryFile || `${artifact.rootPath}/index.html`
  return `Open ${file} in Chromium on this computer and take a screenshot.`
}
