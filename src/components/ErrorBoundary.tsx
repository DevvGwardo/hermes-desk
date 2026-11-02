import { Component, lazy, Suspense, type ReactNode } from 'react'
import { logger } from '../lib/logger'
import { isChunkLoadError, reloadForStaleChunk } from '../lib/chunk-reload'
import { reportRenderFailure } from '../lib/render-capture-bridge'

const CapturedRenderFailure = lazy(() => import('./CapturedRenderFailure')
  .then(module => ({ default: module.CapturedRenderFailure }))
  .catch(() => ({ default: () => null })))

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
  onError?: (err: Error, info: React.ErrorInfo) => void
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // A chunk from the previous deploy: reload once to load the new build.
    if (isChunkLoadError(error) && reloadForStaleChunk()) return
    reportRenderFailure(error, info.componentStack ?? undefined)
    logger.error('[ErrorBoundary]', error, info.componentStack)
    this.props.onError?.(error, info)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div
          style={{ background: 'var(--ca-card)', color: 'var(--ca-ink, #1a3d6b)' }}
          className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center"
        >
          <h2 className="text-xl font-semibold">Something went wrong</h2>
          {this.state.error?.message && (
            <p className="max-w-md text-sm opacity-70">
              {this.state.error.message}
            </p>
          )}
          <Suspense fallback={null}><CapturedRenderFailure /></Suspense>
          <button
            onClick={() => window.location.reload()}
            className="mt-2 rounded-md bg-[var(--ca-ink)] px-4 py-2 text-sm font-medium text-[var(--ca-card)] hover:opacity-90"
          >
            Reload
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
