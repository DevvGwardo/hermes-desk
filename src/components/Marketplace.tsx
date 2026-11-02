/**
 * Marketplace — Grok Bot parity: ONE store for plugins and agents.
 *
 * Grok's Marketplace (features/plugins/overlay/view.tsx) is a single overlay
 * with one search box, sections of 4 rows with "View all" drill-in pages,
 * and an "N installed ›" control that opens "Manage plugins". The old Nub
 * Plugins dialog (McpPanel) and agent store were two dialogs; this merges
 * them. Plugin state/actions: marketplace/useMcpPlugins.ts. Agent rows:
 * Add creates the agent with the listing's persona and mascot
 * (profileForListing) — it becomes a chat in the sidebar and someone your
 * Chief of Staff can hand work to.
 * Routines (lib/marketplace/routines.ts) are ready-made schedules: Use opens
 * the routine editor pre-filled, so nothing runs until the user creates it.
 * Styles: marketplace.css (Grok Bot 0.58 metrics on the Nub tokens).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { McpMarketItem } from '../lib/mcp-catalog'
import type { Agent, NewAgentProfile } from '../lib/agents'
import { isOrchestrator } from '../lib/peer-roster'
import { describeCronSchedule, type RoutineDraft } from '../lib/routines'
import { ROUTINE_RECIPES, draftForRecipe, type RoutineRecipe } from '../lib/marketplace/routines'
import {
  MARKETPLACE_AUTHOR,
  MARKETPLACE_LISTINGS,
  SHELVES,
  addedAgentId,
  profileForListing,
  type MarketplaceListing,
} from '../lib/marketplace/catalog'
import { AppModal } from './AppModal'
import { AppsIcon, type HubShortcut } from './HubShortcuts'
import { FatCatIcon } from './FatCatIcon'
import { InstalledPage, InstalledPreview, PluginRow, PluginSetup } from './marketplace/PluginViews'
import { useMcpPlugins } from './marketplace/useMcpPlugins'
import './marketplace.css'

/** Plugins the home page features first (Grok: curated FEATURED entries).
 *  Only ids the agent's catalog actually offers are shown. */
export const FEATURED_PLUGIN_IDS = [
  'gmail',
  'google-calendar',
  'google-drive',
  'github',
  'notion',
  'slack',
  'linear',
  'granola',
  'canva',
  'atlassian',
  'sentry',
  'cloudflare',
]

export type MarketplaceView = 'home' | 'installed'

type View =
  | { kind: 'home' }
  | { kind: 'section'; id: string }
  | { kind: 'installed' }
  | { kind: 'setup'; pluginId: string }
  | { kind: 'agent'; slug: string }
  | { kind: 'routine'; slug: string }

interface Section {
  id: string
  title: string
  plugins?: McpMarketItem[]
  agents?: MarketplaceListing[]
  routines?: RoutineRecipe[]
}

/** Placeholder Plugins section while the catalog loads: same height as the
 *  real one (4 rows), so nothing below it jumps when it arrives. */
