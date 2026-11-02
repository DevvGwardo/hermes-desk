/**
 * Starter prompts for an empty chat.
 *
 * Picked from what the agent says it is (name, persona title, description),
 * so a researcher offers research and a coder offers code. A tap puts the
 * text in the composer rather than sending it: most starters end where the
 * person adds their own topic, and nothing runs until they press send.
 */
import type { Agent } from './agents'

const KINDS: { match: RegExp; starters: [string, string, string] }[] = [
  {
    match: /chief|orchestrat|manager|assistant to|of staff/i,
    starters: [
      'Plan my week around ',
      'Split this between the team and report back: ',
      'What can each of my agents do?',
    ],
  },
  {
    match: /cod(e|er|ing)|dev|engineer|program|bug|repo/i,
    starters: [
      'Write a script that ',
      'Find and fix the bug in ',
      'Explain how this code works: ',
    ],
  },
  {
    match: /x |twitter|growth|marketing|social|seo|brand|audience/i,
    starters: [
      'Find the top posts this week about ',
      'Analyze the recent posts from @',
      'Plan a week of posts about ',
    ],
  },
  {
    match: /writ|content|copy|edit|blog|newsletter/i,
    starters: [
      'Draft a post about ',
      'Rewrite this so it reads clearer: ',
      'Give me 5 headline ideas for ',
    ],
  },
  {
    match: /data|analy|financ|stock|market|sheet|numbers/i,
    starters: [
      'Analyze this and tell me what stands out: ',
      'Track the price of ',
      'Make a chart of ',
    ],
  },
  {
    match: /research|search|scout|news|find/i,
    starters: [
      'Research the latest on ',
      'Compare the best options for ',
      'Summarize this page for me: ',
    ],
  },
]

const ROOM: [string, string, string] = [
  'Everyone, give me your take on ',
  'Split this up between you: ',
  'Debate the pros and cons of ',
]

const GENERAL: [string, string, string] = [
  'Research and summarize ',
  'Build me a simple web page for ',
  'Every morning, send me a summary of ',
]

export function chatStarters(agent: Pick<Agent, 'name' | 'summary' | 'persona'> | null | undefined, room = false): string[] {
  if (room) return ROOM
  if (!agent) return GENERAL
  const about = [agent.name, agent.persona?.title, agent.persona?.description, agent.summary]
    .filter(Boolean)
    .join(' ')
  return KINDS.find((k) => k.match.test(about))?.starters ?? GENERAL
}

/** Chip text: an open-ended starter ("Research the latest on ") reads as
 *  "Research the latest on…"; a full question stays as it is. */
export function starterLabel(text: string): string {
  return /[\s:@]$/.test(text) ? `${text.trim().replace(/[:@]$/, '').trimEnd()}…` : text
}
