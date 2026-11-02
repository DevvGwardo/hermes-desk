/**
 * Adversarial markdown tests — render the EXACT component/pipeline
 * ChatPanel uses for agent replies (src/components/MessageBody.tsx:
 * liftHtmlImages → react-markdown + remark-gfm, no rehype-raw) with
 * hostile payloads.
 *
 * Observed pipeline behavior under test (asserted as the SAFE contract):
 *   - raw HTML is never parsed into DOM (react-markdown without
 *     rehype-raw renders it as text) → no <script>, no inline handlers
 *   - MessageBody's `a` renderer runs safeLinkUrl: a link whose scheme is
 *     not http(s)/mailto is downgraded to inert <span> text (no <a>, no
 *     href), so javascript:/data:/file: links are never navigable
 *   - liftHtmlImages drops any <img> whose src fails safeImageUrl;
 *     data:image/*;base64 ≤2MB IS allowed by design (CSP img-src data:)
 *     and renders — asserted as the observed, intentional behavior.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { MessageBody } from '../../src/components/MessageBody'

afterEach(() => {
  cleanup()
})

/** Render content through the real MessageBody markdown pipeline, timed. */
function timedRender(content: string): { container: HTMLElement; ms: number } {
  const t0 = performance.now()
  const { container } = render(
    createElement(MessageBody, { content, variant: 'markdown' }),
  )
  return { container, ms: performance.now() - t0 }
}

function allElements(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('*'))
}

function findScriptTag(container: HTMLElement): Element | null {
  return container.querySelector('script')
}

function inlineHandlerAttrs(container: HTMLElement): string[] {
  const bad: string[] = []
  for (const el of allElements(container)) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) bad.push(`${el.tagName}[${attr.name}]`)
    }
  }
  return bad
}

function hrefs(container: HTMLElement): string[] {
  return allElements(container)
    .map((el) => el.getAttribute('href'))
    .filter((h): h is string => h !== null)
}

describe('MessageBody XSS payloads', () => {
  it('does not execute or mount <script> tags', () => {
    const { container, ms } = timedRender(
      '<script>alert(1)</script>\n\n<script src="https://evil.example/x.js"></script>',
    )
    expect(findScriptTag(container)).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
    expect(ms).toBeLessThan(2_000)
  })

  it('never emits javascript: hrefs from markdown links', () => {
    const { container, ms } = timedRender(
      '[click me](javascript:alert(1))\n\n[upper](JAVASCRIPT:alert(1))\n\n[entity](java&#115;cript:alert(1))',
    )
    const jsHrefs = hrefs(container).filter((h) =>
      h.toLowerCase().includes('javascript'),
    )
    expect(jsHrefs).toEqual([])
    // safeLinkUrl downgrades each unsafe link to inert text: no <a> mounts
    // at all. Asserted directly, since "no javascript href" alone would also
    // pass vacuously when no anchor renders.
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('click me')
    expect(ms).toBeLessThan(2_000)
  })

  it('strips <img onerror> handlers entirely', () => {
    const { container, ms } = timedRender(
      '<img src=x onerror=alert(1)>\n\n<img src="x" onerror="alert(1)">',
    )
    // safeImageUrl rejects the relative "x" src, so liftHtmlImages removes
    // the tag wholesale — no img element, no handler attribute anywhere.
    expect(container.querySelector('img')).toBeNull()
    expect(inlineHandlerAttrs(container)).toEqual([])
    expect(ms).toBeLessThan(2_000)
  })

  it('blocks data:/javascript:/file: links and non-raster image sources; capped inline raster is allowed', () => {
    const { container, ms } = timedRender(
      [
        '[payload](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
        // MessageBody passes `src` through untouched (see urlTransform in
        // MessageBody.tsx) and safeImageUrl allows a byte-capped raster
        // data: image (src/lib/safe-image-url.ts, CSP img-src data:) — but
        // never svg or any other scheme. Asserted as the real contract.
        '![px](data:image/png;base64,iVBORw0KGgo=)',
        '![svg](data:image/svg+xml;base64,PHN2Zy8+)',
        '![js](javascript:alert(1))',
        '![file](file:///etc/passwd)',
      ].join('\n\n'),
    )
    // No href may navigate to a script/data/file scheme (safeLinkUrl).
    expect(
      hrefs(container).filter((h) => /^(data|javascript|file|blob|vbscript):/i.test(h)),
    ).toEqual([])
    // safeLinkUrl downgrades the data: link to inert text: no anchor mounts.
    expect(container.querySelector('a')).toBeNull()
    // The capped inline raster renders (observed, intentional).
    expect(container.querySelector('img[src^="data:image/png"]')).not.toBeNull()
    // Non-raster or script-bearing sources never mount an image.
    expect(container.querySelector('img[src^="data:image/svg"]')).toBeNull()
    expect(container.querySelector('img[src^="javascript:"]')).toBeNull()
    expect(container.querySelector('img[src^="file:"]')).toBeNull()
    expect(inlineHandlerAttrs(container)).toEqual([])
    expect(ms).toBeLessThan(2_000)
  })
})

