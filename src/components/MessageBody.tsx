import '../styles/skin-messenger.css'
import {
  Children,
  Fragment,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { Components } from 'react-markdown'
import { fileCitationsIn } from '../lib/file-refs'
import { mentionSpans, type MentionMember } from '../lib/mentions'
import { useAgentIdentity } from './agent-identity'
import { lookTint } from '../lib/agents/identity'
import { brandMarkFor } from '../lib/brand-marks'
import { liftHtmlImages, safeImageUrl, safeLinkUrl, vmImagePath } from '../lib/safe-image-url'
import { viewerItemName } from '../lib/image-viewer'
import { useViewerEntry, LocalImage as VmShot, ZoomTrigger } from './LocalImage'
import { closeOpenFence, fencedCodeTail, splitMarkdownBlocks } from '../lib/markdown-blocks'
import { shortLinkLabel } from '../lib/link-preview'
import { ToolChipRow, type ToolChipEvent } from './chat/ToolChipRow'
import { GeneratedUi } from './genui/GeneratedUi'

/**
 * react-markdown + remark-gfm ride a separate chunk behind a dynamic import so
 * the main bundle never pays for the markdown parser. `mdCache` is the sync
 * fast path: once the chunk lands (preloaded below, refreshed by MarkdownView)
 * turns render markdown synchronously — streaming ones included; until then
 * the reader sees plain pre-wrap text, never a spinner.
 */
interface MarkdownModules {
  ReactMarkdown: ComponentType<{
    remarkPlugins: unknown[]
    rehypePlugins: unknown[]
    components: Components
    urlTransform: (url: string, key: string) => string
    children: string
  }>
  remarkGfm: unknown
  urlTransform: (url: string, key: string) => string
}

let mdCache: MarkdownModules | null = null
let mdInflight: Promise<MarkdownModules> | null = null

export function loadMarkdown(): Promise<MarkdownModules> {
  if (mdCache) return Promise.resolve(mdCache)
  if (!mdInflight) {
    mdInflight = Promise.all([import('react-markdown'), import('remark-gfm')]).then(
      ([rm, gfm]) => {
        const mods: MarkdownModules = {
          ReactMarkdown: rm.default as MarkdownModules['ReactMarkdown'],
          remarkGfm: (gfm.default ?? gfm) as unknown,
          // Image sources pass through untouched: react-markdown's default
          // drops data:/blob:/nub-vm: (and so agent pictures), and
          // MarkdownImage sanitizes every src itself (safeImageUrl /
          // vmImagePath). Links keep the default, then safeLinkUrl.
          urlTransform: (url, key) => (key === 'src' ? url : rm.defaultUrlTransform(url)),
        }
        mdCache = mods
        return mods
      },
    )
  }
  return mdInflight
}

// Warm the chunk at startup so the first finished turn rarely sees the plain
// fallback. Still a separate chunk — this only prefetches it in parallel.
if (typeof window !== 'undefined') {
  void loadMarkdown().catch(() => {
    mdInflight = null
  })
}

function Heading({
  Tag,
  children,
}: {
  Tag: 'h1' | 'h2' | 'h3' | 'h4'
  children?: ReactNode
}) {
  const mark = brandMarkFor(childText(children))
  return (
    <Tag className={mark ? 'nub-md-h nub-md-h--brand' : 'nub-md-h'}>
      {mark ? (
        <span
          className="nub-md-brand"
          title={mark.id}
          aria-hidden
          style={{
            backgroundColor: mark.color,
            WebkitMaskImage: `url(${mark.src})`,
            maskImage: `url(${mark.src})`,
          }}
        />
      ) : null}
      <span>{children}</span>
    </Tag>
  )
}

/** hast element, as much of it as the plugin below reads. */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** rehype: mark an image that is its paragraph's only content (a picture,
 *  not a logo in a line of text) with `data-solo`. */
function rehypeSoloImages() {
  const walk = (node: HastNode) => {
    if (node.type === 'element' && node.tagName === 'p' && node.children) {
      const content = node.children.filter(
        (c) => !(c.type === 'text' && !c.value?.trim()) && !(c.type === 'element' && c.tagName === 'br'),
      )
      const only = content.length === 1 ? content[0] : null
      if (only?.type === 'element' && only.tagName === 'img') {
        only.properties = { ...only.properties, dataSolo: true }
      }
    }
    node.children?.forEach(walk)
  }
  return (tree: HastNode) => walk(tree)
}
const rehypePlugins = [rehypeSoloImages]