function PluginSkeleton() {
  return (
    <section className="mk-group" aria-label="Plugins" aria-busy="true">
      <div className="mk-group__head">
        <h3 className="mk-group__title">Plugins</h3>
      </div>
      <ul className="mk-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="mk-row mk-row--skeleton">
            <span className="mk-skel mk-skel--icon" />
            <span className="mk-row__main">
              <span className="mk-skel mk-skel--line" />
              <span className="mk-skel mk-skel--line mk-skel--short" />
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function matchesPlugin(q: string, i: McpMarketItem): boolean {
  return !q || `${i.id} ${i.displayName} ${i.description}`.toLowerCase().includes(q)
}

/** Rows each home section shows before "View all" (2-column grid, so
 *  even numbers fill whole lines). Agents get three lines: they're the
 *  store's main shelf. */
const SHELF_ROWS: Record<string, number> = { plugins: 4, agents: 6, routines: 4 }
const shelfRows = (id: string) => SHELF_ROWS[id] ?? 4

function matchesRoutine(q: string, r: RoutineRecipe): boolean {
  return !q || `${r.name} ${r.tagline}`.toLowerCase().includes(q)
}

/** Routine glyph: a clock in the row's mascot-sized slot. */
function RoutineGlyph({ size = 40 }: { size?: number }) {
  return (
    <span className="mk-routine-glyph" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
        <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

export interface MarketplaceProps {
  open: boolean
  agents: Agent[]
  onClose: () => void
  /**
   * Create the listing's agent (profileForListing). Resolves once the agent is
   * on the roster (the row reads Added); rejects with a message. `ready`, when
   * given, is the VM-side setup finishing in the background: it rejects after
   * a refused add was rolled back, and the row then says why.
   */
  onAdd: (profile: NewAgentProfile) => Promise<void | { ready?: Promise<void> }>
  /** Open the chat with an agent that's already added. */
  onOpenAgent: (agentId: string) => void
  /** Plugins need the agent VM's filesystem bridge (caps.vmFs). Off = agents only. */
  pluginsEnabled?: boolean
  /** Where the dialog opens: the home page, or "Manage plugins". */
  initialView?: MarketplaceView
  /** Open the routine editor pre-filled with a recipe. Off = no Routines section. */
  onUseRoutine?: (draft: Pick<RoutineDraft, 'name' | 'prompt' | 'schedule'>) => void
  /** "Your workspace" tiles on the home page (Routines, Files, Tasks, Skills).
   *  Each closes the hub, then opens its surface. Apps is added here. */
  shortcuts?: HubShortcut[]
}

type RowState =
  | { kind: 'add' }
  | { kind: 'pending' }
  | { kind: 'added'; agentId: string }
  /** A Chief listing when the account already has a (different) Chief. */
  | { kind: 'has-chief'; agent: Agent }

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Mascot({ listing, size }: { listing: MarketplaceListing; size: number }) {
  return <FatCatIcon size={size} still fgColor={listing.body} bgColor={listing.eye} title={listing.name} />
}

export function Marketplace({
  open,
  agents,
  onClose,
  onAdd,
  onOpenAgent,
  pluginsEnabled = false,
  initialView = 'home',
  onUseRoutine,
  shortcuts = [],
}: MarketplaceProps) {
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>({ kind: 'home' })
  const [pending, setPending] = useState<Set<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const plugins = useMcpPlugins(open && pluginsEnabled)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setView(initialView === 'installed' && pluginsEnabled ? { kind: 'installed' } : { kind: 'home' })
    setErrors({})
  }, [open, initialView, pluginsEnabled])

  const chief = useMemo(() => agents.find((a) => isOrchestrator(a)) ?? null, [agents])

  const stateOf = (l: MarketplaceListing): RowState => {
    if (pending.has(l.slug)) return { kind: 'pending' }
    const id = addedAgentId(l, agents)
    if (id) return { kind: 'added', agentId: id }
    if (l.role === 'orchestrator' && chief) return { kind: 'has-chief', agent: chief }
    return { kind: 'add' }
  }

  const add = async (l: MarketplaceListing) => {
    if (pending.has(l.slug)) return
    setPending((s) => new Set(s).add(l.slug))
    setErrors(({ [l.slug]: _drop, ...rest }) => rest)
    const fail = (err: unknown) => {
      const msg = err instanceof Error ? err.message : ''
      setErrors((e) => ({
        ...e,
        [l.slug]: msg.startsWith('not linked')
          ? 'Pair this device with your agent first.'
          : msg || 'Couldn’t add it. Try again.',
      }))
    }
    try {
      const added = await onAdd(profileForListing(l))
      added?.ready?.catch(fail)
    } catch (err) {
      fail(err)
    } finally {
      setPending((s) => {
        const next = new Set(s)
        next.delete(l.slug)
        return next
      })
    }
  }

  const addPlugin = async (item: McpMarketItem) => {
    const out = await plugins.install(item)
    if (out === 'setup') setView({ kind: 'setup', pluginId: item.id })
  }

  const q = query.trim().toLowerCase()
  const matches = (l: MarketplaceListing) =>
    !q || `${l.name} ${l.tagline} ${l.uses.join(' ')}`.toLowerCase().includes(q)

  const trailing = (l: MarketplaceListing) => {
    const s = stateOf(l)
    if (s.kind === 'pending')
      return (
        <span className="mk-pending" role="status" aria-label={`Adding ${l.name}`}>
          <span className="mk-spinner" aria-hidden="true" />
        </span>
      )
    if (s.kind === 'added')
      return (
        <span className="mk-badge" data-testid="mk-added">
          <Check />
          Added
        </span>
      )
    if (s.kind === 'has-chief') return <span className="mk-badge">You have one</span>
    return (
      <button type="button" className="mk-btn" onClick={() => void add(l)} aria-label={`Add ${l.name}`}>
        Add
      </button>
    )
  }

  const agentRow = (l: MarketplaceListing) => (
    <li key={l.slug} className="mk-row" data-testid="mk-row" data-slug={l.slug}>
      <button
        type="button"
        className="mk-row__open"
        onClick={() => setView({ kind: 'agent', slug: l.slug })}
        aria-label={`About ${l.name}`}
      >
        <span className="mk-row__icon">
          <Mascot listing={l} size={40} />
        </span>
        <span className="mk-row__main">
          <span className="mk-row__line">
            <span className="mk-row__name">{l.name}</span>
            <span className="mk-row__byline">by {MARKETPLACE_AUTHOR}</span>
          </span>
          {errors[l.slug] ? (
            <span className="mk-row__sub mk-row__sub--error" role="alert">
              {errors[l.slug]}
            </span>
          ) : (
            <span className="mk-row__sub">{l.tagline}</span>
          )}
        </span>
      </button>
      <span className="mk-row__trailing">{trailing(l)}</span>
    </li>
  )

  const pluginRow = (item: McpMarketItem) => (
    <PluginRow key={`p:${item.id}`} item={item} plugins={plugins} onAdd={(i) => void addPlugin(i)} />
  )

  const startRoutine = (r: RoutineRecipe) => onUseRoutine?.(draftForRecipe(r))

  const routineRow = (r: RoutineRecipe) => (
    <li key={`r:${r.slug}`} className="mk-row" data-testid="mk-routine-row" data-slug={r.slug}>
      <button
        type="button"
        className="mk-row__open"
        onClick={() => setView({ kind: 'routine', slug: r.slug })}
        aria-label={`About ${r.name}`}
      >
        <span className="mk-row__icon">
          <RoutineGlyph />
        </span>
        <span className="mk-row__main">
          <span className="mk-row__line">
            <span className="mk-row__name">{r.name}</span>
          </span>
          {/* The name says what it does; the row's second line says when. */}
          <span className="mk-row__sub">{describeCronSchedule(r.schedule)}</span>
        </span>
      </button>
      <span className="mk-row__trailing">
        <button type="button" className="mk-btn" onClick={() => startRoutine(r)} aria-label={`Use ${r.name}`}>
          Use
        </button>
      </span>
    </li>
  )

  /** Two lists, like Grok's home: plugins (featured first, then A–Z) and
   *  agents (in shelf order). Home previews SHELF_ROWS of each; View all
   *  opens the whole list. */
  const sections = useMemo<Section[]>(() => {
    const out: Section[] = []
    if (pluginsEnabled && plugins.items.length) {
      const rank = (i: McpMarketItem) => {
        const at = FEATURED_PLUGIN_IDS.indexOf(i.id.toLowerCase())
        return at < 0 ? FEATURED_PLUGIN_IDS.length : at
      }
      const sorted = [...plugins.items].sort(
        (a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName),
      )
      out.push({ id: 'plugins', title: 'Plugins', plugins: sorted })
    }
    const agentsInOrder = SHELVES.flatMap((shelf) => MARKETPLACE_LISTINGS.filter((l) => l.shelf === shelf.id))
    out.push({ id: 'agents', title: 'Agents', agents: agentsInOrder })
    if (onUseRoutine) out.push({ id: 'routines', title: 'Routines', routines: ROUTINE_RECIPES })
    return out
  }, [pluginsEnabled, plugins.items, onUseRoutine])

  const grid = (sec: Section) => (
    <ul className="mk-grid">
      {(sec.plugins ?? []).map(pluginRow)}
      {(sec.agents ?? []).map(agentRow)}
      {(sec.routines ?? []).map(routineRow)}
    </ul>
  )

  /** "View all" on Agents: the whole store, under its shelf names. */
  const agentShelves = () =>
    SHELVES.map((shelf) => {
      const rows = MARKETPLACE_LISTINGS.filter((l) => l.shelf === shelf.id)
      if (!rows.length) return null
      return (
        <section key={shelf.id} className="mk-group" aria-label={shelf.title} data-shelf={shelf.id}>
          <div className="mk-group__head">
            <h4 className="mk-group__title mk-group__title--sub">{shelf.title}</h4>
          </div>
          <ul className="mk-grid">{rows.map(agentRow)}</ul>
        </section>
      )
    })

  const homeSections = () =>
    sections.map((sec) => {
      const total = (sec.plugins?.length ?? 0) + (sec.agents?.length ?? 0) + (sec.routines?.length ?? 0)
      const rows = shelfRows(sec.id)
      const preview: Section = {
        ...sec,
        plugins: sec.plugins?.slice(0, rows),
        agents: sec.agents?.slice(0, rows),
        routines: sec.routines?.slice(0, rows),
      }
      return (
        <section key={sec.id} className="mk-group" aria-label={sec.title} data-section={sec.id}>
          <div className="mk-group__head">
            <h3 className="mk-group__title">{sec.title}</h3>
            {total > rows ? (
              <button type="button" className="mk-group__action" onClick={() => setView({ kind: 'section', id: sec.id })}>
                View all
              </button>
            ) : null}
          </div>
          {grid(preview)}
        </section>
      )
    })

  /** The hub's first row: the user's own surfaces, then the store below. */
  const workspace = () => {
    const tiles: HubShortcut[] = [
      ...shortcuts.map((s) => ({
        ...s,
        onSelect: () => {
          onClose()
          s.onSelect()
        },
      })),
      ...(pluginsEnabled
        ? [{ id: 'apps' as const, label: 'Apps', hint: 'Installed plugins', icon: <AppsIcon />, onSelect: () => setView({ kind: 'installed' }) }]
        : []),
    ]
    if (tiles.length === 0) return null
    return (
      <section className="mk-group" aria-label="Your workspace" data-section="workspace">
        <div className="mk-group__head">
          <h3 className="mk-group__title">Your workspace</h3>
        </div>
        <ul className="mk-hub">
          {tiles.map((t) => (
            <li key={t.id}>
              <button type="button" className="mk-hub__tile" data-testid={`hub-${t.id}`} onClick={t.onSelect}>
                <span className="mk-hub__icon">{t.icon}</span>
                <span className="mk-hub__label">{t.label}</span>
                <span className="mk-hub__hint">{t.hint}</span>
                {t.badge ? (
                  <span className="mk-hub__badge" aria-label={`${t.badge} active`}>
                    {t.badge}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </section>
    )
  }

  const back = () => setView({ kind: 'home' })
  const backButton = (
    <button type="button" className="mk-btn mk-back" onClick={back}>
      ‹ Back to Marketplace
    </button>
  )

  const notes = pluginsEnabled ? (
    <>
      {plugins.error || plugins.catalogError ? (
        <p className="mk-note mk-note--error" role="alert">
          {plugins.error ?? plugins.catalogError}
        </p>
      ) : plugins.catalogNote ? (
        <p className="mk-note mk-note--ok" role="status">
          {plugins.catalogNote}
        </p>
      ) : null}
    </>
  ) : null

  let body: ReactNode
  const listing = view.kind === 'agent' ? MARKETPLACE_LISTINGS.find((l) => l.slug === view.slug) ?? null : null
  const recipe = view.kind === 'routine' ? ROUTINE_RECIPES.find((r) => r.slug === view.slug) ?? null : null
  if (recipe) {
    body = (
      <div className="mk-detail" data-testid="mk-routine-detail">
        {backButton}
        <div className="mk-detail__hero">
          <RoutineGlyph size={72} />
          <div>
            <h3 className="mk-detail__name">{recipe.name}</h3>
            <div className="mk-detail__byline">{describeCronSchedule(recipe.schedule)}</div>
          </div>
        </div>
        <p className="mk-detail__about">{recipe.tagline}.</p>
        <div>
          <p className="mk-detail__label">What it does each time</p>
          <p className="mk-detail__prompt">{recipe.prompt}</p>
        </div>
        <div className="mk-detail__actions">
          <button type="button" className="mk-btn mk-btn--primary" onClick={() => startRoutine(recipe)}>
            Use this routine
          </button>
        </div>
        <p className="mk-detail__note">
          You can change the words in [brackets], the time and the agent before you create it. Nothing runs until
          you press Create.
        </p>
      </div>
    )
  } else if (listing) {
    const s = stateOf(listing)
    body = (
      <div className="mk-detail" data-testid="mk-detail">
        {backButton}
        <div className="mk-detail__hero">
          <Mascot listing={listing} size={72} />
          <div>
            <h3 className="mk-detail__name">{listing.name}</h3>
            <div className="mk-detail__byline">
              by {MARKETPLACE_AUTHOR} · {listing.title}
            </div>
          </div>
        </div>
        <p className="mk-detail__about">{listing.about}</p>
        <div>
          <p className="mk-detail__label">Uses</p>
          <div className="mk-chips">
            {listing.uses.map((u) => (
              <span key={u} className="mk-chip">
                {u}
              </span>
            ))}
          </div>
        </div>
        <div className="mk-detail__actions">
          {s.kind === 'added' ? (
            <>
              <span className="mk-badge">
                <Check />
                Added
              </span>
              <button type="button" className="mk-btn mk-btn--primary" onClick={() => onOpenAgent(s.agentId)}>
                Open chat
              </button>
            </>
          ) : s.kind === 'has-chief' ? (
            <button type="button" className="mk-btn mk-btn--primary" onClick={() => onOpenAgent(s.agent.id)}>
              Open {s.agent.name}
            </button>
          ) : (
            <button
              type="button"
              className="mk-btn mk-btn--primary"
              disabled={s.kind === 'pending'}
              onClick={() => void add(listing)}
            >
              {s.kind === 'pending' ? 'Adding…' : `Add ${listing.name}`}
            </button>
          )}
        </div>
        {errors[listing.slug] ? (
          <p className="mk-detail__note mk-row__sub--error" role="alert">
            {errors[listing.slug]}
          </p>
        ) : null}
        <p className="mk-detail__note">
          {s.kind === 'has-chief'
            ? `${s.agent.name} is already your Chief of Staff. You only need one: it leads every group.`
            : 'It runs on your agent’s own computer, like your other agents. You can rename or remove it any time.'}
        </p>
      </div>
    )
  } else if (view.kind === 'installed' && pluginsEnabled) {
    body = (
      <>
        {notes}
        <InstalledPage plugins={plugins} onBack={back} />
      </>
    )
  } else if (view.kind === 'setup' && pluginsEnabled) {
    const item = plugins.items.find((i) => i.id === view.pluginId)
    body = item ? (
      <PluginSetup item={item} plugins={plugins} onBack={back} onDone={back} />
    ) : (
      <div className="mk-detail">{backButton}</div>
    )
  } else if (view.kind === 'section') {
    const sec = sections.find((x) => x.id === view.id)
    body = (
      <div className="mk" data-testid="mk-section-page">
        {backButton}
        <h3 className="mk-page-title">{sec?.title ?? 'Marketplace'}</h3>
        {notes}
        {sec?.id === 'agents' ? agentShelves() : sec ? grid(sec) : null}
      </div>
    )
  } else if (q) {
    const pluginHits = pluginsEnabled ? plugins.items.filter((i) => matchesPlugin(q, i)) : []
    const agentHits = MARKETPLACE_LISTINGS.filter(matches)
    const routineHits = onUseRoutine ? ROUTINE_RECIPES.filter((r) => matchesRoutine(q, r)) : []
    body = (
      <div className="mk" data-testid="marketplace">
        {notes}
        {pluginHits.length + agentHits.length + routineHits.length === 0 ? (
          <p className="mk-empty">Nothing matches “{query.trim()}”.</p>
        ) : (
          <>
            {pluginHits.length ? (
              <section className="mk-group" aria-label="Plugins">
                <div className="mk-group__head">
                  <h3 className="mk-group__title">Plugins</h3>
                </div>
                <ul className="mk-grid">{pluginHits.map(pluginRow)}</ul>
              </section>
            ) : null}
            {agentHits.length ? (
              <section className="mk-group" aria-label="Agents">
                <div className="mk-group__head">
                  <h3 className="mk-group__title">Agents</h3>
                </div>
                <ul className="mk-grid">{agentHits.map(agentRow)}</ul>
              </section>
            ) : null}
            {routineHits.length ? (
              <section className="mk-group" aria-label="Routines">
                <div className="mk-group__head">
                  <h3 className="mk-group__title">Routines</h3>
                </div>
                <ul className="mk-grid">{routineHits.map(routineRow)}</ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    )
  } else {
    body = (
      <div className="mk" data-testid="marketplace">
        {notes}
        {workspace()}
        {pluginsEnabled && !plugins.itemsReady ? <PluginSkeleton /> : null}
        {homeSections()}
      </div>
    )
  }

  const onHome = view.kind === 'home'
  const searchLabel = `Search ${[pluginsEnabled ? 'plugins' : null, 'agents', onUseRoutine ? 'routines' : null]
    .filter(Boolean)
    .join(pluginsEnabled && onUseRoutine ? ', ' : ' and ')
    .replace(/, (?=[^,]*$)/, ' and ')}`
  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Connect apps"
      size="store"
      contentKey={view.kind === 'section' ? `section:${view.id}` : view.kind === 'agent' || view.kind === 'routine' ? `${view.kind}:${view.slug}` : view.kind === 'setup' ? `setup:${view.pluginId}` : `${view.kind}:${q ? 'q' : ''}`}
      actions={
        pluginsEnabled && onHome && plugins.serversLoaded ? (
          <InstalledPreview servers={plugins.servers} onOpen={() => setView({ kind: 'installed' })} />
        ) : undefined
      }
      toolbar={
        onHome ? (
          <input
            className="mk-search"
            type="search"
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : undefined
      }
    >
      {body}
    </AppModal>
  )
}
