import { describe, expect, it } from 'vitest'
import {
  artifactAnchorIndex,
  deriveProjectArtifacts,
  isOpenablePage,
  livePreviewUrl,
  openableHostedUrl,
  previewPrompt,
  publishPrompt,
  screenshotPathsFromMessage,
  type ProjectArtifact,
} from '../project-artifacts'
import type { ChatMessage } from '../agents'

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'content'>): ChatMessage {
  return {
    threadId: 't1',
    role: 'agent',
    createdAt: '2026-08-13T00:00:00Z',
    ...partial,
  }
}

describe('deriveProjectArtifacts', () => {
  it('picks up a written index.html on the VM', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: 'Created /opt/data/workspace/landing/index.html — open it in the browser.',
      }),
    ])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].kind).toBe('html')
    expect(artifacts[0].rootPath).toBe('/opt/data/workspace/landing')
    expect(artifacts[0].entryFile).toBe('/opt/data/workspace/landing/index.html')
    expect(livePreviewUrl(artifacts[0])).toBe(
      'nub-vm://file/opt/data/workspace/landing/index.html',
    )
    expect(isOpenablePage(artifacts[0])).toBe(true)
  })

  it('detects a Vite React app plus the live port', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: 'Scaffolded a React app.',
        toolEvents: [
          {
            tool: 'terminal',
            status: 'completed',
            args: 'npm create vite@latest /opt/data/workspace/todo -- --template react',
            result: 'VITE v6 ready — Local: http://127.0.0.1:5173/',
          },
        ],
      }),
    ])
    expect(artifacts[0].kind).toBe('vite')
    expect(artifacts[0].port).toBe(5173)
    expect(artifacts[0].rootPath).toBe('/opt/data/workspace/todo')
    expect(livePreviewUrl(artifacts[0])).toBe('nub-vm://p5173/')
    expect(isOpenablePage(artifacts[0])).toBe(true)
  })

  it('opens a Node app from package.json plus :3000, not as a static HTML file', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: 'Ready on http://127.0.0.1:3000',
        toolEvents: [
          {
            tool: 'write_file',
            status: 'completed',
            args: '{"path":"/opt/data/workspace/blog/package.json"}',
          },
        ],
      }),
    ])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].kind).not.toBe('html')
    expect(artifacts[0].entryFile).toBeUndefined()
    expect(artifacts[0].port).toBe(3000)
    expect(livePreviewUrl(artifacts[0])).toBe('nub-vm://p3000/')
    expect(isOpenablePage(artifacts[0])).toBe(true)
  })

  it('previews static HTML from the file, not a python :8000 proxy', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content:
          'Created /opt/data/workspace/landing/index.html and served it at http://127.0.0.1:8000/',
      }),
    ])
    expect(artifacts[0].kind).toBe('html')
    expect(artifacts[0].port).toBeUndefined()
    expect(livePreviewUrl(artifacts[0])).toBe(
      'nub-vm://file/opt/data/workspace/landing/index.html',
    )
  })

  it('does not invent HTML cards for incidental /opt/data dirs', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content:
          'Created /opt/data/workspace/landing/index.html and wrote /opt/data/workspace/logs/out.txt plus /opt/data/workspace/data/notes.md',
      }),
    ])
    expect(artifacts.map((a) => a.rootPath)).toEqual(['/opt/data/workspace/landing'])
    expect(artifacts[0].entryFile).toBe('/opt/data/workspace/landing/index.html')
  })

  it('does not add a parent workspace card when a child HTML project exists', () => {
    const artifacts = deriveProjectArtifacts(
      [
        msg({
          id: '1',
          content: 'Created /opt/data/workspace/landing/index.html',
        }),
      ],
      '/opt/data/workspace',
    )
    expect(artifacts.map((a) => a.rootPath)).toEqual(['/opt/data/workspace/landing'])
    expect(isOpenablePage(artifacts[0])).toBe(true)
  })

  it('does not treat python :8000 plus npm run dev as a Vite app', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content:
          'Wrote /opt/data/workspace/simple-site/index.html then ran npm run dev and python -m http.server 8000 at http://127.0.0.1:8000/',
      }),
    ])
    expect(artifacts[0].kind).toBe('html')
    expect(artifacts[0].port).toBeUndefined()
    expect(livePreviewUrl(artifacts[0])).toBe(
      'nub-vm://file/opt/data/workspace/simple-site/index.html',
    )
  })

  it('keeps a screenshot path from the computer-use result', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: 'Here is what the page looks like.',
        toolEvents: [
          {
            tool: 'screenshot',
            status: 'completed',
            result: 'saved screenshot /opt/data/workspace/qa/01_app.png',
          },
        ],
      }),
    ])
    expect(artifacts[0].screenshotPath).toBe('/opt/data/workspace/qa/01_app.png')
    expect(artifacts[0].kind).toBe('screenshot')
    expect(livePreviewUrl(artifacts[0])).toBeNull()
    expect(isOpenablePage(artifacts[0])).toBe(false)
  })

  it('treats a cache screenshot path as a page screenshot, not an HTML preview', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content:
          'Captured a page to /opt/data/cache/screenshots/browser_abc.png — the visual analysis model hit a 502.',
      }),
    ])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].kind).toBe('screenshot')
    expect(artifacts[0].title).toBe('Page screenshot')
    expect(artifacts[0].screenshotPath).toBe('/opt/data/cache/screenshots/browser_abc.png')
    expect(livePreviewUrl(artifacts[0])).toBeNull()
  })

  it('extracts a Vercel URL after publish', () => {
    const artifacts = deriveProjectArtifacts(
      [
        msg({
          id: '1',
          content: 'Live at https://todo-app.vercel.app',
          toolEvents: [
            {
              tool: 'write_file',
              status: 'completed',
              args: '{"path":"/opt/data/workspace/todo/package.json"}',
            },
          ],
        }),
      ],
      '/opt/data/workspace/todo',
    )
    expect(artifacts[0].hostedUrl).toBe('https://todo-app.vercel.app')
  })

  it('builds an HTML card from write_file JSON with no path in the reply', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: 'Done.',
        toolEvents: [
          {
            tool: 'write_file',
            status: 'completed',
            args: '{"file_path":"/opt/data/workspace/secret-app/index.html"}',
          },
        ],
      }),
    ])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].kind).toBe('html')
    expect(artifacts[0].rootPath).toBe('/opt/data/workspace/secret-app')
    expect(artifacts[0].entryFile).toBe('/opt/data/workspace/secret-app/index.html')
  })

  it('does not invent a site card for a lone App.tsx write', () => {
    expect(
      deriveProjectArtifacts([
        msg({
          id: '1',
          content: 'Done.',
          toolEvents: [
            {
              tool: 'write_file',
              status: 'completed',
              args: '{"file_path":"/opt/data/workspace/app/src/App.tsx"}',
            },
          ],
        }),
      ]),
    ).toEqual([])
  })

  it('ignores Mac paths and Hermes dashboard ports', () => {
    expect(
      deriveProjectArtifacts([
        msg({ id: '1', content: 'see ~/maiavm-desktop/index.html on http://127.0.0.1:9119' }),
      ]),
    ).toEqual([])
  })
})