/** A web or inlined picture in markdown: shimmer until it loads, a quiet
 *  fallback (alt text) if it can't, and a solo picture opens full size. */
function MarkdownWebImage({ href, alt, solo }: { href: string; alt: string; solo: boolean }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => setState('loading'), [href])
  const open = useViewerEntry(ref, solo && state === 'ready' ? { kind: 'url', url: href, name: alt || 'Image' } : null)
  if (state === 'failed') {
    return (
      <span className={solo ? 'nub-md-img-fallback nub-md-img-fallback--block' : 'nub-md-img-fallback'}>
        {solo ? `Image unavailable${alt ? ` · ${alt}` : ''}` : alt}
      </span>
    )
  }
  const img = (
    <img
      className={`nub-md-img ${solo ? `nub-md-img--block ${state === 'ready' ? 'nub-img-in' : 'min-h-24 min-w-40 skeleton-shine'}` : ''}`}
      src={href}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={() => setState('ready')}
      onError={() => setState('failed')}
    />
  )
  if (!solo) return img
  return (
    <span ref={ref} className="block">
      {open && state === 'ready' ? (
        <ZoomTrigger name={alt || 'Image'} onOpen={open}>
          {img}
        </ZoomTrigger>
      ) : (
        img
      )}
    </span>
  )
}

function MarkdownImage({ src, alt, node }: { src?: string; alt?: string; node?: HastNode }) {
  const solo = Boolean(node?.properties?.dataSolo)
  // A picture on the agent computer is read through the VM bridge, like a
  // `MEDIA:` tag, instead of loading `/opt/data/…` from the app's origin.
  const vmPath = vmImagePath(src)
  if (vmPath) {
    return solo ? (
      <VmShot path={vmPath} alt={alt || viewerItemName(vmPath)} zoom />
    ) : (
      <VmShot path={vmPath} alt={alt || viewerItemName(vmPath)} className="nub-md-img" inline />
    )
  }
  const href = safeImageUrl(src)
  if (!href) {
    return alt ? <span className="nub-md-img-fallback">{alt}</span> : null
  }
  return <MarkdownWebImage key={href} href={href} alt={alt ?? ''} solo={solo} />
}

function childText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(childText).join('')
  if (isValidElement(node) && node.props && typeof node.props === 'object' && 'children' in node.props) {
    return childText((node.props as { children?: ReactNode }).children)
  }
  return ''
}

function fenceLang(className?: string): string {
  const m = /language-([\w+-]+)/.exec(className ?? '')
  return m?.[1] ?? ''
}

function FencedCode({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        if (timer.current !== null) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1400)
      },
      () => {
        setCopied(false)
      },
    )
  }, [text])
  return (
    <div className="nub-md-code">
      <div className="nub-md-code-bar">
        <span className="nub-md-code-lang">{lang || 'code'}</span>
        <button type="button" onClick={copy} className="nub-md-code-copy" aria-live="polite">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{text.replace(/\n$/, '')}</code>
      </pre>
    </div>
  )
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find((c) => isValidElement(c))
  const props = isValidElement(code)
    ? (code.props as { className?: string; children?: ReactNode })
    : {}
  return <FencedCode lang={fenceLang(props.className)} text={childText(props.children ?? children)} />
}

