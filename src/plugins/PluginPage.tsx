/** A plugin route rendered in the main pane, isolated by its own boundary. */
import { usePluginRoutes } from './PluginHost'
import { PluginRender } from './PluginBoundary'

export function PluginPage({ path, onClose }: { path: string; onClose: () => void }) {
  const route = usePluginRoutes().find((entry) => entry.data?.path === path && typeof entry.render === 'function')
  const unavailable = <p className="rounded-xl border border-dashed border-[var(--ca-border)] px-3 py-6 text-center text-[13px] text-[var(--ca-ink-soft)]">
    This plugin page isn't available. Its plugin may be off, changed since you trusted it, or stopped after an error.
    Check Settings → Plugins.
  </p>
  return (
    <div className="ca-enter flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--ca-canvas)]" data-testid="plugin-page">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-8">
          <button
            type="button"
            onClick={onClose}
            className="-ml-1 mb-3 inline-flex min-h-11 items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-[var(--ca-ink-soft)] transition hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)] sm:min-h-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back to chat
          </button>
          <header className="mb-6">
            <h1 className="text-[20px] font-semibold text-[var(--ca-ink)]">{route?.data.title ?? 'Plugin page'}</h1>
            <p className="mt-0.5 text-[13px] text-[var(--ca-ink-soft)]">Added by a desktop plugin</p>
          </header>
          {route ? <PluginRender key={route.id} id={route.id} render={route.render} fallback={unavailable} /> : unavailable}
        </div>
      </div>
    </div>
  )
}
