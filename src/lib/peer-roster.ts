/**
 * Peer agents on the desktop roster — Grok Bot `custom_subagents` analogue.
 *
 * Grok injects user-defined bots into the live agent (`custom_subagents_info_complete`)
 * and exposes Check/Message/Stop. Maia conversations were isolated: a newly
 * created TravelAgent never reached Research Alpha's context, so "call the
 * travel agent" got a dead "I don't have a travel agent" reply.
 *
 * This module:
 *   1. Lists every other named agent (created bots, Hermes profiles, VMs).
 *   2. Matches explicit "call/ask/use/@Name" (and name-in-sentence) to a peer
 *      (used by `/spawn` and the mock model simulator — not the live send path).
 *   3. Builds a compact roster block that tells the parent to call Hermes
 *      `delegate_task(subagent_type=…)` instead of claiming peers are missing.
 *   4. Builds the spawn goal so an explicit `/spawn` worker acts as that persona.
 *   5. Wraps the live send with the *current* agent's name/title/bio so a
 *      newly created character actually speaks in that role (not default Nub).
 */

import { splitAttachmentNote } from './attachment-note'
import type { Agent, Conversation, SubagentRun } from './agents/types'
import { spawnTokenForAgent, slugifyAgentName } from './spawn-suggest'
import { usableSubagentBody } from './subagent-result'

export { slugifyAgentName }

/** Create-agent preset — Grok Bot Chief of Staff analogue (clean-room). */
export const CHIEF_OF_STAFF_PRESET = {
  name: 'Chief of Staff',
  title: 'Chief of Staff',
  description:
    'Coordinates the other named agents on this desktop. Delegates specialist work as side chats, then summarizes what they found. Never claims those agents are missing.',
  role: 'orchestrator' as const,
}

const STOP = new Set([
  'agent',
  'agents',
  'bot',
  'profile',
  'local',
  'default',
  'hermes',
  'general',
  'ready',
  'tasks',
  'from',
  'with',
  'that',
  'this',
  'about',
  'just',
  'have',
  'your',
  'their',
  'fresh',
  'named',
])

/** Prompt-text caps for agent/user-supplied strings (red-team D-2). */
export const PROMPT_NAME_MAX = 64
export const PROMPT_TITLE_MAX = 80
export const PROMPT_BLURB_MAX = 280
const PROMPT_TOKEN_MAX = 64

// C0/C1 controls, line/paragraph separators, zero-width and bidi overrides.
const PROMPT_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const PROMPT_INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g

/**
 * One line of agent- or user-supplied text made safe to interpolate into the
 * hidden `instructions` prompt: no newlines or control chars (so it cannot
 * start a fresh "instruction" line), whitespace collapsed, `[`/`]` turned
 * into parentheses (so it cannot close the `[...]` instruction bracket),
 * backticks and double quotes turned into `'` (so it cannot break out of a
 * code span or a quoted group name), and a length cap. Prompt text only —
 * UI rendering keeps the raw string.
 */