function citeText(
  text: string,
  onOpenFile?: (path: string, lineStart?: number) => void,
): ReactNode {
  if (!onOpenFile) return text
  const cites = fileCitationsIn(text)
  if (cites.length === 0) return text
  const parts: ReactNode[] = []
  let cursor = 0
  cites.forEach((cite, i) => {
    const at = text.indexOf(cite.raw, cursor)
    if (at < 0) return
    if (at > cursor) parts.push(text.slice(cursor, at))
    parts.push(
      <button
        key={`${cite.path}:${i}`}
        type="button"
        className="font-mono text-[var(--ca-primary-text)] underline-offset-2 hover:underline"
        onClick={() => onOpenFile(cite.path, cite.lineStart)}
      >
        {cite.raw}
      </button>,
    )
    cursor = at + cite.raw.length
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

/** One `@Name` in a message: the member's own colors, and a tap opens its
 *  profile card (ChatPanel's identity provider). On the blue user bubble it
 *  stays white and underlined so it reads on the bubble. */
function MentionChip({ id, text, onUser }: { id: string; text: string; onUser: boolean }) {
  const { lookOf, openProfile } = useAgentIdentity()
  const look = id === '*' ? null : lookOf(id)
  const cls = onUser
    ? 'nub-mention rounded px-0.5 font-semibold underline decoration-white/60 underline-offset-2'
    : `nub-mention rounded px-1 font-medium ${look ? '' : 'bg-[var(--ca-primary-soft)] text-[var(--ca-primary-text)]'}`
  // --chip-body: dark mode re-tints it like the agent chip (index.css).
  const style =
    !onUser && look
      ? ({ backgroundColor: lookTint(look), color: look.eye, '--chip-body': look.body } as CSSProperties)
      : undefined
  if (openProfile && id !== '*') {
    return (
      <button
        type="button"
        data-mention={id}
        title="About this member"
        onClick={(e) => {
          e.stopPropagation()
          openProfile(id, e.currentTarget)
        }}
        className={`${cls} cursor-pointer align-baseline hover:ring-1 hover:ring-current`}
        style={style}
      >
        {text}
      </button>
    )
  }
  return (
    <span data-mention={id} className={cls} style={style}>
      {text}
    </span>
  )
}

/** Group rooms: `@Name` tokens for room members render as mention chips
 *  (same rule as the server's router, lib/mentions.ts); the rest of the
 *  text keeps file-citation linking. */
function decorateText(
  text: string,
  onOpenFile: ((path: string, lineStart?: number) => void) | undefined,
  mentions: MentionMember[] | undefined,
  onUser: boolean,
): ReactNode {
  const spans = mentions?.length ? mentionSpans(text, mentions) : []
  if (spans.length === 0) return citeText(text, onOpenFile)
  const parts: ReactNode[] = []
  let cursor = 0
  spans.forEach((sp, i) => {
    if (sp.start > cursor) parts.push(<Fragment key={`t${i}`}>{citeText(text.slice(cursor, sp.start), onOpenFile)}</Fragment>)
    parts.push(<MentionChip key={`m${i}`} id={sp.id} text={text.slice(sp.start, sp.end)} onUser={onUser} />)
    cursor = sp.end
  })
  if (cursor < text.length) parts.push(<Fragment key="tail">{citeText(text.slice(cursor), onOpenFile)}</Fragment>)
  return parts
}

function CiteWrap({
  children,
  onOpenFile,
  mentions,
}: {
  children?: ReactNode
  onOpenFile?: (path: string, lineStart?: number) => void
  mentions?: MentionMember[]
}) {
  return (
    <>
      {Children.map(children, (child) =>
        typeof child === 'string' ? decorateText(child, onOpenFile, mentions, false) : child,
      )}
    </>
  )
}

/** Preferred break points inside an inline code span: after path/identifier
 *  separators, never mid-token. */
const CODE_BREAK_SEP = /([/\\\-_.@:?&=])/

/** Inline code.
 *
 *  `.nub-md` sets `overflow-wrap: anywhere` so an unbroken URL or hash can't
 *  blow out the thread. That also makes EVERY character a break opportunity,
 *  and the browser fills each line maximally — so a path rendered as
 *  `index.h` / `tml` instead of breaking at a slash. Here the separators get
 *  an explicit `<wbr>`, and the CSS drops inline code to `overflow-wrap:
 *  break-word`, which only splits mid-token when a single segment still can't
 *  fit. Fenced blocks keep their own path (MarkdownPre → FencedCode). */
function InlineCode({ children, className }: { children?: ReactNode; className?: string }) {
  const text = childText(children)
  // Fenced code arrives with a language-* class; leave it to MarkdownPre.
  if (className?.includes('language-') || text.includes('\n')) {
    return <code className={className}>{children}</code>
  }
  const parts = text.split(CODE_BREAK_SEP)
  return (
    <code className={className}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Fragment key={i}>
            {part}
            <wbr />
          </Fragment>
        ) : (
          part
        ),
      )}
    </code>
  )
}

const markdownComponents: Components = {
  pre: MarkdownPre,
  code: InlineCode,
  img: MarkdownImage as Components['img'],
  h1: ({ children }: { children?: ReactNode }) => <Heading Tag="h1">{children}</Heading>,
  h2: ({ children }: { children?: ReactNode }) => <Heading Tag="h2">{children}</Heading>,
  h3: ({ children }: { children?: ReactNode }) => <Heading Tag="h3">{children}</Heading>,
  h4: ({ children }: { children?: ReactNode }) => <Heading Tag="h4">{children}</Heading>,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    const safe = safeLinkUrl(href)
    if (!safe) return <span>{children}</span>
    // A link whose text is its own URL reads as a short host/path label (the
    // full URL is in the tooltip and the preview card under the reply).
    const text = childText(children).trim()
    const short = text && (text === href || text === safe) ? shortLinkLabel(safe) : null
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer" title={short ? safe : undefined}>
        {short ?? children}
      </a>
    )
  },
}

