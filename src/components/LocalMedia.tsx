/**
 * Audio and video from the agent computer: a voice reply (`MEDIA:` from the
 * agent's text-to-speech), a screen recording, a clip it made. In the chat it
 * is a compact card that reads nothing until Play is pressed, then plays in
 * place; the file preview mounts it already loading.
 */
import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { acquireVmImage, forgetVmImage, vmFileError } from '../lib/chat-images'
import { isTooLargeError, mediaKindOf, VM_READ_MAX_BYTES } from '../lib/media-kind'
import { viewerItemName } from '../lib/image-viewer'

type Load = { state: 'idle' | 'loading' | 'ready' | 'failed'; file: { url: string } | null; error?: string; path?: string; attempt?: number }

function useLocalMedia(path: string, wanted: boolean, attempt: number): Load {
  const [load, setLoad] = useState<Load>({ state: 'idle', file: null })
  useEffect(() => {
    if (!wanted) return
    setLoad({ state: 'loading', file: null, path, attempt })
    let alive = true
    const media = window.nubAgent?.media
    if (media) {
      let source: string | null = null
      const release = (url: string) => { void media.release(url).catch(() => {}) }
      void media.open(path).then((url) => {
        if (!alive) { release(url); return }
        source = url
        setLoad({ state: 'ready', file: { url }, path, attempt })
      }).catch(() => {
        if (alive) setLoad({ state: 'failed', file: null, path, attempt })
      })
      return () => {
        alive = false
        if (source) release(source)
      }
    }
    const held = acquireVmImage(path)
    void held.promise.then((file) => {
      if (!alive) return
      setLoad(file ? { state: 'ready', file, path, attempt } : { state: 'failed', file: null, error: vmFileError(path), path, attempt })
    })
    return () => {
      alive = false
      held.release()
    }
  }, [path, wanted, attempt])
  return wanted && load.path === path && load.attempt === attempt ? load : { state: wanted ? 'loading' : 'idle', file: null }
}

function MediaPlayer({ kind, url, name, autoPlay, large, onError }: {
  kind: 'audio' | 'video'; url: string; name: string; autoPlay: boolean; large: boolean; onError: () => void
}) {
  const ref = useRef<HTMLMediaElement | null>(null)
  useEffect(() => {
    const player = ref.current
    const pause = () => player?.pause()
    const hidden = () => { if (document.hidden) pause() }
    window.addEventListener('hashchange', pause)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('hashchange', pause)
      document.removeEventListener('visibilitychange', hidden)
      pause()
      player?.removeAttribute('src')
      player?.load()
    }
  }, [url])
  const props = {
    ref: (element: HTMLMediaElement | null) => { ref.current = element },
    src: url, controls: true, autoPlay, preload: 'metadata', 'aria-label': name, onError,
    onPlay: (event: SyntheticEvent<HTMLMediaElement>) => {
      for (const other of document.querySelectorAll<HTMLMediaElement>('audio,video')) {
        if (other !== event.currentTarget) other.pause()
      }
    },
  }
  return kind === 'video' ? (
    <video {...props} playsInline className={`block rounded-lg border border-[var(--ca-border)] bg-black ${
      large ? 'max-h-full max-w-full' : 'mt-2 max-h-72 w-full max-w-[32rem]'
    }`} />
  ) : (
    <span className={`block ${large ? 'w-full max-w-lg' : 'mt-2 w-full max-w-sm'}`}>
      <span className="mb-1 block truncate text-[11px] text-[var(--ca-ink-muted)]">{name}</span>
      <audio {...props} className="block w-full" />
    </span>
  )
}

function PlayIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
    </svg>
  )
}

function failureText(error: string | undefined, kind: 'audio' | 'video'): string {
  if (isTooLargeError(error)) {
    return `This file exceeds the ${VM_READ_MAX_BYTES / (1024 * 1024)} MB preview limit. Open it in another media player.`
  }
  return `Couldn't load this ${kind === 'audio' ? 'audio' : 'video'}.`
}

export function LocalMedia({
  path,
  autoLoad = false,
  large = false,
  onDownload,
}: {
  path: string
  /** Read at once (the file preview) instead of on Play. */
  autoLoad?: boolean
  /** Fill the preview pane rather than a chat-sized card. */
  large?: boolean
  /** Offered when the file can't be played here. */
  onDownload?: (path: string) => void
}) {
  const kind = mediaKindOf(path) ?? 'audio'
  const [request, setRequest] = useState({ path, wanted: autoLoad, attempt: 0 })
  const wanted = autoLoad || (request.path === path && request.wanted)
  const attempt = request.path === path ? request.attempt : 0
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const { state, file, error } = useLocalMedia(path, wanted, attempt)
  const name = viewerItemName(path)

  const decodeFailed = Boolean(file && failedUrl === file.url)
  if (state === 'ready' && file && !decodeFailed) {
    // Pressing Play is the request to play: start once loaded.
    const auto = wanted && !autoLoad
    return <MediaPlayer kind={kind} url={file.url} name={name} autoPlay={auto} large={large}
      onError={() => setFailedUrl(file.url)} />
  }

  if (state === 'failed' || decodeFailed) {
    const tooLarge = isTooLargeError(error)
    return (
      <span role="alert" className="mt-2 flex max-w-sm flex-wrap items-center gap-2 rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2 text-[12px] text-[var(--ca-ink-muted)]">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-[var(--ca-ink)]">{name}</span>
          {decodeFailed ? `This ${kind} may use an unsupported codec or be damaged. ${
            kind === 'video' ? 'Try MP4 (H.264/AAC) or WebM.' : 'Try MP3 or WAV.'
          }` : failureText(error, kind)}
        </span>
        {!tooLarge && (
          <button
            type="button"
            onClick={() => {
              forgetVmImage(path)
              setFailedUrl(null)
              setRequest({ path, wanted: true, attempt: attempt + 1 })
            }}
            className="rounded-full border border-[var(--ca-border)] px-2 py-0.5 text-[var(--ca-ink)] hover:bg-[var(--ca-hover)]"
          >
            Retry
          </button>
        )}
        {onDownload && (
          <button
            type="button"
            onClick={() => onDownload(path)}
            className="rounded-full border border-[var(--ca-border)] px-2 py-0.5 text-[var(--ca-ink)] hover:bg-[var(--ca-hover)]"
          >
            Download
          </button>
        )}
      </span>
    )
  }

  const loading = state === 'loading'
  return (
    <button
      type="button"
      disabled={loading}
      onClick={() => setRequest({ path, wanted: true, attempt })}
      aria-label={`Play ${name}`}
      className="mt-2 flex w-full max-w-sm items-center gap-3 rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2 text-left transition hover:bg-[var(--ca-hover)] disabled:cursor-progress"
    >
      <span
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--ca-primary-fill)] text-white ${
          loading ? 'animate-pulse' : ''
        }`}
      >
        <PlayIcon />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-[var(--ca-ink)]">{name}</span>
        <span className="block text-[11px] text-[var(--ca-ink-muted)]">
          {loading ? 'Loading…' : kind === 'video' ? 'Video from the agent computer' : 'Audio from the agent computer'}
        </span>
      </span>
    </button>
  )
}