describe('artifactAnchorIndex', () => {
  it('pins cards to the first message that produced them, not a later follow-up', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'make a landing page' }),
      msg({
        id: 'a1',
        content: 'Created /opt/data/workspace/landing/index.html',
      }),
      msg({ id: 'u2', role: 'user', content: 'Good morning.' }),
      msg({ id: 'a2', role: 'agent', content: '', streaming: true }),
    ]
    expect(artifactAnchorIndex(messages)).toBe(1)
  })

  it('does not pin cards to a screenshot-only turn', () => {
    const messages = [
      msg({
        id: 'a1',
        content: 'Captured /opt/data/cache/screenshots/browser_abc.png',
      }),
    ]
    expect(artifactAnchorIndex(messages)).toBe(-1)
  })
})

describe('publishPrompt', () => {
  it('tells the agent to deploy from the VM path', () => {
    const artifact: ProjectArtifact = {
      id: 'p',
      kind: 'react',
      title: 'todo',
      rootPath: '/opt/data/workspace/todo',
    }
    expect(publishPrompt(artifact)).toContain('/opt/data/workspace/todo')
    expect(publishPrompt(artifact)).toContain('this computer')
  })

  it('routes through nub-publish, not third-party hosts', () => {
    const prompt = publishPrompt({
      id: 'p',
      kind: 'html',
      title: 'landing',
      rootPath: '/opt/data/workspace/landing',
    })
    expect(prompt).toContain('nub-publish')
    expect(prompt).not.toMatch(/vercel|railway|cloudflare pages/i)
  })

  it('asks framework apps to publish their build output', () => {
    const prompt = publishPrompt({
      id: 'p',
      kind: 'vite',
      title: 'todo',
      rootPath: '/opt/data/workspace/todo',
    })
    expect(prompt).toMatch(/build output/)
  })
})