/** The markdown chunk, or null until it lands (the caller paints plain text
 *  meanwhile — same look as the old streaming path, no spinner). */
function useMarkdownModules(): MarkdownModules | null {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (mdCache) return
    let live = true
    void loadMarkdown().then(
      () => {
        if (live) bump()
      },
      () => {
        mdInflight = null
      },
    )
    return () => {
      live = false
    }
  }, [])
  return mdCache
}

/** One parsed chunk of a body (src/lib/markdown-blocks.ts). Memoized on its
 *  text, so a streaming tick or a settle leaves every unchanged chunk's DOM
 *  alone. Renders bare block elements (no wrapper) so `.nub-md > :first-child`
 *  and sibling spacing see the same flat list as a whole-body parse. */
const MdChunk = memo(function MdChunk({
  text,
  components,
  mods,
}: {
  text: string
  components: Components
  mods: MarkdownModules
}) {
  const { ReactMarkdown, remarkGfm } = mods
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      components={components}
      urlTransform={mods.urlTransform}
    >
      {text}
    </ReactMarkdown>
  )
})

/** A streaming tail longer than this (one long paragraph, a big code block)
 *  re-parses on a timer instead of on every token. The interval grows with
 *  the tail (≈10ms per 100 chars, 100–400ms): parse cost is linear in its
 *  length, so the share of the main thread it takes stays bounded instead of
 *  climbing as a long paragraph grows. */
const TAIL_THROTTLE_AT = 800
function tailThrottleMs(length: number): number {
  return Math.min(400, Math.max(100, length / 10))
}

function useThrottledTail(text: string, throttle: boolean, startKey: number): string {
  const [shown, setShown] = useState({ key: startKey, text })
  const lastAt = useRef(0)
  useEffect(() => {
    if (shown.key === startKey && shown.text === text) return
    const now = performance.now()
    const wait = throttle && shown.key === startKey ? tailThrottleMs(text.length) - (now - lastAt.current) : 0
    const apply = () => {
      lastAt.current = performance.now()
      setShown({ key: startKey, text })
    }
    if (wait <= 0) {
      apply()
      return
    }
    const t = window.setTimeout(apply, wait)
    return () => window.clearTimeout(t)
  }, [text, throttle, startKey, shown])
  // A new tail block (the previous one just joined a chunk) shows at once:
  // the stale snapshot would repeat text the chunk above already renders.
  if (!throttle || shown.key !== startKey) return text
  return shown.text
}

/**
 * Markdown for a body, streaming or settled, split into prefix-stable chunks
 * (src/lib/markdown-blocks.ts). While a reply streams only its growing last
 * block re-parses; when it settles, only the last chunk does. The bubble no
 * longer flips from plain text to formatted markdown on the settle frame —
 * that flip reflowed the whole reply and made the transcript jump.
 */
function MarkdownView({
  content,
  components,
  streaming = false,
}: {
  content: string
  components: Components
  streaming?: boolean
}) {
  const mods = useMarkdownModules()
  const { chunks, tail } = useMemo(() => splitMarkdownBlocks(content, streaming), [content, streaming])
  // A code block streaming in renders straight through FencedCode — same
  // element the parser would produce, no parse, no throttle.
  const codeTail = useMemo(() => (streaming && components.pre === MarkdownPre ? fencedCodeTail(tail) : null), [
    streaming,
    tail,
    components,
  ])
  const tailText = useThrottledTail(
    tail,
    streaming && !codeTail && tail.length > TAIL_THROTTLE_AT,
    content.length - tail.length,
  )
  const tailShown = useMemo(() => (tailText.trim() ? closeOpenFence(tailText) : ''), [tailText])
  if (!mods) {
    return <p className="whitespace-pre-wrap break-words">{content.trimEnd()}</p>
  }
  return (
    <div className="nub-md">
      {chunks.map((chunk, i) => (
        <MdChunk key={i} text={chunk} components={components} mods={mods} />
      ))}
      {codeTail ? (
        <FencedCode key="tail-code" lang={codeTail.lang} text={codeTail.code} />
      ) : (
        tailShown && <MdChunk key="tail" text={tailShown} components={components} mods={mods} />
      )}
    </div>
  )
}