describe('MessageBody adversarial volume/structure', () => {
  it('survives ≥500-deep blockquote nesting without crashing', () => {
    const depth = 500
    const payload = `${'>'.repeat(depth)} deep secret`
    const { container, ms } = timedRender(payload)
    expect(container.textContent).toContain('deep secret')
    expect(allElements(container).some((el) => el.tagName === 'BLOCKQUOTE')).toBe(true)
    expect(ms).toBeLessThan(2_000)
  })

  it('survives deep list nesting without crashing (full render below the collapse threshold)', () => {
    // Kept under MessageBody's COLLAPSE_AT (20KB) so the whole list renders
    // rather than the collapsed preview; still proves deep nesting is safe.
    const depth = 60
    const lines: string[] = []
    for (let i = 0; i < depth; i++) lines.push(`${'  '.repeat(i)}- level ${i}`)
    const payload = lines.join('\n')
    expect(payload.length).toBeLessThan(20 * 1024)
    const { container, ms } = timedRender(payload)
    expect(container.textContent).toContain(`level ${depth - 1}`)
    expect(allElements(container).filter((el) => el.tagName === 'LI').length).toBeGreaterThanOrEqual(depth)
    expect(ms).toBeLessThan(10_000)
  })

  it('bounds an oversized (~250KB) deeply-nested body to the collapse preview', () => {
    // 500-deep indentation is ~250KB of markdown: past COLLAPSE_AT, so
    // MessageBody.tsx mounts only the 4000-char preview behind a native
    // disclosure. The hostile body cannot mount an unbounded DOM; the tail
    // is intentionally behind the disclosure, not rendered inline.
    const depth = 500
    const lines: string[] = []
    for (let i = 0; i < depth; i++) lines.push(`${'  '.repeat(i)}- level ${i}`)
    const { container, ms } = timedRender(lines.join('\n'))
    expect(container.querySelector('details.nub-md-more')).not.toBeNull()
    expect(allElements(container).length).toBeLessThan(5_000)
    expect(ms).toBeLessThan(10_000)
  })

  it('renders a 1MB single-token paragraph within time budget (collapsed, bounded DOM)', () => {
    const token = 'A'.repeat(1_000_000)
    const { container, ms } = timedRender(token)
    // >COLLAPSE_AT settles collapsed: only the bounded head preview mounts.
    expect(container.querySelector('details.nub-md-more')).not.toBeNull()
    expect(container.textContent!.length).toBeLessThan(20_000)
    expect(container.textContent).toContain('AAAAA')
    expect(ms).toBeLessThan(2_000)
  })

  it('renders RTL text, ZWJ emoji sequences, and zero-width characters', () => {
    const payload = [
      'مرحبا بالعالم — שלום עולם',
      'family: 👨‍👩‍👧‍👦 rocket: 👩🏻‍🚀 flag: 🇺🇸',
      'zero\u200Bwidth\u200Cnonjoiner\u200Djoiner\uFEFFbom',
    ].join('\n\n')
    const { container, ms } = timedRender(payload)
    const text = container.textContent ?? ''
    expect(text).toContain('مرحبا')
    expect(text).toContain('שלום')
    expect(text).toContain('\u200D')
    expect(ms).toBeLessThan(2_000)
  })

  it('kitchen-sink hostile document: no script, no handlers, completes fast', () => {
    const payload = [
      '# Title <script>alert(1)</script>',
      '<img src=x onerror=alert(1)><svg onload=alert(1)>',
      '[a](javascript:alert(1)) [b](vbscript:msgbox) [c](file:///etc/passwd)',
      '```',
      '</script><script>alert("fence")</script>',
      '```',
      '| col | <script>x</script> |',
      '| --- | --- |',
      '| [d](javascript:x) | ![e](javascript:x) |',
      `${'>' .repeat(200)} quoted <script>y</script>`,
    ].join('\n\n')
    const { container, ms } = timedRender(payload)
    expect(findScriptTag(container)).toBeNull()
    expect(inlineHandlerAttrs(container)).toEqual([])
    expect(
      hrefs(container).filter((h) => /^(javascript|vbscript|file):/i.test(h)),
    ).toEqual([])
    // Every link here carries an unsafe scheme → all downgraded to inert
    // text, so the hostile document mounts no anchor at all.
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img[src="javascript:x"]')).toBeNull()
    expect(ms).toBeLessThan(2_000)
  })

  it('streaming variant keeps hostile HTML inert as plain text', () => {
    const t0 = performance.now()
    const { container } = render(
      createElement(MessageBody, {
        content: '<script>alert(1)</script> partial reply <img src=x onerror=alert(1)>',
        variant: 'markdown',
        streaming: true,
      }),
    )
    const ms = performance.now() - t0
    expect(findScriptTag(container)).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(ms).toBeLessThan(2_000)
  })
})
