/**
 * Group-room @mentions — the same plain-text rule the server router uses
 * (hermes-deploy docs/plans/2026-09-25-group-rooms.md, "Mention parsing"):
 *
 * - handles per member: the full name, the name without spaces, and the
 *   first word;
 * - case-insensitive, longest handle first, only right after `@`, and only at
 *   a word boundary on both sides;
 * - exact names win equal-length ties against another member's shorthand;
 * - `@everyone` / `@all` mean every member.
 *
 * The composer picker inserts `@Name ` as plain text; nothing else is encoded.
 */

export interface MentionMember {
  id: string
  name: string
}

export const EVERYONE_HANDLE = 'everyone'
const ALL_HANDLES = new Set(['everyone', 'all'])

/** Handles one member answers to, longest first, de-duplicated. */
export function mentionHandles(name: string): string[] {
  const full = name.trim()
  if (!full) return []
  const out = [full, full.replace(/\s+/g, ''), full.split(/\s+/)[0] ?? '']
  return [...new Set(out.filter((h) => h.length > 0))].sort((a, b) => b.length - a.length)
}

/**
 * Every member's handles, lowercased. A first word two members share
 * ("Chief of Staff", "Chief Engineer") names neither of them, the same
 * rule as the server router (hermes-deploy rooms/core.ts).
 */
function memberHandles(members: MentionMember[]): Array<{ handle: string; id: string }> {
  const firstOf = (name: string) => name.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const counts = new Map<string, number>()
  for (const m of members) {
    const f = firstOf(m.name)
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  const out: Array<{ handle: string; id: string }> = []
  const aliases: Array<{ handle: string; id: string }> = []
  for (const m of members) {
    const full = m.name.trim().toLowerCase()
    const first = firstOf(m.name)
    for (const h of mentionHandles(m.name)) {
      const lower = h.toLowerCase()
      if (lower === first && lower !== full && (counts.get(first) ?? 0) > 1) continue
      const target = lower === full ? out : aliases
      target.push({ handle: lower, id: m.id })
    }
  }
  return [...out, ...aliases]
}

function wordBefore(text: string, boundary: number): boolean {
  return /[\p{L}\p{N}_]$/u.test(text.slice(Math.max(0, boundary - 2), boundary))
}

function wordAfter(text: string, boundary: number): boolean {
  return /^[\p{L}\p{N}_]/u.test(text.slice(boundary, boundary + 2))
}

/**
 * Where each @mention sits in `text` (same rule as parseMentions), for
 * highlighting: `[start, end)` covers the `@` and the handle. `id` is the
 * member, or `*` for `@everyone` / `@all`.
 */
export function mentionSpans(
  text: string,
  members: MentionMember[],
): Array<{ start: number; end: number; id: string }> {
  if (!text.includes('@') || members.length === 0) return []
  const handles = memberHandles(members)
  handles.sort((a, b) => b.handle.length - a.handle.length)
  // `@everyone` / `@all` are reserved and win over a member handle that reads
  // the same, exactly as parseMentions (and the server router) resolve them.
  const everyoneHandles = [...ALL_HANDLES].sort((a, b) => b.length - a.length)
  const lower = text.toLowerCase()
  const sourceOffsets: number[] = []
  if (lower.length !== text.length) {
    sourceOffsets.push(0)
    let offset = 0
    for (const char of text) {
      offset += char.length
      for (let j = 0; j < char.toLowerCase().length; j++) sourceOffsets.push(offset)
    }
  }
  const out: Array<{ start: number; end: number; id: string }> = []
  for (let i = lower.indexOf('@'); i >= 0; i = lower.indexOf('@', i + 1)) {
    if (wordBefore(lower, i)) continue
    const rest = lower.slice(i + 1)
    const everyone = everyoneHandles.find((h) => rest.startsWith(h) && !wordAfter(rest, h.length))
    const match = everyone
      ? { handle: everyone, id: '*' }
      : handles.find((h) => rest.startsWith(h.handle) && !wordAfter(rest, h.handle.length))
    if (!match) continue
    const end = i + 1 + match.handle.length
    out.push({ start: sourceOffsets[i] ?? i, end: sourceOffsets[end] ?? end, id: match.id })
    i += match.handle.length
  }
  return out
}

/**
 * Member ids mentioned in `text`, in first-mention order. `@everyone` / `@all`
 * returns every member. Longest handle wins across ALL members, so
 * `@CoderBob` never resolves to a member called "Coder".
 */
export function parseMentions(text: string, members: MentionMember[]): string[] {
  const handles = memberHandles(members)
  handles.sort((a, b) => b.handle.length - a.handle.length)
  const lower = text.toLowerCase()
  const hit = new Set<string>()
  for (let i = lower.indexOf('@'); i >= 0; i = lower.indexOf('@', i + 1)) {
    // `@` must itself start a word (not an email like a@b.com).
    if (wordBefore(lower, i)) continue
    const rest = lower.slice(i + 1)
    const everyone = [...ALL_HANDLES].find(
      (h) => rest.startsWith(h) && !wordAfter(rest, h.length),
    )
    if (everyone) return members.map((m) => m.id)
    const match = handles.find(
      (h) => rest.startsWith(h.handle) && !wordAfter(rest, h.handle.length),
    )
    if (match) hit.add(match.id)
  }
  return [...hit]
}

/** The `@query` the caret is inside of, or null. `start` indexes the `@`. */
export function mentionQueryAt(
  draft: string,
  caret: number,
): { start: number; query: string } | null {
  const upto = draft.slice(0, Math.max(0, Math.min(caret, draft.length)))
  const at = upto.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(upto[at - 1] ?? '')) return null
  const query = upto.slice(at + 1)
  // A space ends the token; allow multi-word names only while they still
  // prefix-match (handled by the candidate filter), so cap at one space.
  if (/\s\s|\n/.test(query) || query.length > 40) return null
  return { start: at, query }
}

export interface MentionCandidate {
  /** Member id, or `everyone`. */
  id: string
  /** Inserted verbatim after `@`. */
  label: string
  detail?: string
}

/** Members (plus `@everyone`) whose handles prefix-match `query`. */
export function mentionCandidates(members: MentionMember[], query: string): MentionCandidate[] {
  // A trailing space closes the token (`@Nub ` was just inserted).
  if (/\s$/.test(query)) return []
  const q = query.toLowerCase()
  const out: MentionCandidate[] = []
  for (const m of members) {
    const name = m.name.trim()
    if (!name) continue
    if (!q || mentionHandles(name).some((h) => h.toLowerCase().startsWith(q))) {
      out.push({ id: m.id, label: name })
    }
  }
  if (!q || EVERYONE_HANDLE.startsWith(q)) {
    out.push({ id: EVERYONE_HANDLE, label: EVERYONE_HANDLE, detail: 'every member' })
  }
  return out
}

/** Replace `@query` (from `start` to the caret) with `@Label `. */
export function insertMention(
  draft: string,
  start: number,
  caret: number,
  label: string,
): { text: string; caret: number } {
  const before = draft.slice(0, start)
  const after = draft.slice(caret).replace(/^\S*/, '').replace(/^ /, '')
  const token = `@${label} `
  return { text: `${before}${token}${after}`, caret: before.length + token.length }
}