/** Oversized turns (>20KB — usually a dumped log or doc) paint only a head
 *  preview until the reader opens the native disclosure. The full body never
 *  mounts while closed, so a megabyte paste costs a few dozen nodes. */
const COLLAPSE_AT = 20 * 1024
const COLLAPSE_PREVIEW = 4000

function Markdown({
  content,
  streaming = false,
  onOpenFile,
  mentions,
}: {
  content: string
  streaming?: boolean
  onOpenFile?: (path: string, lineStart?: number) => void
  mentions?: MentionMember[]
}) {
  const components = useMemo(() => {
    if (!onOpenFile && !mentions?.length) return markdownComponents
    const wrap = (Tag: 'p' | 'li' | 'td') =>
      function Cited({ children }: { children?: ReactNode }) {
        const El = Tag
        return (
          <El>
            <CiteWrap onOpenFile={onOpenFile} mentions={mentions}>
              {children}
            </CiteWrap>
          </El>
        )
      }
    return {
      ...markdownComponents,
      p: wrap('p'),
      li: wrap('li'),
      td: wrap('td'),
    }
  }, [onOpenFile, mentions])
  // liftHtmlImages walks the whole body with regexes — memoize so streaming
  // parents re-rendering around a settled turn don't repay it every tick.
  const lifted = useMemo(() => liftHtmlImages(content), [content])
  // A live reply is never collapsed mid-stream (it would snap shut under the
  // reader); the disclosure applies once it settles.
  const collapsed = !streaming && lifted.length > COLLAPSE_AT
  const [open, setOpen] = useState(false)
  if (!collapsed) {
    return <MarkdownView content={lifted} components={components} streaming={streaming} />
  }
  const shown = open ? lifted : lifted.slice(0, COLLAPSE_PREVIEW)
  const kb = (lifted.length / 1024).toFixed(0)
  return (
    <div>
      <MarkdownView content={shown} components={components} />
      <details
        className="nub-md-more"
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary>{open ? 'Show less' : `Show more · ${kb} KB message`}</summary>
      </details>
    </div>
  )
}

/**
 * C4 (docs/CHAT_LOAD_AND_MOTION_SPEC.md): a long settled body that MOUNTS
 * away from the reader (the top of a freshly opened 60-row window, a Find
 * mount) parses its markdown off the paint frame, in an idle callback.
 *
 * What the reader can see never waits: a row on screen — or within a
 * viewport and a half of the bottom, where a freshly opened chat lands —
 * parses in the mount's layout pass, before the first paint, so it never
 * shows plain text that then reflows into markdown. Everything else upgrades
 * once it comes within a viewport of the visible area, while still offscreen
 * (scroll anchoring absorbs the height change), so scrolling up does not
 * watch rows reformat either. Bodies <=2KB always parse inline.
 */
const MD_DEFER_AT = 2048

function useIdleMarkdownReady(
  rootRef: { current: HTMLParagraphElement | null },
  defer: boolean,
): boolean {
  const [ready, setReady] = useState(!defer)
  useLayoutEffect(() => {
    if (!defer) {
      if (!ready) setReady(true)
      return
    }
    if (ready) return
    const el = rootRef.current
    const scroller = el?.closest('.overflow-y-auto')
    if (!el || !(scroller instanceof HTMLElement)) {
      setReady(true)
      return
    }
    // Visible, or near the bottom of the transcript (where a chat opens and
    // stick-to-bottom pins right after this commit): parse before paint.
    const row = el.closest('[data-message-id]') ?? el
    const box = row.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    const bottomInContent = box.bottom - view.top + scroller.scrollTop
    const fromBottom = scroller.scrollHeight - bottomInContent
    const onScreen = box.bottom > view.top && box.top < view.bottom
    if (onScreen || fromBottom <= scroller.clientHeight * 1.5) {
      setReady(true)
      return
    }
    let live = true
    let io: IntersectionObserver | null = null
    let idleId: number | null = null
    const upgrade = () => {
      idleId = null
      if (live) setReady(true)
    }
    const queue = () => {
      if (typeof requestIdleCallback === 'function') {
        idleId = requestIdleCallback(upgrade, { timeout: 500 }) as unknown as number
      } else {
        idleId = window.setTimeout(upgrade, 0)
      }
    }
    const cancel = () => {
      if (idleId === null) return
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idleId)
      else window.clearTimeout(idleId)
      idleId = null
    }
    if (typeof IntersectionObserver === 'undefined') {
      queue()
      return () => {
        live = false
        cancel()
      }
    }
    // Observe the ROW (it keeps a layout box under content-visibility; its
    // skipped children may not), with a one-viewport margin so the upgrade
    // lands before the row scrolls into view.
    io = new IntersectionObserver(
      (entries) => {
        const near = entries.some((e) => e.isIntersecting)
        if (near && idleId === null) queue()
        if (!near && idleId !== null) cancel()
      },
      { root: scroller, rootMargin: '100% 0px 100% 0px' },
    )
    io.observe(row)
    return () => {
      live = false
      cancel()
      io?.disconnect()
    }
  }, [defer, ready, rootRef])
  return ready
}

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch)

