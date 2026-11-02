/**
 * Cards for the agent's blocking in-chat requests (see lib/agents/agent-prompts):
 *   - a missing skill key   → masked "Paste your … key" field, Save / Skip
 *   - a clarifying question → answer chips + "Other" free text
 *   - an MCP plugin to add  → consent card, Allow / Not now (OAuth opens the browser)
 * Rendered above the composer, same shell as the tool-permission dock.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  agentPromptsFor,
  answerAgentPrompt,
  encodeClarifyAnswer,
  getAgentPrompts,
  secretDisplayName,
  setClarifyDraft,
  subscribeAgentPrompts,
  waitingClarifyFor,
  waitingOnUserText,
  type AgentPrompt,
  type ClarifyPrompt,
  type McpSetupPrompt,
  type SecretPrompt,
} from '../lib/agents/agent-prompts'
import { runMcpSetup, type CatalogEnv } from '../lib/mcp-setup-flow'
import { openExternalUrl as openHostedUrl } from '../lib/external-url'

const shellClass =
  'mb-2 rounded-2xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2.5 shadow-[var(--ca-shadow-soft)]'
const titleClass = 'text-sm font-medium text-[var(--ca-ink)]'
const hintClass = 'mt-1 text-[11px] text-[var(--ca-ink-muted)]'
const fieldClass =
  'w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5 text-[13px] text-[var(--ca-ink)] outline-none focus:border-[var(--ca-primary-fill)]'
const primaryBtn = 'nub-btn-primary px-2.5 py-1 text-[11px] disabled:opacity-50'
const quietBtn =
  'rounded-full px-2.5 py-1 text-[11px] text-[var(--ca-ink-muted)] hover:text-[var(--ca-ink)] disabled:opacity-50'
const chipClass =
  'rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50'
const chipIdle =
  'border-[var(--ca-border)] bg-[var(--ca-card)] text-[var(--ca-ink)] hover:bg-[var(--ca-primary-soft)] hover:text-[var(--ca-primary-text)]'
// Picked must not look like hovered (the idle hover is the same soft fill):
// a solid fill plus a check mark.
const chipOn = 'border-[var(--ca-primary-fill)] bg-[var(--ca-primary-fill)] text-white'

const FAILED_COPY = "Your answer didn't go through. Check your connection and try again."

function FailedLine({ prompt }: { prompt: AgentPrompt }) {
  if (prompt.status !== 'failed') return null
  return <p className="mt-1 text-[11px] text-[var(--ca-danger)]">{FAILED_COPY}</p>
}

function isHttpUrl(s: string | undefined): s is string {
  return !!s && /^https:\/\/\S+$/i.test(s.trim())
}

// ---------------------------------------------------------------------------
// Secret
// ---------------------------------------------------------------------------

function SecretCard({ prompt }: { prompt: SecretPrompt }) {
  // The key lives only here until Save; it is cleared before the send
  // resolves and never logged or persisted.
  const [value, setValue] = useState('')
  const busy = prompt.status === 'submitting'
  const name = secretDisplayName(prompt)

  const save = () => {
    const v = value.trim()
    if (!v || busy) return
    setValue('')
    void answerAgentPrompt(prompt.requestId, { kind: 'secret', value: v })
  }
  const skip = () => {
    setValue('')
    void answerAgentPrompt(prompt.requestId, { kind: 'secret', skip: true })
  }

  return (
    <div role="region" aria-label="Your agent needs a key" className={shellClass} data-testid="secret-prompt">
      <p className={titleClass}>Paste your {name} key</p>
      <p className={hintClass}>
        {prompt.skillName ? `Your agent needs it for “${prompt.skillName}”.` : 'Your agent needs it to continue.'}{' '}
        It's saved on your agent only.
      </p>
      {isHttpUrl(prompt.help) ? (
        <button
          type="button"
          onClick={() => void openHostedUrl(prompt.help!.trim())}
          className="mt-1 text-[11px] text-[var(--ca-primary-text)] underline-offset-2 hover:underline"
        >
          Where do I get one?
        </button>
      ) : prompt.help ? (
        <p className={hintClass}>{prompt.help}</p>
      ) : null}
      <form
        className="mt-2 flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <input
          type="password"
          aria-label={`${name} key`}
          autoComplete="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste key"
          className={`${fieldClass} min-w-0 flex-1`}
        />
        <button type="submit" disabled={busy || !value.trim()} className={primaryBtn}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" disabled={busy} onClick={skip} className={quietBtn}>
          Skip
        </button>
      </form>
      <p className="mt-1 font-mono text-[10px] text-[var(--ca-ink-muted)] opacity-70">{prompt.envVar}</p>
      <FailedLine prompt={prompt} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Clarify
// ---------------------------------------------------------------------------

interface QState {
  selected: string[]
  other: boolean
  otherText: string
}

const emptyQ = (): QState => ({ selected: [], other: false, otherText: '' })

function answerFor(q: ClarifyPrompt['questions'][number], st: QState): string {
  const picks = [...st.selected]
  if (st.other && st.otherText.trim()) picks.push(st.otherText.trim())
  return encodeClarifyAnswer(picks, q.multiSelect)
}

function ClarifyCard({ prompt }: { prompt: ClarifyPrompt }) {
  const [states, setStates] = useState<QState[]>(() => prompt.questions.map(emptyQ))
  const busy = prompt.status === 'submitting'
  const single = !prompt.batch && prompt.questions.length === 1 && !prompt.questions[0]!.multiSelect

  const patch = (i: number, next: Partial<QState>) =>
    setStates((prev) => prev.map((s, j) => (j === i ? { ...s, ...next } : s)))

  const send = (override?: QState[]) => {
    const cur = override ?? states
    const answers = prompt.questions.map((q, i) => ({
      ...(q.qid ? { qid: q.qid } : {}),
      answer: answerFor(q, cur[i] ?? emptyQ()),
    }))
    if (answers.some((a) => !a.answer)) return
    void answerAgentPrompt(prompt.requestId, { kind: 'clarify', answers })
  }

  const ready = prompt.questions.every((q, i) => answerFor(q, states[i] ?? emptyQ()) !== '')
  const open = prompt.questions.filter((q, i) => answerFor(q, states[i] ?? emptyQ()) === '').length

  // Publish the picks so a reply typed in the message box keeps them.
  useEffect(() => {
    setClarifyDraft(
      prompt.requestId,
      prompt.questions.map((q, i) => answerFor(q, states[i] ?? emptyQ())),
    )
  }, [prompt.requestId, prompt.questions, states])
  useEffect(() => () => setClarifyDraft(prompt.requestId, null), [prompt.requestId])

  return (
    <div
      role="region"
      aria-label="Agent question"
      // A batch can be taller than a phone screen with the keyboard up, which
      // pushed the message box (where a typed answer goes) off screen. Cap it
      // to part of the visible height and let it scroll.
      className={`${shellClass} max-h-[calc(var(--vv-height,100dvh)*0.42)] overflow-y-auto overscroll-contain`}
      data-testid="clarify-prompt"
    >
      {prompt.memberName ? <p className={hintClass}>{prompt.memberName} asks</p> : null}
      {prompt.questions.map((q, i) => {
        const st = states[i] ?? emptyQ()
        const openEnded = q.choices.length === 0
        return (
          <div key={q.qid ?? i} className={i > 0 ? 'mt-3' : undefined}>
            <p className={titleClass}>{q.question}</p>
            {q.multiSelect ? <p className={hintClass}>Pick all that apply.</p> : null}
            {!openEnded && (
              <div role="group" aria-label="Choose an answer" className="mt-2 flex flex-wrap gap-1.5">
                {q.choices.map((c) => {
                  const on = st.selected.includes(c)
                  return (
                    <button
                      key={c}
                      type="button"
                      disabled={busy}
                      aria-pressed={on}
                      onClick={() => {
                        if (single) {
                          const next = [{ selected: [c], other: false, otherText: '' }]
                          setStates(next)
                          send(next)
                          return
                        }
                        const selected = q.multiSelect
                          ? on
                            ? st.selected.filter((s) => s !== c)
                            : [...st.selected, c]
                          : on
                            ? []
                            : [c]
                        patch(i, q.multiSelect ? { selected } : { selected, other: false })
                      }}
                      className={`${chipClass} ${on ? chipOn : chipIdle}`}
                    >
                      {on ? <span aria-hidden="true">✓ </span> : null}
                      {c}
                    </button>
                  )
                })}
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={st.other}
                  onClick={() =>
                    patch(i, q.multiSelect ? { other: !st.other } : { other: !st.other, selected: [] })
                  }
                  className={`${chipClass} ${st.other ? chipOn : chipIdle}`}
                >
                  {st.other ? <span aria-hidden="true">✓ </span> : null}
                  Other…
                </button>
              </div>
            )}
            {(openEnded || st.other) && (
              <input
                type="text"
                aria-label={openEnded ? 'Your answer' : 'Other answer'}
                value={st.otherText}
                disabled={busy}
                autoFocus={openEnded || st.other}
                onChange={(e) => patch(i, { otherText: e.target.value, ...(openEnded ? { other: true } : {}) })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
                placeholder="Type your answer"
                className={`${fieldClass} mt-2`}
              />
            )}
          </div>
        )
      })}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(!single || states[0]?.other || prompt.questions[0]!.choices.length === 0) && (
          <button type="button" disabled={busy || !ready} onClick={() => send()} className={primaryBtn}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        )}
        {/* Why Send is off: a batch waits for every question. */}
        {prompt.questions.length > 1 && open > 0 && !busy ? (
          <span className="self-center text-[11px] text-[var(--ca-ink-muted)]" data-testid="clarify-open-count">
            {open === prompt.questions.length ? 'Answer each question' : `${open} left`}
          </span>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void answerAgentPrompt(prompt.requestId, { kind: 'clarify', cancel: true })}
          className={quietBtn}
        >
          Skip
        </button>
      </div>
      <p className={hintClass}>Or just type your answer in the message box.</p>
      <FailedLine prompt={prompt} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// MCP setup
// ---------------------------------------------------------------------------

function prettyServer(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function McpSetupCard({ prompt }: { prompt: McpSetupPrompt }) {
  const [working, setWorking] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'browser'>('idle')
  const [needEnv, setNeedEnv] = useState<CatalogEnv[] | null>(null)
  const [env, setEnv] = useState<Record<string, string>>({})
  const cancelRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelRef.current = true
    }
  }, [])
  const busy = prompt.status === 'submitting'
  const name = prettyServer(prompt.server)
  const title =
    prompt.action === 'enable'
      ? `Turn on ${name}?`
      : prompt.action === 'authorize'
        ? `Sign in to ${name}?`
        : `Add ${name} to your agent?`
  const allowLabel = prompt.action === 'enable' ? 'Turn on' : prompt.action === 'authorize' ? 'Sign in' : 'Allow'

  const decline = () => {
    cancelRef.current = true
    setEnv({})
    void answerAgentPrompt(prompt.requestId, {
      kind: 'mcp',
      outcome: { status: 'declined', server: prompt.server },
    })
  }

  const allow = async () => {
    if (working || busy) return
    cancelRef.current = false
    setWorking(true)
    const step = await runMcpSetup(prompt.server, prompt.action, {
      env,
      cancelled: () => cancelRef.current,
      openUrl: async (url) => {
        if (mounted.current) setPhase('browser')
        await openHostedUrl(url)
      },
    })
    if (mounted.current) {
      setWorking(false)
      setPhase('idle')
    }
    if (step.kind === 'cancelled') return
    if (step.kind === 'needs-env') {
      if (mounted.current) setNeedEnv(step.env)
      return
    }
    if (mounted.current) setEnv({})
    void answerAgentPrompt(prompt.requestId, { kind: 'mcp', outcome: step.outcome })
  }

  return (
    <div role="region" aria-label="Add a plugin" className={shellClass} data-testid="mcp-setup-prompt">
      <p className={titleClass}>{title}</p>
      {prompt.reason ? <p className={hintClass}>{prompt.reason}</p> : null}
      {phase === 'browser' ? (
        <p className={hintClass}>Finish signing in in your browser, then come back here.</p>
      ) : null}
      {needEnv && needEnv.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          <p className={hintClass}>This plugin needs a key first.</p>
          {needEnv.map((e) => (
            <label key={e.name} className="block">
              <span className="mb-0.5 block text-[11px] text-[var(--ca-ink)]">
                {e.prompt || e.name}
                {e.required !== false ? ' *' : ''}
              </span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={e.prompt || e.name}
                value={env[e.name] ?? ''}
                disabled={working || busy}
                onChange={(ev) => setEnv((prev) => ({ ...prev, [e.name]: ev.target.value }))}
                className={fieldClass}
              />
            </label>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" disabled={working || busy} onClick={() => void allow()} className={primaryBtn}>
          {working ? 'Working…' : allowLabel}
        </button>
        <button type="button" disabled={busy} onClick={decline} className={quietBtn}>
          {working ? 'Cancel' : 'Not now'}
        </button>
      </div>
      <FailedLine prompt={prompt} />
    </div>
  )
}

// ---------------------------------------------------------------------------

export function AgentPromptCard({ prompt }: { prompt: AgentPrompt }) {
  if (prompt.kind === 'secret') return <SecretCard prompt={prompt} />
  if (prompt.kind === 'clarify') return <ClarifyCard prompt={prompt} />
  return <McpSetupCard prompt={prompt} />
}

/** True while a question card is up that a typed message would answer. */
export function useWaitingClarify(conversationId: string | null | undefined): boolean {
  const all = useSyncExternalStore(subscribeAgentPrompts, getAgentPrompts, getAgentPrompts)
  return waitingClarifyFor(conversationId, all) !== null
}

/** Activity-line text while a card is waiting on the user, else null. */
export function useWaitingOnUserText(
  conversationId: string | null | undefined,
  approvalPending: boolean,
): string | null {
  const all = useSyncExternalStore(subscribeAgentPrompts, getAgentPrompts, getAgentPrompts)
  return waitingOnUserText(conversationId, approvalPending, all)
}

export function AgentPromptDock({ conversationId }: { conversationId: string | null | undefined }) {
  const all = useSyncExternalStore(subscribeAgentPrompts, getAgentPrompts, getAgentPrompts)
  const mine = agentPromptsFor(conversationId, all)
  if (mine.length === 0) return null
  return (
    <>
      {mine.map((p) => (
        <AgentPromptCard key={p.requestId} prompt={p} />
      ))}
    </>
  )
}
