import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { MessageBody } from '../MessageBody'
import type { ChatMessage } from '../../lib/agents'

beforeEach(() => {
  cleanup()
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

const envDump = [
  '```env',
  'UPSTASH_REDIS_REST_URL=',
  'UPSTASH_REDIS_REST_TOKEN=',
  'WEBAUTHN_ORIGIN=',
  'WEBAUTHN_RP_ID=',
  'WEBAUTHN_RP_NAME=',
  'WEBAUTHN_STEP_UP_COOKIE_SECRET=',
  'ENCRYPTION_KEY=',
  'DO_SSH_PRIVATE_KEY=',
  'TURBO_CACHE=remote:rw',
  'TURBO_REMOTE_ONLY=true',
  'NX_DAEMON=false',
  'EXTRA_1=',
  'EXTRA_2=',
  'EXTRA_3=',
  'EXTRA_4=',
  '```',
  '',
  'Heads up: duplicate repo paths.',
].join('\n')

describe('MessageBody', () => {
  it('highlights the original mention text after Unicode lowercase expansion', () => {
    const { container } = render(<MessageBody content="İ @Penny draft." variant="markdown" mentions={[{ id: 'p', name: 'Penny' }]} />)
    expect(container.querySelector('[data-mention="p"]')?.textContent).toBe('@Penny')
    expect(container.textContent).toBe('İ @Penny draft.')
  })

  it('renders GFM code fences as a labeled block, not raw backticks', () => {
    render(<MessageBody content={'```env\nFOO=\n```'} variant="markdown" />)
    expect(screen.getByText('env')).toBeTruthy()
    expect(screen.getByText('FOO=')).toBeTruthy()
    expect(screen.queryByText(/```/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('puts a local brand mark on Cloudflare / Hetzner headings', () => {
    render(
      <MessageBody
        content={'## Hetzner pool\nHCLOUD_TOKEN=\n## Cloudflare\nCF_ACCOUNT_ID='}
        variant="markdown"
      />,
    )
    expect(document.querySelector('[title="hetzner"]')).toBeTruthy()
    expect(document.querySelector('[title="cloudflare"]')).toBeTruthy()
    expect(screen.getByText('Hetzner pool')).toBeTruthy()
  })

  it('renders markdown emphasis', () => {
    render(<MessageBody content="say **word** and I'll pull it" variant="markdown" />)
    expect(screen.getByText('word').tagName).toBe('STRONG')
  })

  it('does not execute raw HTML', () => {
    render(<MessageBody content={'<script>window.__pwned=1</script>'} variant="markdown" />)
    expect(document.querySelector('script')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('renders a markdown logo and a lifted HTML img', () => {
    render(
      <MessageBody
        content={'![Cloudflare](https://www.cloudflare.com/favicon.ico)\n<img src="https://www.hetzner.com/favicon.ico" alt="Hetzner">'}
        variant="markdown"
      />,
    )
    const images = document.querySelectorAll('img.nub-md-img')
    expect(images).toHaveLength(2)
    expect(images[0]?.getAttribute('src')).toBe('https://www.cloudflare.com/favicon.ico')
    expect(images[1]?.getAttribute('alt')).toBe('Hetzner')
  })

  it('does not render a javascript img', () => {
    render(
      <MessageBody content={'<img src="javascript:alert(1)" alt="nope">'} variant="markdown" />,
    )
    expect(document.querySelector('img')).toBeNull()
  })

  it('shows a long finished reply in full, with no Show more', () => {
    render(<MessageBody content={envDump} variant="markdown" />)
    expect(screen.getByText('Heads up: duplicate repo paths.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull()
  })

  it('keeps user text as plain pre-wrap (no markdown)', () => {
    render(<MessageBody content="use *this* path" variant="plain" />)
    expect(screen.getByText('use *this* path')).toBeTruthy()
    expect(screen.queryByText('this')?.tagName === 'EM').toBe(false)
  })

  it('streams a half-open fence as a code block (no raw fence text, no settle reflow)', () => {
    // The open fence is closed for display, so the block renders as code while
    // it streams and does not flip from text to a code block when it settles.
    render(<MessageBody content={'```env\nFOO='} variant="markdown" streaming />)
    expect(screen.queryByText(/```/)).toBeNull()
    expect(screen.getByText(/FOO=/)).toBeTruthy()
    expect(document.querySelector('.nub-md pre, .nub-md code')).toBeTruthy()
  })

  it('settles a streamed turn into full markdown once streaming ends', () => {
    render(
      <MessageBody content={'```env\nFOO=\n```'} variant="markdown" streaming={false} />,
    )
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(screen.queryByText(/```/)).toBeNull()
  })

  it('turns a VM path into a file jump', () => {
    const onOpenFile = vi.fn()
    render(
      <MessageBody
        content="See /opt/data/workspace/app/src/App.tsx:12 for the change."
        variant="markdown"
        onOpenFile={onOpenFile}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '/opt/data/workspace/app/src/App.tsx:12' }))
    expect(onOpenFile).toHaveBeenCalledWith('/opt/data/workspace/app/src/App.tsx', 12)
  })

  it('does not render a streaming caret', () => {
    const { unmount } = render(<MessageBody content="hello" variant="markdown" streaming />)
    expect(document.querySelector('.streaming-caret')).toBeNull()
    unmount()
    render(<MessageBody content="" variant="markdown" streaming />)
    expect(document.querySelector('.streaming-caret')).toBeNull()
    expect(document.body.textContent || '').not.toMatch(/\u2588/)
  })
})

describe('ChatPanel markdown bubbles', () => {
  it('renders an agent fence inside the bubble', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        threadId: 't1',
        role: 'user',
        content: 'paste the env example',
        createdAt: '2026-08-13T00:00:00Z',
      },
      {
        id: 'a1',
        threadId: 't1',
        role: 'agent',
        content: '```env\nFOO=\n```',
        createdAt: '2026-08-13T00:00:01Z',
      },
    ]
    render(<ChatPanel messages={messages} threadKey="t1" onSend={() => {}} />)
    expect(screen.getByText('FOO=')).toBeTruthy()
    expect(screen.queryByText(/```env/)).toBeNull()
  })

  it('does not paint an empty assistant bubble while streaming', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        threadId: 't1',
        role: 'user',
        content: 'run the thing',
        createdAt: '2026-08-13T00:00:00Z',
      },
      {
        id: 'a1',
        threadId: 't1',
        role: 'agent',
        content: '',
        createdAt: '2026-08-13T00:00:01Z',
        streaming: true,
      },
    ]
    render(<ChatPanel skin="classic" messages={messages} threadKey="t1" sending onSend={() => {}} />)
    expect(screen.getByText('run the thing')).toBeTruthy()
    expect(screen.getByText('Working…')).toBeTruthy()
    expect(document.querySelector('[data-message-id="a1"]')).toBeNull()
    expect(document.querySelector('.streaming-caret')).toBeNull()
    expect(document.querySelectorAll('.sand-message-action-anchor')).toHaveLength(1)
  })
})

describe('MessageBody trailing-whitespace trim (plain/streaming fallthrough)', () => {
  it('trims trailing newlines from plain-variant content (no blank tail painted)', () => {
    render(<MessageBody content={'hello world\n\n\n'} variant="plain" />)
    const p = document.querySelector('p.whitespace-pre-wrap')
    expect(p).toBeTruthy()
    expect(p!.textContent).toBe('hello world')
  })

  it('trims trailing whitespace from streaming markdown deltas', () => {
    render(<MessageBody content={'partial line   \n\t\n'} variant="markdown" streaming />)
    const md = document.querySelector('.nub-md')
    expect(md).toBeTruthy()
    expect(md!.textContent).toBe('partial line')
  })

  it('renders nothing for whitespace-only plain content', () => {
    const { container } = render(<MessageBody content={'\n\n   \n\t\n'} variant="plain" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for whitespace-only streaming markdown', () => {
    const { container } = render(<MessageBody content={'\n'} variant="markdown" streaming />)
    expect(container.firstChild).toBeNull()
  })

  it('preserves leading whitespace and internal newlines, trimming only the tail', () => {
    render(<MessageBody content={'  indented\n\nline two\n\n\n'} variant="plain" />)
    const p = document.querySelector('p.whitespace-pre-wrap')
    expect(p).toBeTruthy()
    expect(p!.textContent).toBe('  indented\n\nline two')
  })
})

describe('MessageBody whitespace-only finished markdown (no empty .nub-md)', () => {
  it('renders nothing for whitespace-only finished markdown', () => {
    const { container } = render(<MessageBody content={'   \n\t\n  '} variant="markdown" />)
    expect(container.firstChild).toBeNull()
    expect(document.querySelector('.nub-md')).toBeNull()
  })

  it('still renders non-empty finished markdown', () => {
    render(<MessageBody content={'# Hello\n\nsome **bold** text'} variant="markdown" />)
    const md = document.querySelector('.nub-md')
    expect(md).toBeTruthy()
    expect(md!.textContent).toMatch(/Hello/)
    expect(md!.textContent).toMatch(/bold/)
  })
})

describe('ChatPanel whitespace-only hasBubble (no bubble shell)', () => {
  it('renders no row or bubble shell for a whitespace-only agent message', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        threadId: 't1',
        role: 'user',
        content: 'hi there',
        createdAt: '2026-08-13T00:00:00Z',
      },
      {
        id: 'ws1',
        threadId: 't1',
        role: 'agent',
        content: '   \n\t\n  ',
        createdAt: '2026-08-13T00:00:01Z',
      },
    ]
    render(<ChatPanel messages={messages} threadKey="t1" onSend={() => {}} />)
    // The user row still renders…
    expect(document.querySelector('[data-message-id="u1"]')).toBeTruthy()
    // …but the whitespace-only message leaves no row and no action anchor.
    expect(document.querySelector('[data-message-id="ws1"]')).toBeNull()
    expect(document.querySelectorAll('.sand-message-action-anchor')).toHaveLength(1)
  })
})

describe('ChatPanel bubble line pitch', () => {
  it('renders bubbles with leading-relaxed, not leading-7', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        threadId: 't1',
        role: 'user',
        content: 'hi there',
        createdAt: '2026-08-13T00:00:00Z',
      },
      {
        id: 'a1',
        threadId: 't1',
        role: 'agent',
        content: 'hello\nworld',
        createdAt: '2026-08-13T00:00:01Z',
      },
    ]
    render(<ChatPanel messages={messages} threadKey="t1" onSend={() => {}} />)
    for (const id of ['u1', 'a1']) {
      const row = document.querySelector(`[data-message-id="${id}"]`)
      expect(row).toBeTruthy()
      const bubble = Array.from(row!.querySelectorAll('div')).find((d) =>
        d.classList.contains('text-[15px]'),
      )
      expect(bubble).toBeTruthy()
      expect(bubble!.classList.contains('leading-relaxed')).toBe(true)
      expect(bubble!.classList.contains('leading-7')).toBe(false)
    }
  })
})

describe('inline code path wrapping (mobile)', () => {
  const renderMd = (content: string) => {
    render(<MessageBody content={content} variant="markdown" />)
    return document.querySelector('.nub-md') as HTMLElement
  }

  it('inserts a <wbr> after each path separator so long paths break at a slash', () => {
    const md = renderMd('Landing page is at `/opt/data/workspace/landing/index.html`.')
    const code = md.querySelector('code')!
    // Every separator survives as its own text node followed by a break opportunity.
    expect(code.querySelectorAll('wbr').length).toBeGreaterThan(0)
    expect(code.textContent).toBe('/opt/data/workspace/landing/index.html')
    const seps = (code.textContent!.match(/[/\-_.@:?&=]/g) ?? []).length
    expect(code.querySelectorAll('wbr').length).toBe(seps)
  })

  it('never splits a token that has no separator', () => {
    const md = renderMd('hash `deadbeefcafe` here')
    const code = md.querySelector('code')!
    expect(code.querySelectorAll('wbr').length).toBe(0)
    expect(code.textContent).toBe('deadbeefcafe')
  })

  it('leaves fenced code blocks to MarkdownPre (no <wbr> injected)', () => {
    const md = renderMd('```sh\ncp /opt/data/a.txt /opt/data/b.txt\n```')
    expect(md.querySelector('.nub-md-code')).toBeTruthy()
    expect(md.querySelectorAll('wbr').length).toBe(0)
    expect(md.querySelector('.nub-md-code')!.textContent).toContain('/opt/data/a.txt')
  })

  it('keeps the visible text identical (break opportunities are zero-width)', () => {
    const md = renderMd('see `src/lib/platform.ts:42` now')
    expect(md.querySelector('code')!.textContent).toBe('src/lib/platform.ts:42')
  })
})

describe('user-bubble attachment chip contrast (WCAG AA)', () => {
  it('uses opaque white on the blue bubble, not a translucent wash', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        threadId: 't1',
        role: 'user',
        content: 'here',
        createdAt: '2026-08-13T00:00:00Z',
        attachments: [{ id: 'f1', name: '.env.example', kind: 'file' } as never],
      },
    ]
    render(<ChatPanel messages={messages} threadKey="t1" onSend={() => {}} />)
    const name = Array.from(document.querySelectorAll('span')).find(
      (s) => s.textContent === '.env.example',
    )!
    const chip = name.closest('li')!
    // Measured 3.56:1 with text-white/90; opaque white measures 5.14:1.
    expect(chip.className).toContain('text-white')
    expect(chip.className).not.toContain('text-white/90')
    // The kind label must not stack another 60% wash on top of it.
    const kind = Array.from(chip.querySelectorAll('span')).find((s) =>
      s.className.includes('uppercase'),
    )!
    expect(kind.className).not.toContain('opacity-60')
  })
})


describe('markdown pictures', () => {
  it('shows a picture alone in its paragraph as a block, and keeps logos in text inline', async () => {
    render(
      <MessageBody
        content={'Here it is:\n\n![Chart](https://example.com/chart.png)\n\nBuilt on ![CF](https://example.com/cf.ico) today.'}
        variant="markdown"
      />,
    )
    const chart = await screen.findByAltText('Chart')
    expect(chart.className).toContain('nub-md-img--block')
    expect(screen.getByAltText('CF').className).not.toContain('nub-md-img--block')
  })

  it('keeps an inlined data picture that react-markdown would drop', async () => {
    const src = 'data:image/png;base64,iVBORw0KGgo='
    render(<MessageBody content={`<img src="${src}" alt="Plot">`} variant="markdown" />)
    expect((await screen.findByAltText('Plot')).getAttribute('src')).toBe(src)
  })

  it('reads an /opt/data picture from the agent computer, never from the app origin', async () => {
    render(<MessageBody content={'![Shot](/opt/data/workspace/shot.png)'} variant="markdown" />)
    // No VM bridge in tests: the VM path's own loading/fallback states, and
    // nothing loading /opt/data/... against the app's origin.
    const failed = await screen.findByText(/Couldn't load this picture/)
    // Plain words on screen; the path is only the hover title.
    expect(failed.closest('[title]')?.getAttribute('title')).toBe('/opt/data/workspace/shot.png')
    expect(document.querySelector('[src^="/opt/data"]')).toBeNull()
  })

  it('shows the alt text when a web picture fails', async () => {
    render(<MessageBody content={'![Diagram of the flow](https://example.com/missing.png)'} variant="markdown" />)
    fireEvent.error(await screen.findByAltText('Diagram of the flow'))
    expect(screen.getByText('Image unavailable · Diagram of the flow')).toBeTruthy()
  })

  it('trims a streamed plain body in linear time when the model emits a long blank run', () => {
    const content = `start${' '.repeat(100_000)}end\n\n  `
    const started = performance.now()
    const { container } = render(<MessageBody content={content} variant="plain" streaming />)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(container.textContent?.endsWith('end')).toBe(true)
  })
})
