import { useEffect, useRef, useState } from 'react'
import type { NativeDelegationActions, NativeDelegationSnapshot, NativeDelegateTail } from '../../lib/agents/native-delegation'

/** Deliberate reads only. Hermes owns child authority and lifetime, not the saved Desk row. */
export function NativeDelegationInspection({ actions, offline }: {
  actions: NativeDelegationActions; offline?: boolean
}) {
  const [data, setData] = useState<NativeDelegationSnapshot | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tail, setTail] = useState<NativeDelegateTail | null>(null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [controlsBlocked, setControlsBlocked] = useState(false)
  const pending = useRef(false)
  const lifetime = useRef(0)
  useEffect(() => () => { lifetime.current++ }, [])
  async function perform(operation: () => Promise<void>) {
    if (offline || pending.current) return
    pending.current = true
    const owner = lifetime.current
    setBusy(true); setNotice('')
    try { await operation() }
    catch {
      if (owner === lifetime.current) {
        setControlsBlocked(true)
        setNotice('Request unavailable or acknowledgment lost. Inspect tasks before trying again. No automatic retry was sent.')
      }
    } finally {
      if (owner === lifetime.current) { pending.current = false; setBusy(false) }
    }
  }
  async function read() {
    const owner = lifetime.current
    const result = await actions.list()
    if (owner !== lifetime.current) return
    setData(result); setTail(null); setControlsBlocked(false)
    if (!result.subagents.some(row => row.subagent_id === selected)) { setSelected(null); setDraft('') }
  }
  const child = data?.subagents.find(row => row.subagent_id === selected)
  return <section className="chat-context-inspection native-delegates" aria-label="Native delegated tasks">
    <header><button type="button" disabled={offline || busy} onClick={() => void perform(read)}>
      {busy ? 'Contacting Hermes…' : data ? 'Refresh delegated tasks' : 'Inspect delegated tasks'}
    </button>{notice && <p role="status">{notice}</p>}</header>
    <p>Native <code>delegate_task</code> children in this chat, not Desk helper chats. Live handles may disappear when tasks finish or the backend restarts. An absent handle is not proof of success.</p>
    {offline && <p>Offline. Previously reported tasks cannot be controlled.</p>}
    {data && <>
      {!data.subagents.length && <p>No live delegated children reported for this chat.</p>}
      <ul>{data.subagents.map(row => <li key={row.subagent_id}>
        <button type="button" disabled={busy || offline} aria-pressed={selected === row.subagent_id}
          onClick={() => { setSelected(row.subagent_id); setTail(null); setDraft(''); setNotice('') }}>
          {row.goal || row.subagent_id}
        </button>
        <span> · {row.status || 'Live handle'}{row.last_tool && ` · Last started tool: ${row.last_tool}`}</span>
      </li>)}</ul>
      {data.delegations.map(row => <p key={`${row.delegation_id}:${row.task_index}`}>
        Failed delegation: {row.goal || row.delegation_id}{row.error && ` · ${row.error}`}
      </p>)}
    </>}
    {child && data && <div className="native-delegate-detail">
      <strong>{child.goal || child.subagent_id}</strong>
      <p>Controls require the original session generation. A visible lineage child may no longer be controllable.</p>
      <div className="native-delegate-buttons">
        <button type="button" disabled={offline || busy || controlsBlocked} onClick={() => void perform(async () => {
          const owner = lifetime.current
          const result = await actions.tail(child.subagent_id, data.generation)
          if (owner === lifetime.current) setTail(result)
        })}>Read live transcript</button>
        <button type="button" disabled={offline || busy || controlsBlocked} onClick={() => void perform(async () => {
          const owner = lifetime.current
          const found = await actions.interrupt(child.subagent_id, data.generation)
          if (owner === lifetime.current) setNotice(found
            ? 'Stop requested. Hermes acknowledged the interrupt, not completion.'
            : 'No controllable live child found. It may have finished or belong to an earlier session generation.')
        })}>Request stop</button>
      </div>
      {tail && (tail.available ? <>
        <p>Live transcript only{tail.truncated ? ', last 16 KiB' : ''}. It may contain private task content.</p>
        <pre>{tail.text}</pre>
      </> : <p>Live transcript unavailable. It may not exist yet, or this generation cannot read it.</p>)}
      <label>Steer at the next iteration
        <textarea value={draft} maxLength={16384} disabled={offline || busy}
          onChange={event => setDraft(event.target.value)} />
      </label>
      <button type="button" disabled={offline || busy || controlsBlocked || !draft.trim() || child.accepting_steer === false}
        onClick={() => void perform(async () => {
          const owner = lifetime.current
          const queued = await actions.steer(child.subagent_id, draft, data.generation)
          if (owner !== lifetime.current) return
          if (queued) setDraft('')
          setNotice(queued ? 'Steering queued, not confirmed delivered. Hermes may miss it if the child finishes first.'
            : 'Steering rejected. Your draft is preserved. Refresh the task before trying again.')
        })}>Queue steering</button>
    </div>}
  </section>
}
