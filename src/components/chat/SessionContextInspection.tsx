import { useEffect, useRef, useState } from 'react'
import type { SessionContextSnapshot } from '../../lib/agents/session-context'

export function SessionContextInspection({ inspect, offline }: {
  inspect: () => Promise<SessionContextSnapshot>; offline?: boolean
}) {
  const [data, setData] = useState<SessionContextSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const generation = useRef(0)
  const busy = useRef(false)
  useEffect(() => () => { generation.current++ }, [])
  async function read() {
    if (busy.current || offline) return
    busy.current = true
    const owner = generation.current
    setLoading(true); setError(false)
    try {
      const result = await inspect()
      if (generation.current === owner) setData(result)
    } catch {
      if (generation.current === owner) { setData(null); setError(true) }
    } finally {
      if (generation.current === owner) { busy.current = false; setLoading(false) }
    }
  }
  return <section className="chat-context-inspection" aria-label="Native chat context">
    <header>
    <button type="button" disabled={offline || loading} onClick={() => void read()}>
      {loading ? 'Inspecting context…' : data ? 'Refresh chat context' : 'Inspect chat context'}
    </button>
    {data && <span><strong>{data.used.toLocaleString()} tokens</strong>{data.maximum > 0 && ` of ${data.maximum.toLocaleString()}`}
      <br />{data.categories.length === 0 ? 'Last usage snapshot' :
        data.estimated ? 'Estimated context' : 'Provider-reported context'}</span>}
    </header>
    {offline && <p>Offline. Any inspection below is last reported, not live.</p>}
    {loading && <p role="status">Reading Hermes’s context breakdown…</p>}
    {error && <p role="alert">Context is unavailable. Reconnect or finish a turn, then retry. Nothing was changed.</p>}
    {data && <>
      <p>Categories are estimates, not billing or a spending limit.</p>
      {data.categories.length ? <dl className="chat-context-categories">{data.categories.map((row, index) =>
        <div key={`${row.id}:${index}`}><dt>{row.label}</dt><dd>~{row.tokens.toLocaleString()}</dd></div>)}</dl>
        : <p>No category data yet. Hermes may not have built this session’s agent.</p>}
      <details><summary>Instruction files · re-derived manifest</summary>
        <p>Hermes rechecks file status. This is not a snapshot of the cached prompt. File edits may apply only to a new session.</p>
        {data.files.length ? <ul>{data.files.map((row, index) =>
          <li key={`${row.path}:${index}`}><strong>{row.label}</strong> · {row.loaded ? 'Loaded' : 'Not loaded'} · {row.status}
            <br /><code>{row.path}</code><br />~{row.tokens.toLocaleString()} tokens</li>)}</ul>
          : <p>No instruction files reported. This does not mean memory is empty.</p>}
      </details>
    </>}
  </section>
}
