import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectArtifactCard, artifactStatus, frameLayoutWidth, thumbnailFrameSrc } from '../ProjectArtifactCard'
import type { ProjectArtifact } from '../../lib/project-artifacts'
import { embeddableSiteUrl, isOpenablePage } from '../../lib/project-artifacts'

function artifact(overrides: Partial<ProjectArtifact> = {}): ProjectArtifact {
  return {
    id: 'landing',
    kind: 'html',
    title: 'landing (HTML)',
    rootPath: '/opt/data/workspace/landing',
    entryFile: '/opt/data/workspace/landing/index.html',
    ...overrides,
  }
}

describe('ProjectArtifactCard preview behavior', () => {
  it('with screenshot + onPreview: shows loading state and Preview click passes the artifact', () => {
    const onPreview = vi.fn()
    const a = artifact({ screenshotPath: '/opt/data/workspace/landing/shot.png' })
    const { unmount } = render(
      <ProjectArtifactCard artifact={a} onPreview={onPreview} onDownload={() => {}} onHost={() => {}} />,
    )
    try {
      expect(screen.getByRole('status', { name: 'Loading picture' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
      expect(onPreview).toHaveBeenCalledWith(a)
    } finally {
      unmount()
      cleanup()
    }
  })

  it('without screenshot + onPreview: placeholder preview activates onPreview', () => {
    const onPreview = vi.fn()
    const a = artifact()
    const { unmount } = render(
      <ProjectArtifactCard artifact={a} onPreview={onPreview} onDownload={() => {}} onHost={() => {}} />,
    )
    try {
      const thumb = screen.getByRole('button', { name: 'Preview landing (HTML)' })
      expect(thumb).toBeTruthy()
      fireEvent.click(thumb)
      expect(onPreview).toHaveBeenCalledWith(a)
    } finally {
      unmount()
      cleanup()
    }
  })

  it('without onPreview: no Preview button and no preview-labelled control', () => {
    const { unmount } = render(
      <ProjectArtifactCard artifact={artifact()} onDownload={() => {}} onHost={() => {}} />,
    )
    try {
      expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
      expect(screen.queryByLabelText(/Preview landing/)).toBeNull()
    } finally {
      unmount()
      cleanup()
    }
  })

  it('does not render Open site for a hostedUrl on an arbitrary or non-https host', () => {
    for (const url of ['https://evil.example/phish', 'javascript:alert(1)', 'http://landing.maiavm.com']) {
      const { unmount } = render(
        <ProjectArtifactCard artifact={artifact({ hostedUrl: url })} onDownload={() => {}} onHost={() => {}} />,
      )
      try {
        expect(screen.queryByText('Open site')).toBeNull()
      } finally {
        unmount()
        cleanup()
      }
    }
  })

  it('renders hostedUrl as a link', () => {
    const url = 'https://landing.maiavm.com'
    const { unmount } = render(
      <ProjectArtifactCard
        artifact={artifact({ hostedUrl: url })}
        onDownload={() => {}}
        onHost={() => {}}
      />,
    )
    try {
      const link = screen.getByRole('link', { name: `Open ${url}` })
      // href goes through safeLinkUrl, which normalizes the URL.
      expect(link.getAttribute('href')).toBe('https://landing.maiavm.com/')
    } finally {
      unmount()
      cleanup()
    }
  })
})

describe('ProjectArtifactCard action availability', () => {
  it('omits Download and Host when the shell cannot perform them (phone)', () => {
    // The phone shell passes onPreview only: no desktop VM zip dialog exists,
    // so those two buttons must be absent rather than present-and-inert.
    render(<ProjectArtifactCard artifact={artifact()} onPreview={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })

  it('renders each action when its handler is supplied', () => {
    render(
      <ProjectArtifactCard
        artifact={artifact()}
        onPreview={() => {}}
        onDownload={() => {}}
        onHost={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy()
  })
})

describe('ProjectArtifactCard live thumbnail', () => {
  afterEach(() => cleanup())
  const hosted = 'https://bakery-launch-7kpr-site.nub.lol'

  it('frames the published Nub Site, inert, instead of the grey mock', () => {
    render(<ProjectArtifactCard artifact={artifact({ hostedUrl: hosted })} onPreview={() => {}} />)
    const frame = document.querySelector('iframe')
    // jsdom has no layout, so the frame mounts only once the box measures.
    if (frame) {
      expect(frame.getAttribute('src')).toBe(hosted)
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
      expect(frame.getAttribute('tabindex')).toBe('-1')
    }
    expect(thumbnailFrameSrc(artifact({ hostedUrl: hosted }), false)).toBeNull()
  })

  it('reads the VM file on desktop and never frames other hosts', () => {
    const a = artifact({ hostedUrl: 'https://landing.vercel.app' })
    expect(thumbnailFrameSrc(a, false)).toBeNull()
    expect(thumbnailFrameSrc(a, true)).toBeNull()
  })

  it('a hosted-only Nub Site is openable', () => {
    const a = artifact({ kind: 'static', entryFile: undefined, hostedUrl: hosted })
    expect(isOpenablePage(a)).toBe(true)
    expect(embeddableSiteUrl(a)).toBe(hosted)
    expect(embeddableSiteUrl({ ...a, hostedUrl: 'https://app-agent-x-1234abcd.nub.lol' })).toBeNull()
  })

  it('labels Publish as Update site once the site is live', () => {
    render(<ProjectArtifactCard artifact={artifact({ hostedUrl: hosted })} onHost={() => {}} />)
    expect(screen.getByRole('button', { name: 'Update site' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
  })
})

describe('ProjectArtifactCard status + layout', () => {
  afterEach(() => cleanup())

  it('says Live / Running / Not published', () => {
    expect(artifactStatus(artifact({ hostedUrl: 'https://x-ab12-site.nub.lol' })).tone).toBe('live')
    expect(artifactStatus(artifact({ port: 5199 })).label).toBe('Running')
    expect(artifactStatus(artifact({})).tone).toBe('draft')
    render(<ProjectArtifactCard artifact={artifact({ hostedUrl: 'https://x-ab12-site.nub.lol' })} />)
    expect(document.querySelector('[data-artifact-status="live"]')?.textContent).toBe('Live')
  })

  it('shows the public domain in the address bar, not the full URL twice', () => {
    render(<ProjectArtifactCard artifact={artifact({ hostedUrl: 'https://x-ab12-site.nub.lol' })} onPreview={() => {}} />)
    expect(screen.getByText('x-ab12-site.nub.lol')).toBeTruthy()
    expect(screen.queryByText('https://x-ab12-site.nub.lol')).toBeNull()
  })

  it('lays the thumbnail out desktop-wide in a wide column, phone-wide on a phone', () => {
    expect(frameLayoutWidth(672)).toBe(1280)
    expect(frameLayoutWidth(340)).toBe(612)
    expect(frameLayoutWidth(200)).toBe(480)
  })
})

describe('ProjectArtifactCard download', () => {
  afterEach(() => cleanup())

  it('shows Saving while the zip saves, then why it failed', async () => {
    let finish!: (r: { ok: boolean; error?: string }) => void
    const onDownload = vi.fn(() => new Promise<{ ok: boolean; error?: string }>((r) => (finish = r)))
    render(<ProjectArtifactCard artifact={artifact()} onDownload={onDownload} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true)
    finish({ ok: false, error: 'Not enough disk space.' })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Not enough disk space.')
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
  })
})