describe('nub-publish output', () => {
  const publishOutput = [
    'published: /opt/data/workspace/memes',
    'site: memes  version: 2  files: 3 (0.1 MB, 1 uploaded)',
    'url: https://memes-a1b2-site.nub.lol',
  ].join('\n')

  it('binds the published URL to the published directory', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: 'Your site is live!',
        toolEvents: [
          { tool: 'terminal', status: 'completed', args: 'nub-publish memes', result: publishOutput },
        ],
      }),
    ])
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      kind: 'html',
      rootPath: '/opt/data/workspace/memes',
      entryFile: '/opt/data/workspace/memes/index.html',
      hostedUrl: 'https://memes-a1b2-site.nub.lol',
    })
    expect(isOpenablePage(artifacts[0])).toBe(true)
  })

  it('parses output wrapped in a JSON tool result', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: 'Done.',
        toolEvents: [
          {
            tool: 'terminal',
            status: 'completed',
            result: JSON.stringify({ output: publishOutput, exit_code: 0 }),
          },
        ],
      }),
    ])
    expect(artifacts[0]?.hostedUrl).toBe('https://memes-a1b2-site.nub.lol')
    expect(artifacts[0]?.rootPath).toBe('/opt/data/workspace/memes')
  })

  it('keeps each published site on its own URL', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: [
          'published: /opt/data/workspace/one',
          'url: https://one-aaaa-site.nub.lol',
          'published: /opt/data/workspace/two',
          'url: https://two-bbbb-site.nub.lol',
        ].join('\n'),
      }),
    ])
    const byRoot = Object.fromEntries(artifacts.map((a) => [a.rootPath, a.hostedUrl]))
    expect(byRoot['/opt/data/workspace/one']).toBe('https://one-aaaa-site.nub.lol')
    expect(byRoot['/opt/data/workspace/two']).toBe('https://two-bbbb-site.nub.lol')
  })

  it('treats a published site as static even when the chat mentioned a dev server', () => {
    const artifacts = deriveProjectArtifacts([
      msg({ id: '1', content: 'Skipping npm run dev, it is not needed here.' }),
      msg({ id: '2', content: publishOutput }),
    ])
    expect(artifacts[0]?.kind).toBe('html')
    expect(artifacts[0]?.port).toBeUndefined()
  })

  it('recognizes a bare *-site.nub.lol link as the hosted URL', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: 'Wrote /opt/data/workspace/memes/index.html — live at https://memes-a1b2-site.nub.lol',
      }),
    ])
    expect(artifacts[0]?.hostedUrl).toBe('https://memes-a1b2-site.nub.lol')
  })
})

describe('previewPrompt', () => {
  it('does not tell the agent to python-serve static HTML', () => {
    const text = previewPrompt({
      id: 'p',
      kind: 'html',
      title: 'landing',
      rootPath: '/opt/data/workspace/landing',
      entryFile: '/opt/data/workspace/landing/index.html',
      port: 8000,
    })
    expect(text).toContain('/opt/data/workspace/landing/index.html')
    expect(text).not.toMatch(/python|8000/)
  })
})

describe('hosted URL allowlist (B-3)', () => {
  it('ignores a nub-publish url: line on an arbitrary host', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: ['published: /opt/data/workspace/memes', 'url: https://evil.example/phish'].join('\n'),
      }),
    ])
    expect(artifacts.every((a) => a.hostedUrl === undefined)).toBe(true)
  })

  it('keeps the directory but not an arbitrary url when the site also has index.html', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: [
          'Wrote /opt/data/workspace/memes/index.html',
          'published: /opt/data/workspace/memes',
          'url: https://evil.example/phish',
        ].join('\n'),
      }),
    ])
    expect(artifacts[0]?.rootPath).toBe('/opt/data/workspace/memes')
    expect(artifacts[0]?.hostedUrl).toBeUndefined()
  })

  it('does not take a lookalike host that only starts with nub.lol', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: ['published: /opt/data/workspace/memes', 'url: https://memes-a1b2-site.nub.lol.evil.example/'].join(
          '\n',
        ),
      }),
    ])
    expect(artifacts.every((a) => a.hostedUrl === undefined)).toBe(true)
  })

  it('still binds the legacy per-VM artifact host', () => {
    const artifacts = deriveProjectArtifacts([
      msg({
        id: '1',
        content: ['published: /opt/data/workspace/memes', 'url: https://app-agent-x-1234abcd.nub.lol/'].join('\n'),
      }),
    ])
    expect(artifacts[0]?.hostedUrl).toBe('https://app-agent-x-1234abcd.nub.lol/')
  })

  it('openableHostedUrl allows only https platform hosts', () => {
    expect(openableHostedUrl('https://memes-a1b2-site.nub.lol')).toBe('https://memes-a1b2-site.nub.lol/')
    expect(openableHostedUrl('https://todo-app.vercel.app/x')).toBe('https://todo-app.vercel.app/x')
    expect(openableHostedUrl('https://landing.maiavm.com')).toBe('https://landing.maiavm.com/')
    for (const bad of [
      'https://evil.example',
      'http://memes-a1b2-site.nub.lol',
      'https://nub.lol.evil.example',
      'https://user:pw@memes-a1b2-site.nub.lol',
      'https://memes-a1b2-site.nub.lol:8443/',
      'javascript:alert(1)',
      'nub-vm://file/opt/data/x.png',
      '',
      undefined,
    ]) {
      expect(openableHostedUrl(bad), String(bad)).toBeNull()
    }
  })
})

describe('screenshotPathsFromMessage', () => {
  it('reads keyed screenshot paths and stays linear on whitespace after a keyword', () => {
    expect(screenshotPathsFromMessage(msg({ id: 's1', content: 'Saved :  /opt/data/workspace/shot.png done' })))
      .toEqual(['/opt/data/workspace/shot.png'])
    const content = `saved${' \n'.repeat(30_000)}! nothing else`
    const started = performance.now()
    expect(screenshotPathsFromMessage(msg({ id: 's2', content }))).toEqual([])
    expect(performance.now() - started).toBeLessThan(500)
  })
})
