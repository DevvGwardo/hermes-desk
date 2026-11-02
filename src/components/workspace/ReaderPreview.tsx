import { useEffect, useRef } from 'react'
import type { ReaderPreview as Preview } from '../../lib/workspace/features'

export function ReaderPreview({ preview, loading, error, onClose }: {
  preview: Preview | null
  loading: boolean
  error: string
  onClose(): void
}) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  return (
    <section className="workspace-reader" aria-label="Page snapshot preview" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }}>
      <header><strong>{preview?.title || 'Page snapshot'}</strong>
        <button ref={close} type="button" className="workspace-action-button" onClick={onClose}>Close preview</button>
      </header>
      <p className="workspace-muted">Read-only, redacted snapshot. No page scripts run in this preview.</p>
      {loading && <p role="status">Reading page…</p>}
      {error && <p className="workspace-error" role="alert">{error}</p>}
      {preview && <><p className="workspace-reader-url">{preview.url}</p><pre>{preview.snapshot || 'No readable page content.'}</pre></>}
    </section>
  )
}
