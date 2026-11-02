/**
 * Plugin pieces of the unified Marketplace (Grok Bot parity, see
 * Marketplace.tsx): the catalog row, the setup page for plugins that declare
 * keys, the "N installed" control and the Installed ("Manage plugins") page.
 * State and actions come from useMcpPlugins.
 */
import { Suspense, lazy, useState, type FormEvent } from 'react'
import type { McpMarketItem } from '../../lib/mcp-catalog'
import type { McpServer } from '../../lib/mcp'
import type { CustomServerInput, McpPlugins } from './useMcpPlugins'

/** Brand marks stay off the default chunk. */
const PluginMarkLazy = lazy(() => import('../PluginMark').then((m) => ({ default: m.PluginMark })))

function Mark({ id, name, size = 'md' }: { id: string; name: string; size?: 'md' | 'sm' | 'xs' }) {
  return (
    <Suspense fallback={<span className={`mk-mark-fallback mk-mark-fallback--${size}`} aria-hidden="true" />}>
      <PluginMarkLazy id={id} name={name} size={size} />
    </Suspense>
  )
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const fieldClass =
  'w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5 text-sm text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:border-[var(--ca-primary)]'
const pillClass =
  'rounded-full border border-[var(--ca-border)] px-2.5 py-0.5 text-[11px] text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)] disabled:opacity-40'

/** One catalog row: mark, name, one-line description, Add / spinner / Added. */
export function PluginRow({
  item,
  plugins,
  onAdd,
}: {
  item: McpMarketItem
  plugins: McpPlugins
  onAdd: (item: McpMarketItem) => void
}) {
  const installed = plugins.isInstalled(item)
  const pending = plugins.catalogBusy === item.id
  return (
    <li className="mk-row" data-testid="mk-plugin-row" data-plugin={item.id}>
      <div className="mk-row__open mk-row__open--static">
        <span className="mk-row__icon">
          <Mark id={item.id} name={item.displayName} />
        </span>
        <span className="mk-row__main">
          <span className="mk-row__line">
            <span className="mk-row__name">{item.displayName}</span>
          </span>
          <span className="mk-row__sub">{item.description}</span>
        </span>
      </div>
      <span className="mk-row__trailing">
        {installed ? (
          <span className="mk-badge">
            <Check />
            Added
          </span>
        ) : pending ? (
          <span className="mk-pending" role="status" aria-label={`Adding ${item.displayName}`}>
            <span className="mk-spinner" aria-hidden="true" />
          </span>
        ) : (
          <button
            type="button"
            className="mk-btn"
            disabled={!plugins.available}
            onClick={() => onAdd(item)}
            aria-label={`Add ${item.displayName}`}
          >
            Add
          </button>
        )}
      </span>
    </li>
  )
}

/** Grok "Plugin Setup": the declared keys, then Add. */
export function PluginSetup({
  item,
  plugins,
  onBack,
  onDone,
}: {
  item: McpMarketItem
  plugins: McpPlugins
  onBack: () => void
  onDone: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const env = item.entry?.requiredEnv ?? []
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const out = await plugins.install(item, values)
    if (out === 'ok') onDone()
  }
  return (
    <form className="mk-detail" onSubmit={(e) => void submit(e)} data-testid="mk-plugin-setup">
      <button type="button" className="mk-btn mk-back" onClick={onBack}>
        ‹ Back to Marketplace
      </button>
      <div className="mk-detail__hero">
        <Mark id={item.id} name={item.displayName} />
        <div>
          <h3 className="mk-detail__name">Set up {item.displayName}</h3>
          <div className="mk-detail__byline">Fill in the required fields to continue.</div>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {env.map((v) => (
          <label key={v.name} className="text-[12px] font-medium text-[var(--ca-ink)]">
            {v.prompt}
            {v.required ? '' : ' (optional)'}
            <input
              type={/KEY|TOKEN|SECRET|PASSWORD/i.test(v.name) ? 'password' : 'text'}
              autoComplete="off"
              value={values[v.name] ?? ''}
              onChange={(e) => setValues((o) => ({ ...o, [v.name]: e.target.value }))}
              className={`${fieldClass} mt-1 font-normal`}
            />
          </label>
        ))}
      </div>
      {plugins.catalogError ? (
        <p className="mk-detail__note mk-row__sub--error" role="alert">
          {plugins.catalogError}
        </p>
      ) : null}
      <div className="mk-detail__actions">
        <button type="submit" className="mk-btn mk-btn--primary" disabled={plugins.catalogBusy === item.id}>
          {plugins.catalogBusy === item.id ? 'Adding…' : 'Add plugin'}
        </button>
      </div>
    </form>
  )
}

/** Title-row control: stacked marks + "N installed ›" (Grok `Aa`). */
export function InstalledPreview({ servers, onOpen }: { servers: McpServer[]; onOpen: () => void }) {
  return (
    <button type="button" className="mk-installed" onClick={onOpen} aria-label="Your plugins">
      {servers.length > 0 ? (
        <span className="mk-installed__marks" aria-hidden="true">
          {servers.slice(0, 4).map((s) => (
            <span key={s.name} className="mk-installed__mark">
              <Mark id={s.name} name={s.name} size="sm" />
            </span>
          ))}
        </span>
      ) : null}
      <span>{servers.length} installed</span>
      <span aria-hidden="true">›</span>
    </button>
  )
}

const EMPTY_CUSTOM: CustomServerInput = { name: '', url: '', command: '', args: '', token: '', env: '' }

function CustomServerForm({ plugins, onDone }: { plugins: McpPlugins; onDone: () => void }) {
  const [f, setF] = useState<CustomServerInput>(EMPTY_CUSTOM)
  const [adding, setAdding] = useState(false)
  const set = (k: keyof CustomServerInput) => (e: { target: { value: string } }) =>
    setF((o) => ({ ...o, [k]: e.target.value }))
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setAdding(true)
    const ok = await plugins.addCustom(f)
    setAdding(false)
    if (ok) {
      setF(EMPTY_CUSTOM)
      onDone()
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="mb-4 flex flex-col gap-2 rounded-xl border border-[var(--ca-border)] p-3">
      <p className="text-[12px] font-medium text-[var(--ca-ink)]">Custom server</p>
      <input aria-label="Server name" value={f.name} onChange={set('name')} placeholder="Name — e.g. my-tools" className={fieldClass} />
      <input aria-label="HTTPS endpoint" value={f.url} onChange={set('url')} placeholder="HTTPS endpoint — e.g. https://mcp.example.com/mcp" className={fieldClass} />
      <input aria-label="Stdio command" value={f.command} onChange={set('command')} placeholder="Stdio command — e.g. uvx (runs on the agent VM)" className={fieldClass} />
      <input aria-label="Stdio args" value={f.args} onChange={set('args')} placeholder="Stdio args (optional)" className={fieldClass} />
      <input
        aria-label="API key"
        type="password"
        autoComplete="off"
        value={f.token}
        onChange={set('token')}
        placeholder="API key (optional, for HTTPS servers — sent as a Bearer header)"
        className={fieldClass}
      />
      <textarea
        aria-label="Environment variables"
        value={f.env}
        onChange={set('env')}
        rows={2}
        spellCheck={false}
        placeholder="Environment variables (optional, for command servers) — one KEY=VALUE per line"
        className={`${fieldClass} font-mono text-[12px]`}
      />
      <div className="flex justify-end">
        <button type="submit" disabled={adding || !f.name.trim()} className="mk-btn mk-btn--primary">
          {adding ? 'Adding…' : 'Add server'}
        </button>
      </div>
    </form>
  )
}

/** Grok "Manage plugins": what's on the agent, with its actions. */
export function InstalledPage({ plugins, onBack }: { plugins: McpPlugins; onBack: () => void }) {
  const [showCustom, setShowCustom] = useState(false)
  /** Rows showing their secondary actions (Tools, Disable). */
  const [more, setMore] = useState<Set<string>>(() => new Set())
  const toggleMore = (name: string) =>
    setMore((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  const { servers } = plugins
  return (
    <div className="mk-detail" data-testid="mk-installed">
      <div className="flex items-center gap-2">
        <button type="button" className="mk-btn mk-back" onClick={onBack}>
          ‹ Back to Marketplace
        </button>
        <span className="ml-auto flex gap-1.5">
          {plugins.available ? (
            <button type="button" className="mk-btn" onClick={() => setShowCustom((v) => !v)}>
              {showCustom ? 'Cancel' : '+ Custom server'}
            </button>
          ) : null}
        </span>
      </div>
      <h3 className="mk-page-title">Manage plugins</h3>
      {showCustom ? <CustomServerForm plugins={plugins} onDone={() => setShowCustom(false)} /> : null}
      {!plugins.available ? (
        <p className="mk-empty">Plugins need the desktop app so it can reach the agent VM.</p>
      ) : plugins.loading && servers.length === 0 ? (
        <p className="mk-empty">Loading plugins…</p>
      ) : servers.length === 0 ? (
        <p className="mk-empty">Nothing installed yet. Add a plugin from the Marketplace.</p>
      ) : (
        <ul className="flex flex-col">
          {servers.map((s) => (
            <li key={s.name} className="flex flex-col gap-1.5 border-b border-[var(--ca-border)] py-3 last:border-0">
              <div className="flex items-center gap-3">
                <Mark id={s.name} name={s.name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-[var(--ca-ink)]">{s.name}</p>
                  <p className="truncate text-[12px] text-[var(--ca-ink-muted)]">
                    {s.status ?? (s.enabled === false ? 'off' : 'installed')}
                    {s.auth ? ` · ${s.auth}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1 pl-[52px]">
                {(s.auth === 'oauth' || !s.command) &&
                  (plugins.authActive(s.name) ? (
                    <button type="button" onClick={() => plugins.cancelAuth(s.name)} className={pillClass}>
                      Cancel sign-in
                    </button>
                  ) : (
                    <button type="button" disabled={plugins.busy === s.name} onClick={() => void plugins.auth(s.name)} className={pillClass}>
                      Sign in
                    </button>
                  ))}
                <button
                  type="button"
                  disabled={plugins.removing === s.name}
                  onClick={() => void plugins.remove(s.name)}
                  className="rounded-full border border-[var(--ca-danger)]/30 px-2.5 py-0.5 text-[11px] text-[var(--ca-danger)] hover:bg-[var(--ca-danger)]/8 disabled:opacity-40"
                >
                  {plugins.removing === s.name ? 'Removing…' : 'Remove'}
                </button>
                <button
                  type="button"
                  aria-expanded={more.has(s.name)}
                  onClick={() => toggleMore(s.name)}
                  className={pillClass}
                >
                  {more.has(s.name) ? 'Less' : 'More'}
                </button>
                {more.has(s.name) ? (
                  <>
                    <button type="button" disabled={plugins.busy === s.name} onClick={() => void plugins.test(s.name)} className={pillClass}>
                      {plugins.busy === s.name ? 'Testing…' : 'Tools'}
                    </button>
                    {s.enabled !== undefined && (
                      <button type="button" disabled={plugins.busy === s.name} onClick={() => void plugins.toggle(s)} className={pillClass}>
                        {s.enabled === false ? 'Enable' : 'Disable'}
                      </button>
                    )}
                  </>
                ) : null}
              </div>
              {plugins.authState[s.name] && (
                <p className="ml-[52px] flex items-center gap-1.5 text-[11px] text-[var(--ca-ink-muted)]" role="status">
                  {plugins.authActive(s.name) && (
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border border-[var(--ca-border-strong)] border-t-[var(--ca-primary-fill)]" />
                  )}
                  {plugins.authState[s.name]}
                </p>
              )}
              {plugins.toolsByServer[s.name] && plugins.toolsByServer[s.name].length > 0 && (
                <ul className="ml-[52px] space-y-0.5 rounded-lg bg-[var(--ca-primary-soft)]/50 px-2 py-1.5">
                  {plugins.toolsByServer[s.name].map((t) => (
                    <li key={t.name} className="truncate text-[11px] text-[var(--ca-ink-muted)]">
                      <span className="font-mono text-[var(--ca-ink)]">{t.name}</span>
                      {t.description ? <span className="ml-1">{t.description}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              {plugins.testOutput[s.name] && (
                <pre className="ml-[52px] max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/[0.04] px-2 py-1.5 text-[10px] text-[var(--ca-ink-muted)]">
                  {plugins.testOutput[s.name]}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export { Mark as PluginMarkLazy }
