/**
 * update_avatar tool: lets an agent restyle its OWN nubcat avatar.
 *
 * Schema: { shape: 'cat', bodyColor?: string, eyeColor?: string, reset?: boolean }
 * - shape is always 'cat' (only silhouette); omit to keep.
 * - bodyColor ∈ AVATAR_BODY_COLORS, eyeColor ∈ AVATAR_EYE_COLORS (closed palettes).
 * - reset: true clears all three keys (back to seed defaults).
 * - Own-agent-only: the caller's agentId must own the file
 *   (maia_agent_id, else inst_<slug> == filename slug). Peer writes rejected.
 */

import { AVATAR_BODY_COLORS, AVATAR_EYE_COLORS } from './avatar-spec'

function isAvatarBodyColor(value: string): boolean {
  return (AVATAR_BODY_COLORS as readonly string[]).includes(value.trim().toLowerCase())
}
function isAvatarEyeColor(value: string): boolean {
  return (AVATAR_EYE_COLORS as readonly string[]).includes(value.trim().toLowerCase())
}
function parseAgentFrontmatter(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const fence = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fence) return out
  for (const line of fence[1].split('\n')) {
    // Key by regex, value by trim: /:\s*(.*?)\s*$/ backtracked quadratically
    // on long space runs. `.` never matched these terminators, so neither do we.
    const match = line.match(/^\s*([A-Za-z0-9_]+):/)
    if (!match) continue
    let value = line.slice(match[0].length).trim()
    if (/[\r\u2028\u2029]/.test(value)) continue
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      try { value = JSON.parse(value.replace(/^'/, '"').replace(/'$/, '"')) as string }
      catch { value = value.slice(1, -1) }
    }
    out[match[1]] = value
  }
  return out
}

export type UpdateAvatarArgs = {
  shape?: string
  bodyColor?: string
  eyeColor?: string
  reset?: boolean
}

/** Own-agent-only: filename slug's agent must equal the caller. Null = ok. */
export function assertOwnAgentFile(filename: string, body: string, agentId: string): string | null {
  const meta = parseAgentFrontmatter(body)
  const slug = filename.replace(/\.md$/i, '')
  const owner = (meta.maia_agent_id || '').trim() || `inst_${slug}`
  if (owner !== agentId) return `refused: ${agentId} cannot edit ${slug} (owned by ${owner})`
  return null
}

function setKey(lines: string[], key: string, value: string | null): string[] {
  const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}:`).test(l))
  if (value === null) return idx < 0 ? lines : lines.filter((_, i) => i !== idx)
  const line = `  ${key}: ${value}`
  if (idx < 0) {
    const meta = lines.findIndex((l) => /^metadata:/.test(l))
    const at = meta < 0 ? lines.length : meta + 1
    return [...lines.slice(0, at), line, ...lines.slice(at)]
  }
  return lines.map((l, i) => (i === idx ? line : l))
}

export function applyUpdateAvatarToMarkdown(
  filename: string,
  body: string,
  agentId: string,
  args: UpdateAvatarArgs,
): { ok: true; body: string } | { ok: false; error: string } {
  const refused = assertOwnAgentFile(filename, body, agentId)
  if (refused) return { ok: false, error: refused }
  if (args.bodyColor !== undefined && !isAvatarBodyColor(args.bodyColor)) {
    return { ok: false, error: `bodyColor must be one of ${AVATAR_BODY_COLORS.join(', ')}` }
  }
  if (args.eyeColor !== undefined && !isAvatarEyeColor(args.eyeColor)) {
    return { ok: false, error: `eyeColor must be one of ${AVATAR_EYE_COLORS.join(', ')}` }
  }
  const fence = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fence) return { ok: false, error: 'no frontmatter block' }
  let lines = fence[1].split('\n')
  if (args.reset) {
    for (const k of ['maia_avatar_shape', 'maia_avatar_body_color', 'maia_avatar_eye_color', 'maia_avatar_color']) {
      lines = setKey(lines, k, null)
    }
  } else {
    if (args.shape !== undefined) lines = setKey(lines, 'maia_avatar_shape', args.shape)
    if (args.bodyColor !== undefined) {
      lines = setKey(lines, 'maia_avatar_body_color', args.bodyColor)
      lines = setKey(lines, 'maia_avatar_color', null)
    }
    if (args.eyeColor !== undefined) lines = setKey(lines, 'maia_avatar_eye_color', args.eyeColor)
  }
  return { ok: true, body: body.replace(fence[0], `---\n${lines.join('\n')}\n---`) }
}
