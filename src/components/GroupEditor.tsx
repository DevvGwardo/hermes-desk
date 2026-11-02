import { useEffect, useRef, useState } from 'react'
import { resolveAgentMascot, type Agent } from '../lib/agents'
import { groupAutoName, roomChief } from '../lib/agents/rooms'
import { AppModal } from './AppModal'
import { FatCatIcon } from './FatCatIcon'

export type NewGroupInput = {
  /** Blank → the room is auto-named from its members until renamed. */
  name: string
  memberAgentIds: string[]
}

/** One-time "rooms cost more" notice, dismissed per device. */
export const GROUP_USAGE_NOTICE_KEY = 'nub:group-usage-notice-dismissed'

function readNoticeDismissed(): boolean {
  try {
    return window.localStorage.getItem(GROUP_USAGE_NOTICE_KEY) === '1'
  } catch {
    return false
  }
}

function writeNoticeDismissed(): void {
  try {
    window.localStorage.setItem(GROUP_USAGE_NOTICE_KEY, '1')
  } catch {
    /* private mode: the notice just shows again next time */
  }
}

function defaultMemberIds(agents: Agent[]): string[] {
  const running = agents.filter((a) => a.status === 'running')
  const pool = running.length > 0 ? running : agents
  return pool.slice(0, 2).map((a) => a.id)
}

/** "Chief of Staff leads this room" — named when the Chief has its own name,
 *  and saying so when it leads without being picked as a member. */
export function chiefHint(chief: Agent | null, isMember = true): string | null {
  if (!chief) return null
  const name = chief.name.trim()
  const who = !name || /^chief of staff$/i.test(name) ? 'Chief of Staff' : `${name} (Chief of Staff)`
  return isMember ? `${who} leads this room` : `${who} leads this room without being a member`
}

/**
 * Create a group room: pick members, optionally name it. Shared by the
 * desktop/web sidebar ("+ New group") and the phone home screen.
 */
export function GroupEditor(props: {
  open: boolean
  agents: Agent[]
  /** Rooms are on for this account. Without them there's no Chief routing,
   *  so the Chief hint stays hidden (undefined = not known yet). */
  chiefRouting?: boolean
  onClose: () => void
  onCreate: (input: NewGroupInput) => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [noticeDismissed, setNoticeDismissed] = useState(readNoticeDismissed)
  const nameRef = useRef<HTMLInputElement>(null)
  const creationEpoch = useRef(0)
  // Read at open only: the roster array is replaced on every sync or status
  // change, and that must not wipe a half-made group (or steal focus back to
  // Name) while the editor is open. Same pattern as RoutineEditor.
  const agentsRef = useRef(props.agents)
  agentsRef.current = props.agents

  useEffect(() => {
    creationEpoch.current += 1
    if (!props.open) return
    setName('')
    setMemberIds(defaultMemberIds(agentsRef.current))
    setCreating(false)
    setError('')
    const frame = requestAnimationFrame(() => nameRef.current?.focus({ preventScroll: true }))
    return () => {
      creationEpoch.current += 1
      cancelAnimationFrame(frame)
    }
  }, [props.open])

  const toggle = (id: string) => {
    setMemberIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  // Members in roster order so the auto-name is stable while toggling.
  const ordered = props.agents.filter((a) => memberIds.includes(a.id))
  const autoName = groupAutoName(ordered.map((a) => a.name.trim()).filter(Boolean))
  const lead = props.chiefRouting ? roomChief(ordered.map((a) => a.id), props.agents) : null
  const hint = chiefHint(lead, !lead || memberIds.includes(lead.id))

  const commit = async () => {
    if (memberIds.length === 0 || creating) return
    setCreating(true)
    setError('')
    const epoch = creationEpoch.current
    try {
      await props.onCreate({ name: name.trim(), memberAgentIds: ordered.map((a) => a.id) })
    } catch (err) {
      if (epoch !== creationEpoch.current) return
      setError(err instanceof Error ? err.message : 'Could not create group.')
      setCreating(false)
    }
  }

  return (
    <AppModal open={props.open} onClose={props.onClose} title="Create group" size="md">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {!noticeDismissed && (
          <div
            data-testid="group-usage-notice"
            role="note"
            className="flex items-start gap-2 rounded-xl bg-[var(--ca-primary-soft)] px-3 py-2 text-[12px] text-[var(--ca-ink)]"
          >
            <span className="min-w-0 flex-1">
              Group rooms use more of your usage — each member that answers is a separate request.
            </span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => {
                writeNoticeDismissed()
                setNoticeDismissed(true)
              }}
              className="shrink-0 rounded-full px-1.5 leading-none text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]"
            >
              ×
            </button>
          </div>
        )}

        <label className="block">
          <span className="mb-0.5 block text-[11px] font-medium text-[var(--ca-ink-muted)]">Name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void commit()
              }
            }}
            placeholder={autoName}
            aria-describedby="group-name-hint"
            className="w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5 text-sm text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:border-[var(--ca-focus-ring)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ca-focus-ring)]"
          />
        </label>
        <span id="group-name-hint" className="-mt-2.5 block text-[11px] text-[var(--ca-ink-muted)]">
          Leave blank to name it after its members.
        </span>

        <div>
          <div className="mb-1.5 text-[11px] font-medium text-[var(--ca-ink-muted)]">Members</div>
          {props.agents.length === 0 ? (
            <p className="text-sm text-[var(--ca-ink-muted)]">Create an agent first.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {props.agents.map((agent) => {
                const mascot = resolveAgentMascot(agent)
                const on = memberIds.includes(agent.id)
                const title = agent.persona?.title?.trim()
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(agent.id)}
                      className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-[var(--ca-ink)] ${
                        on ? 'bg-[var(--ca-primary-soft)]' : 'hover:bg-[var(--ca-hover)]'
                      }`}
                    >
                      <FatCatIcon still size={32} shape={mascot.shape} fgColor={mascot.color} framed={false} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{agent.name}</span>
                        {title && title !== agent.name ? (
                          <span className="block truncate text-[11px] text-[var(--ca-ink-muted)]">{title}</span>
                        ) : null}
                      </span>
                      <span className="text-[11px] text-[var(--ca-ink-muted)]">{on ? 'Added' : 'Add'}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {hint ? (
          <p data-testid="group-chief-hint" className="text-[12px] text-[var(--ca-ink-muted)]">
            {hint}. Messages without an @mention go to them first.
          </p>
        ) : null}

        {error ? <p className="text-sm text-[var(--ca-danger)]">{error}</p> : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--ca-border)] px-4 py-3">
        <button type="button" className="rounded-full px-3 py-1.5 text-sm text-[var(--ca-ink-muted)]" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          disabled={memberIds.length === 0 || creating}
          className="nub-btn-primary px-3 py-1.5 text-sm disabled:opacity-45"
          onClick={() => void commit()}
        >
          {creating ? 'Creating…' : 'Create group'}
        </button>
      </div>
    </AppModal>
  )
}
