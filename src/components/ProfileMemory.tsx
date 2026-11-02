import { useEffect, useRef, useState } from 'react'
import { memorySummary, parseServeMemory, serveGet } from '../lib/hermes-rest'
import { memoryRecoveryCommands } from '../lib/profile-memory'
import { Button } from './ui/Button'
import { Section } from './ui/Section'

/** Status is profile-scoped. The installed content-edit RPCs are not, so they stay inaccessible. */
export function ProfileMemory({ profile, onPrepareReview }: {
  profile: string; onPrepareReview?: (profile: string) => void
}) {
  const [data, setData] = useState<unknown>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const [copied, setCopied] = useState('')
  const lifetime = useRef(0)
  const commands = memoryRecoveryCommands(profile)
  useEffect(() => {
    const generation = ++lifetime.current
    setData(null); setError(''); setCopied('')
    if (!memoryRecoveryCommands(profile)) { setError('Select a valid profile.'); return }
    void serveGet<unknown>(`/api/memory?profile=${encodeURIComponent(profile)}`).then(value => {
      if (lifetime.current !== generation) return
      if (value === null) setError(`Could not load memory status for ${profile}.`)
      else setData(value)
    }).catch(() => {
      if (lifetime.current === generation) setError(`Could not load memory status for ${profile}.`)
    })
    return () => { lifetime.current++ }
  }, [profile, tick])
  async function copy(command: string) {
    const generation = lifetime.current
    try {
      if (window.nubAgent?.clipboard?.writeText) await window.nubAgent.clipboard.writeText(command)
      else await navigator.clipboard.writeText(command)
      if (lifetime.current === generation) setCopied('Command copied. Nothing was run.')
    } catch {
      if (lifetime.current === generation) setCopied('Could not copy. Select the command and copy it manually.')
    }
  }
  const memory = parseServeMemory(data)
  return <Section title={`Memory · ${profile}`} headingLevel={3}>
    <p className="text-xs text-[var(--desk-text-secondary)]">
      File sizes and provider status, not memory contents or this chat’s cached prompt.
    </p>
    {error ? <p role="alert">{error}</p> : data === null ? <p role="status">Loading memory status…</p> :
      <p>{memory ? memorySummary(memory) : 'Memory status not reported.'}</p>}
    {commands && <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setTick(v => v + 1)}>{error ? 'Retry memory status' : 'Refresh memory status'}</Button>
        <Button size="sm" disabled={!onPrepareReview} onClick={() => onPrepareReview?.(profile)}>Prepare memory review in chat</Button>
      </div>
      <p className="text-xs text-[var(--desk-text-secondary)]">
        Prepare adds a review request to your existing draft. You choose whether to Send. A model request may use your provider.
      </p>
      <div className="profile-skill-requirements">
        <strong>Direct memory editing is unavailable in this Hermes build</strong>
        <p>The content-edit RPCs do not accept a profile or session. Desk will not read or change another profile’s memory through them.</p>
        <p>For the native workflow, open this profile’s CLI. Review proposed writes with <code>/memory pending</code>.
          To require review of future writes, use <code>/memory approval on</code>. That changes the profile’s approval setting.
          Approve or reject specific proposals only after reviewing them.</p>
        <p>Existing chats may retain cached memory. A new chat loads current saved memory. External providers have their own stores and controls.</p>
      </div>
      <div className="profile-memory-command"><code>{commands.status}</code>
        <Button size="sm" variant="ghost" onClick={() => void copy(commands.status)}>Copy status command</Button></div>
      <div className="profile-memory-command"><code>{commands.chat}</code>
        <Button size="sm" variant="ghost" onClick={() => void copy(commands.chat)}>Copy profile CLI command</Button></div>
      {copied && <p role="status">{copied}</p>}
    </>}
  </Section>
}