export function promptSafe(value: string | null | undefined, max: number): string {
  if (typeof value !== 'string' || !value) return ''
  let s = value
    .replace(PROMPT_CONTROL_RE, ' ')
    .replace(PROMPT_INVISIBLE_RE, '')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/[`"]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > max) s = `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`
  return s
}

export interface PeerHit {
  agent: Agent
  token: string
  goal: string
  reason: 'explicit' | 'mention' | 'task'
}

/** All spawnable tokens for an agent (profile slug, hermes, or name slug). */
export function peerToken(agent: Agent): string {
  return spawnTokenForAgent(agent) ?? slugifyAgentName(agent.name)
}

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function compactCore(s: string): string {
  return compact(s).replace(/^(the)/, '').replace(/(agent|bot|profile)$/g, '')
}

function nameVariants(name: string): string[] {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  const out = [name, spaced, name.replace(/\s+/g, ''), slugifyAgentName(name)]
  return [...new Set(out.filter((v) => v.trim().length >= 2))]
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function peersFor(agents: Agent[], currentAgentId?: string | null): Agent[] {
  return agents.filter((a) => a.id !== currentAgentId)
}

function currentAgentIdOf(conversation: Conversation | null | undefined): string | null {
  if (!conversation || conversation.target.type !== 'agent') return null
  return conversation.target.agentId
}

/** Explicit call / ask / use / @mention of a named peer. */
export function matchPeerDelegate(
  text: string,
  agents: Agent[],
  currentAgentId?: string | null,
): PeerHit | null {
  const peers = peersFor(agents, currentAgentId)
  if (peers.length === 0) return null
  const trimmed = text.trim()
  if (!trimmed) return null

  for (const agent of peers) {
    const token = peerToken(agent)
    const variants = nameVariants(agent.name)
    if (token && !variants.includes(token)) variants.push(token)

    for (const v of variants) {
      if (v.length < 2) continue
      const at = new RegExp(`(^|\\s)@${escapeRe(v)}\\b`, 'i')
      if (at.test(trimmed)) {
        return {
          agent,
          token,
          goal: stripMention(trimmed, v),
          reason: 'mention',
        }
      }
      const call = new RegExp(
        `\\b(?:call|ask|use|message|ping|spawn|delegate(?:\\s+to)?|tell|have)\\s+(?:the\\s+)?${escapeRe(v)}(?:\\s+(?:agent|bot|profile))?\\b`,
        'i',
      )
      if (call.test(trimmed)) {
        return {
          agent,
          token,
          goal: stripCallPreamble(trimmed, v),
          reason: 'explicit',
        }
      }
    }

    // Name appears as its own phrase ("the travel agent") even without "call".
    const spaced = agent.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    const phrase = new RegExp(`\\b(?:the\\s+)?${escapeRe(spaced)}(?:\\s+(?:agent|bot|profile))?\\b`, 'i')
    if (spaced.length >= 4 && phrase.test(trimmed) && compactCore(spaced) === compactCore(agent.name)) {
      // Only if the phrase is distinctive (not a generic word like "agent").
      if (compactCore(agent.name).length >= 4) {
        return {
          agent,
          token,
          goal: trimmed,
          reason: 'mention',
        }
      }
    }
  }

  return matchTaskPeer(trimmed, peers)
}

function stripMention(text: string, variant: string): string {
  const cleaned = text.replace(new RegExp(`@${escapeRe(variant)}\\b`, 'ig'), ' ').trim()
  return cleaned || text
}

function stripCallPreamble(text: string, variant: string): string {
  const re = new RegExp(
    `^[\\s\\S]*?\\b(?:call|ask|use|message|ping|spawn|delegate(?:\\s+to)?|tell|have)\\s+(?:the\\s+)?${escapeRe(variant)}(?:\\s+(?:agent|bot|profile))?\\s*(?:and\\s+|to\\s+|about\\s+|for\\s+|[,:]\\s*)?`,
    'i',
  )
  const rest = text.replace(re, '').trim()
  return rest || text
}

function expandName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

function keywords(blob: string): string[] {
  const words = blob.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []
  const out = new Set<string>()
  for (const w of words) {
    if (STOP.has(w)) continue
    out.add(w)
    if (w.endsWith('s') && w.length > 4) out.add(w.slice(0, -1))
  }
  return [...out]
}

/** Soft route: peer persona/name keywords overlap the user task. */
function matchTaskPeer(text: string, peers: Agent[]): PeerHit | null {
  const userKeys = new Set(keywords(text))
  if (userKeys.size === 0) return null
  let best: PeerHit | null = null
  let bestScore = 0
  for (const agent of peers) {
    const nameKeys = keywords(expandName(agent.name))
    const descKeys = keywords(
      `${agent.persona?.title ?? ''} ${agent.persona?.description ?? ''} ${agent.summary}`,
    )
    const nameHits = nameKeys.filter((k) => userKeys.has(k))
    const descHits = descKeys.filter((k) => userKeys.has(k))
    const score = nameHits.length * 2 + descHits.length
    if (score === 0) continue
    if (score > bestScore) {
      bestScore = score
      best = { agent, token: peerToken(agent), goal: text, reason: 'task' }
    }
  }
  return bestScore >= 1 ? best : null
}

export function peerRosterBlock(
  agents: Agent[],
  currentAgentId?: string | null,
  orchestrator = false,
): string {
  const peers = peersFor(agents, currentAgentId)
  if (peers.length === 0) return ''
  const lines = peers.map((a) => {
    const token = promptSafe(peerToken(a), PROMPT_TOKEN_MAX)
    const where = promptSafe(a.region, 16) || 'local'
    const blurb =
      promptSafe(a.persona?.description, PROMPT_BLURB_MAX) ||
      promptSafe(a.persona?.title, PROMPT_TITLE_MAX) ||
      promptSafe(a.summary, PROMPT_BLURB_MAX) ||
      'named agent'
    const name = promptSafe(a.name, PROMPT_NAME_MAX) || 'unnamed agent'
    return `- ${name} (\`${token}\`, ${where}): ${blurb}`
  })
  // hermes-agent's delegate_task has no subagent_type (checked against the
  // maiavm fork pin, NousResearch v2026.8.16 and upstream main, 2026-09-28):
  // an unknown argument is dropped, and the child starts as a blank Hermes
  // worker. So the parent has to carry the persona itself, in the task's
  // goal and context. The "<Name>:" goal prefix is what labels the side chat
  // (delegate-task.ts labelForDelegate) and matches what /spawn sends
  // (peerSpawnGoal).
  const brief =
    'Brief each one in the delegate_task call: delegate_task(tasks=[{goal:"<Name>: <self-contained task>", context:"You are <Name>. <their description from this list>. <everything they need; they have no chat history>"}]). Always start the goal with the specialist name and a colon.'
  const intro = orchestrator
    ? [
        '[You are Chief of Staff for the named specialists below. Each one runs as a delegate_task subagent that you brief.',
        'Delegate whenever a request fits a specialist description, or the user names one; the user does not have to ask by name. Answer directly only when no specialist fits or it is a quick reply.',
        brief,
        'Several independent specialists at once: one delegate_task call with several tasks.',
        'Hermes runs them in the background and posts their results back into this conversation. Summarize those results for the user and say who did what. Never say you lack these agents. Do not invent Message, Check, or Stop tools.]',
      ].join(' ')
    : [
        '[Named specialists on this desktop. Each one runs as a delegate_task subagent that you brief.',
        'If the user wants one of them, delegate to it.',
        brief,
        'For several at once, pass several tasks in one call. Never say you lack these agents.',
        'Hermes posts each result back here; summarize it. Do not invent Message, Check, or Stop tools.]',
      ].join(' ')
  return [intro, ...lines].join('\n')
}

