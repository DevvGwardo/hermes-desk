import { useEffect, useState } from 'react'
import { AppModal } from './AppModal'
import { LocalImage } from './LocalImage'
import type { ProjectArtifact } from '../lib/project-artifacts'
import { loadFileText } from '../lib/file-text-cache'

interface PreviewModalProps {
  artifact: ProjectArtifact | null
  open: boolean
  onClose: () => void
  /** CONTRACT: legacy app-shell prop, no hosted publishing in Hermes Desk. */
  onHost?: (artifact: ProjectArtifact) => void
}

/** Local HTML previews stay sandboxed, with no network or app-origin authority. */
export function PreviewModal({ artifact, open, onClose }: PreviewModalProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    setHtml(null)
    if (!open || !artifact?.entryFile) { setLoading(false); return }
    let alive = true
    setLoading(true)
    void loadFileText(artifact.entryFile).then((text) => {
      if (alive) setHtml(text)
    }).catch(() => {}).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, artifact?.entryFile])
  // The inner document cannot loosen this policy. Scripts may run offline,
  // but cannot fetch, frame remote content, navigate top, or submit forms.
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none';"
  const srcDoc = html === null ? null : `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`
  return (
    <AppModal open={open} onClose={onClose} title={artifact?.title ?? 'Local preview'} size="xl">
      <div className="flex min-h-[420px] flex-col">
        {loading && <p role="status">Loading the page…</p>}
        {!loading && srcDoc !== null && (
          <iframe title={artifact?.title ?? 'Local preview'} srcDoc={srcDoc}
            sandbox="allow-scripts" referrerPolicy="no-referrer"
            className="min-h-[420px] w-full flex-1 border-0 bg-white" />
        )}
        {!loading && srcDoc === null && artifact?.screenshotPath && (
          <LocalImage path={artifact.screenshotPath} alt={artifact.title} />
        )}
        {!loading && srcDoc === null && !artifact?.screenshotPath && <p>No local page to show yet.</p>}
      </div>
    </AppModal>
  )
}
