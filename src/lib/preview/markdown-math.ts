/**
 * Mermaid + katex renderers for FilePreview (A3).
 *
 * Both libraries enter the bundle only through these lazy `import()`s, so the
 * main chunk never pays for them. Rendering is pure: string in, SVG/HTML out.
 *
 * SECURITY (L4, defense-in-depth): mermaid is initialized with
 * `securityLevel:'strict'` and katex with `throwOnError:false` +
 * `output:'html'` — but library guarantees are a single layer. Every string
 * these renderers produce now passes DOMPurify (`sanitizeRichOutput`) before
 * it reaches the two `dangerouslySetInnerHTML` sites in FilePreview
 * (MermaidBlock/MathBlock). Scripts, event handlers and javascript: URLs are
 * stripped even if a future library regression emits them. Raw markdown never
 * hits `dangerouslySetInnerHTML`; it goes through ReactMarkdown + remarkGfm
 * without rehype-raw.
 */

/**
 * L4: last-line sanitizer for rich renderer output. Profiles differ because
 * the two renderers emit different markup:
 *  - 'katex' → HTML profile (spans/divs with class + inline style)
 *  - 'mermaid' → SVG profile (+foreignObject; strict mode renders escaped
 *    text labels through it)
 * Scripts, event handlers and javascript: URLs are stripped in both.
 */
export async function sanitizeRichOutput(
  html: string,
  kind: 'katex' | 'mermaid',
): Promise<string> {
  const DOMPurify = (await import('dompurify')).default
  if (kind === 'mermaid') {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ['foreignObject'],
      ADD_ATTR: ['target'],
    })
  }
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  })
}

export interface MarkdownSegment {
  kind: 'text' | 'mermaid' | 'math'
  content: string
}

const MERMAID_FENCE_RE = /(^|\n)```mermaid[^\n]*\n([\s\S]*?)```(?=\n|$)/g
const MATH_BLOCK_RE = /\$\$([\s\S]+?)\$\$/g

/** True when the document contains at least one ```mermaid fence. */
export function hasMermaidFence(text: string): boolean {
  MERMAID_FENCE_RE.lastIndex = 0
  return MERMAID_FENCE_RE.test(text)
}

/** True when the document contains $$…$$ display-math blocks (or is .tex). */
export function hasMathBlocks(text: string): boolean {
  MATH_BLOCK_RE.lastIndex = 0
  return MATH_BLOCK_RE.test(text)
}

/**
 * Split a markdown-ish document into text / mermaid / math segments so the
 * renderer can paint fenced diagrams and display math without a full AST.
 * Unmatched text stays plain markdown (MessageBody-style rendering upstream).
 */
export function splitMarkdownSegments(text: string): MarkdownSegment[] {
  type Marker = { start: number; end: number; kind: 'mermaid' | 'math'; body: string }
  const markers: Marker[] = []

  MERMAID_FENCE_RE.lastIndex = 0
  for (let m = MERMAID_FENCE_RE.exec(text); m; m = MERMAID_FENCE_RE.exec(text)) {
    markers.push({
      start: m.index,
      end: m.index + m[0].length,
      kind: 'mermaid',
      body: (m[2] ?? '').trim(),
    })
  }
  MATH_BLOCK_RE.lastIndex = 0
  for (let m = MATH_BLOCK_RE.exec(text); m; m = MATH_BLOCK_RE.exec(text)) {
    // Skip math ranges already claimed by a mermaid fence (never overlaps in
    // practice, but keep the invariant cheap).
    const start = m.index
    if (markers.some((k) => start >= k.start && start < k.end)) continue
    markers.push({
      start,
      end: start + m[0].length,
      kind: 'math',
      body: (m[1] ?? '').trim(),
    })
  }
  markers.sort((a, b) => a.start - b.start)

  const segments: MarkdownSegment[] = []
  let cursor = 0
  for (const marker of markers) {
    if (marker.start > cursor) {
      segments.push({ kind: 'text', content: text.slice(cursor, marker.start) })
    }
    segments.push({ kind: marker.kind, content: marker.body })
    cursor = marker.end
  }
  if (cursor < text.length) {
    segments.push({ kind: 'text', content: text.slice(cursor) })
  }
  return segments.filter((s) => s.kind !== 'text' || s.content.trim().length > 0)
}

type MermaidApi = {
  initialize: (config: { startOnLoad: boolean; securityLevel: string; theme: string }) => void
  render: (id: string, code: string) => Promise<{ svg: string }>
}

let mermaidPromise: Promise<MermaidApi> | null = null

/**
 * Diagram kinds rendered in practice (repo fences + docs: `graph` /
 * `flowchart`; plus `sequenceDiagram`). mermaid.core lazy-loads one chunk
 * per kind on first render of that kind, so gating here is what keeps every
 * other diagram chunk off the network entirely. Anything else throws and the
 * FilePreview MermaidBlock falls back to the fenced source (never blank).
 */
const MERMAID_ALLOW_RE = /^\s*(?:flowchart|graph|sequenceDiagram)\b/

async function mermaidApi(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import(
      /* @viteChunkName: "mermaid" */ 'mermaid/dist/mermaid.core.mjs'
    ).then((mod) => {
      const mermaid = (mod as unknown as { default: MermaidApi }).default
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
      })
      return mermaid
    })
  }
  return mermaidPromise
}

/** Render a mermaid diagram definition to an SVG string. Throws on bad syntax. */
export async function renderMermaidSvg(code: string): Promise<string> {
  if (!MERMAID_ALLOW_RE.test(code)) {
    throw new Error(`unsupported mermaid kind (flowchart + sequence only): ${code.slice(0, 32)}`)
  }
  const mermaid = await mermaidApi()
  const id = `mmd-${Math.random().toString(36).slice(2)}`
  const { svg } = await mermaid.render(id, code)
  return sanitizeRichOutput(svg, 'mermaid')
}

/** Render a TeX fragment to katex HTML. Invalid TeX renders red inline, not throw. */
export async function renderMathHtml(tex: string, displayMode = true): Promise<string> {
  // KaTeX emits unstyled spans/classes without its stylesheet — no katex.css
  // anywhere in src, so fractions/roots mis-stack. Lazy so the CSS loads
  // only when a $$ block actually renders (Vite injects it on import).
  const [{ default: katex }] = await Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ])
  const html = katex.renderToString(tex, { displayMode, throwOnError: false, output: 'html' })
  return sanitizeRichOutput(html, 'katex')
}
