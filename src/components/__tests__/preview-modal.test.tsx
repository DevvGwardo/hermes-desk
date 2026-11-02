import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PreviewModal } from '../PreviewModal'
import { resetFileTextCacheForTests } from '../../lib/file-text-cache'
import type { ProjectArtifact } from '../../lib/project-artifacts'

const page: ProjectArtifact = {
  id: 'fixture', kind: 'html', title: 'Fixture page', rootPath: '/fake/project', entryFile: '/fake/project/index.html',
}
afterEach(() => { cleanup(); resetFileTextCacheForTests(); delete window.nubAgent })
describe('local page preview security', () => {
  it('reads only through local IPC, keeps an opaque sandbox, and blocks remote requests', async () => {
    const hermes = vi.fn(async () => ({ ok: true, data: { content: '<h1>Fixture</h1><script>window.parent.fixture = true</script>' } }))
    window.nubAgent = { hermes } as unknown as Window['nubAgent']
    const { container } = render(<PreviewModal artifact={page} open onClose={() => {}} />)
    const frame = await screen.findByTitle('Fixture page')
    expect(hermes).toHaveBeenCalledWith('fs', ['read-text', '/fake/project/index.html'])
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.hasAttribute('src')).toBe(false)
    expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'")
    expect(frame.getAttribute('srcdoc')).toContain("form-action 'none'")
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Fixture</h1>')
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/)
  })
  it('shows an honest empty state without a local filesystem bridge', async () => {
    delete window.nubAgent
    render(<PreviewModal artifact={page} open onClose={() => {}} />)
    expect(await screen.findByText('No local page to show yet.')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })
})