/** `\s*\|?\s*:?---` at `i`, deterministically (the regex form backtracked). */
function tableDelimiterAt(s: string, i: number): boolean {
  while (isSpace(s[i])) i++
  if (s[i] === '|') { i++; while (isSpace(s[i])) i++ }
  if (s[i] === ':') i++
  return s.startsWith('---', i)
}

/**
 * Wide renderers keep their existing sanitizers and get the pane's width.
 * Same contract as /(^|\n)\s*(```|~~~)|(^|\n)\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}|\$\$|\\\[/m,
 * which re-ran on every streamed render and went super-linear on blank or
 * padded stretches: a fence after a line's horizontal indent, a `\n`-ended
 * line with an inner `|` followed by a delimiter row, or display math.
 */
export function messageHasWideContent(content: string): boolean {
  if (content.includes('$$') || content.includes('\\[')) return true
  if (/^[^\S\n\r\u2028\u2029]*(?:```|~~~)/m.test(content)) return true
  const lineBreak = /[\n\r\u2028\u2029]/g
  let start = 0
  for (let m = lineBreak.exec(content); m; m = lineBreak.exec(content)) {
    const line = content.slice(start, m.index)
    if (m[0] === '\n' && line.slice(1, -1).includes('|') && tableDelimiterAt(content, m.index + 1)) return true
    start = m.index + 1
  }
  return false
}

export const MessageBody = memo(function MessageBody({
  content,
  variant,
  streaming,
  onOpenFile,
  mentions,
  onUser = false,
  skin = 'classic',
  reasoning,
  toolEvents,
  genuiScope,
}: {
  content: string
  variant: 'plain' | 'markdown'
  streaming?: boolean
  onOpenFile?: (path: string, lineStart?: number) => void
  /** Group room members: their `@Name` tokens render as mention chips. */
  mentions?: MentionMember[]
  /** Text sits on the blue user bubble (mention chips use a light style). */
  onUser?: boolean
  skin?: 'messenger' | 'classic'
  reasoning?: string
  toolEvents?: ToolChipEvent[]
  genuiScope?: string
}) {
  const rootRef = useRef<HTMLParagraphElement | null>(null)
  // Mount-time only: a body that streams in renders markdown as it grows
  // (and settles in place), so only a long row mounting already settled can
  // defer. A deferred row that starts streaming again stops deferring.
  const [defer, setDefer] = useState(
    () => variant === 'markdown' && !streaming && content.length > MD_DEFER_AT && Boolean(content.trim()),
  )
  if (defer && streaming) setDefer(false)
  const ready = useIdleMarkdownReady(rootRef, defer)
  const live = content.trimEnd()
  const body = variant === 'markdown' && content.trim() && (streaming || ready)
    ? <Markdown content={content} streaming={streaming === true} onOpenFile={onOpenFile} mentions={mentions} />
    : live
      ? <p ref={rootRef} className="whitespace-pre-wrap break-words">{decorateText(live, onOpenFile, mentions, onUser)}</p>
      : null
  const widgets = !onUser && <GeneratedUi events={toolEvents} scope={genuiScope} />
  if (skin !== 'messenger') return <>{body}{widgets}</>
  return (
    <div className="messenger-body">
      {reasoning && (
        <details className="messenger-thinking">
          <summary>{streaming ? 'Thinking…' : 'Reasoning'}</summary>
          <p>{reasoning}</p>
        </details>
      )}
      {toolEvents && <ToolChipRow events={toolEvents} />}
      {body}
      {widgets}
      {streaming && <span className="messenger-streaming-caret" aria-hidden="true" />}
    </div>
  )
})