/** True when this row is the paired VM stub, not a user-created character. */
export function isDefaultLinkedAgent(agent?: Agent | null): boolean {
  if (!agent) return false
  if (agent.id === 'local-hermes' || agent.id.startsWith('profile:')) return true
  const blob = `${agent.name} ${agent.persona?.title ?? ''} ${agent.persona?.description ?? ''} ${agent.summary}`
    .toLowerCase()
  return (
    agent.name === 'Nub' &&
    (/paired nub/.test(blob) || /private maia/.test(blob) || /private agent/.test(blob))
  )
}

/** Backend-only identity for the agent this conversation is bound to. */
export function currentAgentPersonaBlock(agent?: Agent | null): string {
  if (!agent || isDefaultLinkedAgent(agent)) return ''
  const title = promptSafe(agent.persona?.title, PROMPT_TITLE_MAX)
  const desc =
    promptSafe(agent.persona?.description, PROMPT_BLURB_MAX) ||
    promptSafe(agent.summary, PROMPT_BLURB_MAX)
  const name = promptSafe(agent.name, PROMPT_NAME_MAX)
  if (!name) return ''
  const ident = [name, title && title !== name ? title : null].filter(Boolean).join(' · ')
  const bits = [`[You are ${ident}. Stay in this role.`]
  if (desc) bits.push(desc)
  bits[bits.length - 1] = `${bits[bits.length - 1]}]`
  return bits.join(' ')
}

/** Persona + peer roster for the VM system prompt. Never shown in the bubble. */
export function promptInstructions(
  agents: Agent[],
  conversation?: Conversation | null,
): string {
  const currentId = currentAgentIdOf(conversation ?? null)
  const current = currentId ? agents.find((a) => a.id === currentId) : undefined
  // Orchestrators keep their persona too (a Chief renamed "Ava" stays Ava);
  // the Chief peer block is appended after it.
  const persona = currentAgentPersonaBlock(current)
  const block = peerRosterBlock(agents, currentId, isOrchestrator(current))
  return [persona, block].filter(Boolean).join('\n\n')
}

