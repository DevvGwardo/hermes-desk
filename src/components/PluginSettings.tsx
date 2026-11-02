/**
 * Plugin inventory UI — Settings → Plugins. Lists every loaded/disabled/error
 * plugin with an enable/disable toggle and a reload action, driven by the
 * plugin host's inventory store (`usePluginInventory`).
 */
import { useCallback, useEffect, useState } from 'react'
import { usePluginInventory, usePluginPanes } from '../plugins/PluginHost'
import {
  setPluginEnabled,
  discoverRuntimePlugins,
  restorePluginVersion,
  reviewPlugin,
  trustedPluginSource,
  type PluginReview,
} from '../plugins/loader'
import type { PluginInventoryEntry } from '../lib/plugins/types'
import { lineDiff, type DiffLine } from '../lib/line-diff'
import { Switch } from './ui/Switch'
import { PluginRender } from '../plugins/PluginBoundary'

const shortHash = (hash: string) => hash.slice(0, 12)

function SourceView({ source }: { source: string }) {
  const lines = source.split('\n')
  return (
    <pre className="max-h-80 overflow-auto rounded-lg bg-[var(--ca-canvas)] p-2 font-mono text-[11px] leading-[16px] text-[var(--ca-ink)]"
      aria-label="Plugin source" tabIndex={0}>
      {lines.map((line, index) => <div key={index} className="flex gap-3 whitespace-pre">
        <span aria-hidden="true" className="w-8 shrink-0 select-none text-right text-[var(--ca-ink-muted)]">{index + 1}</span>
        <span>{line || ' '}</span>
      </div>)}
    </pre>
  )
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg bg-[var(--ca-canvas)] p-2 font-mono text-[11px] leading-[16px] text-[var(--ca-ink)]"
      aria-label="Changes since you trusted this plugin" tabIndex={0}>
      {lines.map((line, index) => line.kind === 'skip'
        ? <div key={index} className="select-none py-0.5 text-[var(--ca-ink-muted)]">⋯ {line.count} unchanged line{line.count === 1 ? '' : 's'}</div>
        : <div key={index} className={`flex gap-3 whitespace-pre ${line.kind === 'add' ? 'bg-emerald-500/15' : line.kind === 'remove' ? 'bg-red-500/15' : ''}`}>
          <span aria-hidden="true" className="w-8 shrink-0 select-none text-right text-[var(--ca-ink-muted)]">{line.newLine ?? line.oldLine}</span>
          <span aria-hidden="true" className="w-3 shrink-0 select-none">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''}</span>
          <span><span className="sr-only">{line.kind === 'add' ? 'Added: ' : line.kind === 'remove' ? 'Removed: ' : ''}</span>{line.text || ' '}</span>
        </div>)}
    </pre>
  )
}

/** Shows exactly what would run, what changed since trust, and earlier trusted versions. */
function PluginReviewPanel({ entry }: { entry: PluginInventoryEntry & { file: string } }) {
  const [review, setReview] = useState<PluginReview | null | undefined>(undefined)
  const [diff, setDiff] = useState<DiffLine[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    const next = await reviewPlugin(entry.file)
    setReview(next)
    setDiff(null)
    if (next?.pin && next.pin !== next.hash) {
      const trusted = await trustedPluginSource(entry.file, next.pin)
      if (trusted !== null) setDiff(lineDiff(trusted, next.source))
    }
  }, [entry.file])

  useEffect(() => { void load() }, [load, entry.status])

  if (review === undefined) return <p className="text-[11px] text-[var(--ca-ink-muted)]" role="status">Reading plugin…</p>
  if (review === null) return <p className="text-[11px] text-red-600" role="alert">Couldn't read this plugin's file.</p>

  const trusted = review.pin === review.hash
  const earlier = review.versions.filter((hash) => hash !== review.hash)
  const act = async (action: () => Promise<boolean>, done: string) => {
    setBusy(true)
    setNote(null)
    try {
      const ok = await action()
      setNote(ok ? done : 'Nothing changed.')
    } finally {
      setBusy(false)
      await load()
    }
  }

  return (
    <div className="mt-2 space-y-2 border-t border-[var(--ca-border)] pt-2" data-testid={`plugin-review-${entry.id}`}>
      <p className="text-[11px] text-[var(--ca-ink-soft)]">
        {trusted ? 'You trusted this exact version.' : review.pin ? 'Changed since you trusted it. Review the changes before trusting it again.' : 'Not trusted yet. Read the code before you trust it: a plugin runs with the full authority of Hermes Desk.'}
        {' '}<span className="font-mono">SHA-256 {shortHash(review.hash)}…</span> · {review.source.split('\n').length} lines
      </p>
      {diff ? <DiffView lines={diff} /> : <SourceView source={review.source} />}
      {diff && <details><summary className="cursor-pointer text-[11px] text-[var(--ca-ink-soft)]">Full source</summary><SourceView source={review.source} /></details>}
      <div className="flex flex-wrap gap-2">
        {!trusted && <button type="button" disabled={busy} className="nub-btn-primary px-2.5 py-1 text-[11px]"
          onClick={() => void act(async () => {
            await setPluginEnabled(entry.id, true)
            const after = await reviewPlugin(entry.file)
            return Boolean(after?.pin && after.pin === after.hash)
          }, 'Trusted and loaded.')}>Trust this version</button>}
        {review.pin && !trusted && review.versions.includes(review.pin) && <button type="button" disabled={busy}
          className="rounded-full border border-[var(--ca-ink)]/30 px-2.5 py-1 text-[11px] font-medium text-[var(--ca-ink)] hover:bg-[var(--ca-ink)]/10 disabled:opacity-50"
          onClick={() => void act(() => restorePluginVersion(entry.file, review.pin!), 'Restored the trusted version.')}>Restore trusted version</button>}
      </div>
      {earlier.filter((hash) => hash !== review.pin || trusted).length > 0 && <div className="space-y-1">
        <p className="text-[11px] font-medium text-[var(--ca-ink-soft)]">Earlier trusted versions</p>
        {earlier.filter((hash) => hash !== review.pin || trusted).map((hash) => <div key={hash} className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-[var(--ca-ink-muted)]">SHA-256 {shortHash(hash)}…</span>
          <button type="button" disabled={busy} aria-label={`Roll back to version ${shortHash(hash)}`}
            className="rounded-full border border-[var(--ca-ink)]/30 px-2.5 py-1 text-[11px] font-medium text-[var(--ca-ink)] hover:bg-[var(--ca-ink)]/10 disabled:opacity-50"
            onClick={() => void act(() => restorePluginVersion(entry.file, hash), 'Rolled back.')}>Roll back</button>
        </div>)}
      </div>}
      {note && <p className="text-[11px] text-[var(--ca-ink-soft)]" role="status">{note}</p>}
    </div>
  )
}

