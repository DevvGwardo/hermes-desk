import { useEffect, useRef, useState } from 'react'
import { serveGetDetailed, type ServeSkill } from '../lib/hermes-rest'
import { parseSkillRequirements } from '../lib/skill-frontmatter'
import { Button } from './ui/Button'
import { Section } from './ui/Section'

interface Props {
  profile: string
  active?: boolean
  onUseSkill?: (profile: string, name: string) => void
}
type SkillsState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; skills: ServeSkill[] }
type ContentState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; content: string }

/** Installed/enabled discovery is not an executable-readiness verdict. */
export function ProfileSkills({ profile, active = true, onUseSkill }: Props) {
  return <ProfileSkillsScope key={profile} profile={profile} active={active} onUseSkill={onUseSkill} />
}

function ProfileSkillsScope({ profile, active, onUseSkill }: Props) {
  const [state, setState] = useState<SkillsState>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ServeSkill | null>(null)
  const [content, setContent] = useState<ContentState>({ kind: 'loading' })
  const [tick, setTick] = useState(0)
  const [contentTick, setContentTick] = useState(0)
  const [limit, setLimit] = useState(30)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    setState({ kind: 'loading' })
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) {
      setState({ kind: 'error', message: 'Select a valid local profile.' })
      return
    }
    void serveGetDetailed<unknown>(`/api/skills?profile=${encodeURIComponent(profile)}`)
      .then(result => {
        if (!alive) return
        if (result.data === null) {
          setState({ kind: 'error', message: result.status === 404 ? 'This Hermes runtime does not expose installed skills.' :
            'Could not reach this profile’s skills. Check the local Hermes connection and retry.' })
          return
        }
        const raw = Array.isArray(result.data) ? result.data : (result.data as { skills?: unknown[] }).skills
        if (!Array.isArray(raw)) {
          setState({ kind: 'error', message: 'Hermes did not return a skill inventory.' })
          return
        }
        const skills = raw.filter((row): row is ServeSkill => row != null && typeof row === 'object' &&
          typeof row.name === 'string' && Boolean(row.name.trim()))
          .map(row => ({ name: row.name, enabled: row.enabled, category: typeof row.category === 'string' ? row.category : undefined,
            description: typeof row.description === 'string' ? row.description : undefined }))
          .sort((a, b) => a.name.localeCompare(b.name))
        setState({ kind: 'ok', skills })
        setSelected(old => old ? skills.find(skill => skill.name === old.name) ?? null : null)
      }).catch(() => { if (alive) setState({ kind: 'error', message: 'Could not load skills. Retry when Hermes is connected.' }) })
    return () => { alive = false }
  }, [active, profile, tick])
  useEffect(() => {
    if (!active || !selected) return
    let alive = true
    setContent({ kind: 'loading' })
    void serveGetDetailed<{ content?: unknown }>(`/api/skills/content?profile=${encodeURIComponent(profile)}&name=${encodeURIComponent(selected.name)}`)
      .then(result => {
        if (alive) setContent(typeof result.data?.content === 'string'
          ? { kind: 'ok', content: result.data.content } : { kind: 'error' })
      }).catch(() => { if (alive) setContent({ kind: 'error' }) })
    return () => { alive = false }
  }, [active, profile, selected?.name, contentTick, tick])

  const term = query.trim().toLocaleLowerCase()
  const matches = state.kind === 'ok' ? state.skills.filter(skill =>
    `${skill.name} ${skill.description ?? ''} ${skill.category ?? ''}`.toLocaleLowerCase().includes(term)) : []
  const requirements = content.kind === 'ok' ? parseSkillRequirements(content.content) : null
  const declared = requirements ? [
    ...requirements.env.map(field => `${field.name}${field.optional ? ' (optional)' : ''}`),
    ...requirements.commands.map(command => `Command: ${command}`),
    ...requirements.credentialFiles.map(file => `Credential file: ${file}`),
  ] : []

  return <Section title={`Skills · ${profile}`} headingLevel={3}
    description="Skills available to this profile. Availability is not a readiness check."
    action={<Button size="sm" disabled={state.kind === 'loading'} onClick={() => setTick(value => value + 1)}>Refresh skills</Button>}>
    <label className="block text-xs">Search installed skills
      <input ref={searchRef} type="search" className="desk-skill-search" value={query} onChange={event => { setQuery(event.target.value); setLimit(30) }} />
    </label>
    {state.kind === 'loading' ? <p role="status" className="mt-3 text-xs">Loading profile skills…</p> :
      state.kind === 'error' ? <div role="alert" className="mt-3 text-xs"><p>{state.message}</p>
        <Button size="sm" onClick={() => setTick(value => value + 1)}>Retry skills</Button></div> :
      !matches.length ? <p role="status" className="mt-3 text-xs">{term ? 'No matching skills. Try another search.' :
        'Hermes reports no installed skills for this profile.'}</p> :
      <ul className="desk-skill-list" aria-label={`Installed skills for ${profile}`}>{matches.slice(0, limit).map(skill =>
        <li key={skill.name}><button type="button" aria-label={`Inspect ${skill.name}`} aria-pressed={selected?.name === skill.name}
          onClick={() => {
            if (selected?.name !== skill.name) setContent({ kind: 'loading' })
            setSelected(skill)
          }}>
          <strong>{skill.name}</strong>{skill.description && <span>{skill.description}</span>}
          {skill.enabled === false && <span>Disabled in Hermes</span>}
        </button></li>)}</ul>}
    {matches.length > limit && <Button size="sm" onClick={() => setLimit(value => value + 30)}>Show more skills</Button>}
    {selected && <section className="desk-skill-detail" aria-label={`Skill details for ${selected.name}`}>
      <div className="flex items-start justify-between gap-2"><h4 className="break-all font-semibold">{selected.name}</h4>
        <Button size="sm" variant="ghost" onClick={() => {
          setSelected(null)
          searchRef.current?.focus()
        }}>Close skill details</Button></div>
      {content.kind === 'loading' ? <p role="status">Loading skill instructions…</p> :
        content.kind === 'error' ? <div role="alert"><p>Could not load these instructions. Nothing was changed.</p>
          <Button size="sm" onClick={() => setContentTick(value => value + 1)}>Retry instructions</Button></div> :
        <>
          {onUseSkill && <Button variant="primary" size="sm" disabled={selected.enabled === false}
            onClick={() => onUseSkill(profile, selected.name)}>Prepare in chat</Button>}
          <p>{onUseSkill ? 'Adds to your draft, then you review and Send. Nothing is installed or enabled here.' :
            'Open this agent’s chat to prepare a request. Nothing is installed or enabled here.'}</p>
          <p className="font-medium">Declared requirements, not checked</p>
          {selected.enabled === false && <p>This skill is disabled in Hermes. Enable it in this profile’s Hermes skills settings before use.</p>}
          {requirements?.platforms && <p>Platforms: {requirements.platforms.map(platform => platform === 'darwin' ? 'macOS' : platform).join(', ')}</p>}
          {declared.length ? <ul className="list-inside list-disc break-words">{declared.map((entry, index) => <li key={index}>{entry}</li>)}</ul> :
            <p>No prerequisites declared in the supported metadata. This does not prove readiness.</p>}
          <p>Hermes checks keys and credential files when it loads the skill. Command availability may need a separate check. Never paste credentials into chat.</p>
          <details><summary>Read skill instructions</summary><pre tabIndex={0}>{content.content}</pre></details>
        </>}
    </section>}
  </Section>
}