/** Hidden system prompt for one member of a group room. */
export function groupMemberInstructions(
  agents: Agent[],
  group: { name: string; memberAgentIds: string[] },
  memberId: string,
): string {
  const member = agents.find((a) => a.id === memberId)
  const others = group.memberAgentIds
    .filter((id) => id !== memberId)
    .map((id) => promptSafe(agents.find((a) => a.id === id)?.name, PROMPT_NAME_MAX))
    .filter((name): name is string => Boolean(name))
    .slice(0, 12)
  const groupName = promptSafe(group.name, PROMPT_TITLE_MAX) || 'Group'
  const persona = currentAgentPersonaBlock(member)
  const room = [
    `[Group room "${groupName}".`,
    others.length > 0
      ? `Other members in this room: ${others.join(', ')}.`
      : 'You are the only named member.',
    'The user addressed the whole room. Reply only as yourself.',
    'Other members will also answer — do not speak for them or preview their replies.',
    'Keep it concise.]',
  ].join(' ')
  return [persona, room].filter(Boolean).join('\n\n')
}

const USER_MARKER = '\nUser:\n'

/** Pull the real user line out of a stored wrap from older phone builds. */
export function displayUserPrompt(raw: string): string {
  // The attached-files note is for the agent; the bubble shows chips.
  // A quick-reply pick is sent as "[choice:<id>] <label>": the id is for
  // the agent, the bubble shows the label.
  const text = splitAttachmentNote(raw.trim()).text.replace(/^\[choice:[^\]\s]+\]\s*/, '')
  const i = text.indexOf(USER_MARKER)
  if (i < 0) return text
  const head = text.slice(0, i)
  if (!/\[You are |Named specialists on this desktop|You are Chief of Staff/.test(head)) {
    return text
  }
  return text.slice(i + USER_MARKER.length).trim()
}

/** Backend-only wrap. The chat bubble still shows the raw user text. */
export function promptWithPeerRoster(
  userText: string,
  agents: Agent[],
  conversation?: Conversation | null,
): string {
  const prefix = promptInstructions(agents, conversation)
  if (!prefix) return userText
  return `${prefix}\n\nUser:\n${userText}`
}

export function peerSpawnGoal(agent: Agent, goal: string): string {
  const title = promptSafe(agent.persona?.title, PROMPT_TITLE_MAX)
  const desc =
    promptSafe(agent.persona?.description, PROMPT_BLURB_MAX) ||
    promptSafe(agent.summary, PROMPT_BLURB_MAX)
  const ident = [promptSafe(agent.name, PROMPT_NAME_MAX), title].filter(Boolean).join(' · ')
  const task = goal.trim() || 'Help with the user request.'
  return [
    `${ident}: ${task}`,
    '',
    `You are ${ident}.`,
    desc ? desc : '',
    `Do this: ${task}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * True when this agent is the Grok Bot Chief of Staff analogue.
 *
 * Authority comes ONLY from an explicit `role: 'orchestrator'` (the Chief
 * switch / Chief preset). A name or title that merely reads "Chief of Staff"
 * never grants it: those strings come from agent-writable VM files, so a
 * string match let an agent promote itself to room and account Chief
 * (red-team D-3).
 */
export function isOrchestrator(agent?: Agent | null): boolean {
  return agent?.role === 'orchestrator'
}

/**
 * Explicit @mention / "call X" always delegates. Soft task routing
 * (persona keyword overlap) only when the current agent is the orchestrator —
 * otherwise a flight question to Research Alpha would skip the parent entirely.
 */
export function shouldDelegatePeer(hit: PeerHit | null, current?: Agent | null): hit is PeerHit {
  if (!hit) return false
  if (hit.reason === 'explicit' || hit.reason === 'mention') return true
  return isOrchestrator(current)
}

/** Hidden parent prompt after a specialist finishes (Grok CheckSubagent → reply). */
export function parentContinuationPrompt(run: SubagentRun, userText: string): string {
  const name = promptSafe(run.label, PROMPT_NAME_MAX) || run.kind
  const body = usableSubagentBody(run)
  return [
    `[Desktop] Specialist ${name} finished (${run.status}).`,
    '',
    'Result:',
    body,
    '',
    `The user asked: ${userText}`,
    '',
    'Reply to the user with a clear summary of what the specialist found. Do not claim you lack that agent. Do not spawn them again.',
  ].join('\n')
}