const STATUS_LABEL: Record<PluginInventoryEntry['status'], string> = {
  loading: 'Loading',
  loaded: 'Loaded',
  disabled: 'Disabled',
  error: 'Error',
}

const STATUS_TONE: Record<PluginInventoryEntry['status'], string> = {
  loading: 'text-[var(--ca-ink-muted)]',
  loaded: 'text-[var(--ca-ink)]',
  disabled: 'text-[var(--ca-ink-muted)]',
  error: 'text-red-600',
}

function PluginRow({ entry }: { entry: PluginInventoryEntry }) {
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const active = entry.status === 'loaded' || entry.status === 'loading'

  const toggle = async () => {
    setBusy(true)
    try {
      await setPluginEnabled(entry.id, !active)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2"
      data-testid={`plugin-row-${entry.id}`}
    >
      <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-[var(--ca-ink)]">{entry.name}</p>
        <p className="truncate text-[11px] text-[var(--ca-ink-muted)]">
          {entry.description || entry.id}
          {entry.error ? ` — ${entry.error}` : ''}
        </p>
        <p className={`text-[11px] font-medium ${STATUS_TONE[entry.status]}`}>
          {STATUS_LABEL[entry.status]}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {entry.file && <button type="button" aria-expanded={reviewing} onClick={() => setReviewing((open) => !open)}
          className="rounded-full border border-[var(--ca-ink)]/30 px-2.5 py-1 text-[11px] font-medium text-[var(--ca-ink)] hover:bg-[var(--ca-ink)]/10">
          {reviewing ? 'Hide code' : 'Review code'}</button>}
        <Switch label={`Toggle ${entry.name}`} checked={active} busy={busy} onChange={() => void toggle()} />
      </div>
      </div>
      {reviewing && entry.file && <PluginReviewPanel entry={{ ...entry, file: entry.file }} />}
    </div>
  )
}

export function PluginSettings() {
  const inventory = usePluginInventory()
  const panes = usePluginPanes()
  const [reloading, setReloading] = useState(false)

  const reload = async () => {
    setReloading(true)
    try {
      await discoverRuntimePlugins()
    } finally {
      setReloading(false)
    }
  }

  return (
    <div className="space-y-3" data-testid="plugin-settings">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-[var(--ca-ink-muted)]">
          {inventory.length === 0
            ? 'No desktop plugins yet. Ask an agent to build one, or add a plugin.js folder under ~/.hermes/desktop-plugins/.'
            : `${inventory.length} desktop plugin${inventory.length === 1 ? '' : 's'}`}
        </p>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={reloading}
          className="rounded-full border border-[var(--ca-ink)]/30 px-2.5 py-1 text-[11px] font-medium text-[var(--ca-ink)] hover:bg-[var(--ca-ink)]/10 disabled:opacity-50"
        >
          {reloading ? 'Reloading…' : 'Reload desktop plugins'}
        </button>
      </div>
      {inventory.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--ca-border)] px-3 py-6 text-center text-[12px] text-[var(--ca-ink-muted)]">
          The plugin host scans ~/.hermes/desktop-plugins on this machine. Drop a folder with
          plugin.js there and reload.
        </p>
      ) : (
        <div className="space-y-2">
          {inventory.map((entry) => (
            <PluginRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}

      {panes.length > 0 && (
        <div className="space-y-3 pt-2">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-[var(--ca-ink-muted)]">
            Plugin panes
          </p>
          {panes.map((pane) => (
            <div
              key={pane.id}
              className="rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] p-3"
              data-testid={`plugin-pane-${pane.id}`}
            >
              <p className="mb-2 text-[12px] font-medium text-[var(--ca-ink)]">{pane.title}</p>
              <div className="text-[var(--ca-ink)]"><PluginRender id={pane.id} render={pane.render} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
