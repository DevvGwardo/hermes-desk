/**
 * Real hermes profiles behind "New agent" / agent edits on a hosted VM.
 *
 * Hermes routes (hermes_cli/web_routers/profiles.py):
 *   POST   /api/profiles                  {name, clone_from, description}
 *   PATCH  /api/profiles/{name}           {new_name}
 *   DELETE /api/profiles/{name}
 *   PUT    /api/profiles/{name}/description {description}
 *   GET    /api/profiles/{name}/soul      → {content, exists}
 *   PUT    /api/profiles/{name}/soul      {content}
 *
 * Profile ids are lowercase `[a-z0-9][a-z0-9_-]{0,63}`, never one of hermes'
 * reserved names; "default" is the main agent and is never deleted here.
 */

import { serveGetDetailed, serveSend } from './hermes-rest'
import { restFailureText } from './agent-rest'

export const DEFAULT_PROFILE = 'default'

/** hermes_cli/profiles.py `_RESERVED_NAMES`. */
const RESERVED = new Set(['hermes', 'default', 'test', 'tmp', 'root', 'sudo'])

/** Canonical profile id for a display name (hermes `validate_profile_name`). */
export function profileIdForName(name: string): string {
  let s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  if (!s) s = 'agent'
  s = s.slice(0, 64).replace(/[-_]+$/, '')
  if (RESERVED.has(s)) s = `${s}-agent`
  return s
}

export interface ProfileResult<T = undefined> {
  ok: boolean
  data?: T
  status?: number
  /** Plain-language failure, safe to show. */
  error?: string
}

function fail<T>(res: { status?: number; error?: string }, fallback: string): ProfileResult<T> {
  return { ok: false, status: res.status, error: restFailureText(res, fallback) }
}

const enc = encodeURIComponent

/** Create a hermes profile cloned from the default one (config, skills, personality). */
export async function createHermesProfile(opts: {
  name: string
  description?: string
}): Promise<ProfileResult<{ name: string }>> {
  const id = profileIdForName(opts.name)
  const res = await serveSend<{ ok?: boolean; name?: string }>('POST', '/api/profiles', {
    name: id,
    clone_from: DEFAULT_PROFILE,
    ...(opts.description?.trim() ? { description: opts.description.trim() } : {}),
  })
  if (!res.ok) return fail(res, 'Could not create the agent.')
  return { ok: true, data: { name: res.data?.name || id }, status: res.status }
}

/** Rename a profile. Returns the new canonical id. */
export async function renameHermesProfile(
  current: string,
  newDisplayName: string,
): Promise<ProfileResult<{ name: string }>> {
  const wanted = current === DEFAULT_PROFILE ? newDisplayName.trim() : profileIdForName(newDisplayName)
  if (!wanted) return { ok: false, error: 'Name cannot be empty.' }
  if (current !== DEFAULT_PROFILE && wanted === current) return { ok: true, data: { name: current } }
  const res = await serveSend<{ ok?: boolean; name?: string }>('PATCH', `/api/profiles/${enc(current)}`, {
    new_name: wanted,
  })
  if (!res.ok) return fail(res, 'Could not rename the agent.')
  return { ok: true, data: { name: res.data?.name || wanted }, status: res.status }
}

/** Delete a profile. Refuses "default" before touching the network. */
export async function deleteHermesProfile(name: string): Promise<ProfileResult> {
  if (!name || name.trim().toLowerCase() === DEFAULT_PROFILE) {
    return { ok: false, error: 'Your main agent cannot be deleted.' }
  }
  const res = await serveSend('DELETE', `/api/profiles/${enc(name)}`)
  if (!res.ok) return fail(res, 'Could not delete the agent.')
  return { ok: true, status: res.status }
}

export async function setHermesProfileDescription(
  name: string,
  description: string,
): Promise<ProfileResult> {
  const res = await serveSend('PUT', `/api/profiles/${enc(name)}/description`, {
    description: description.trim(),
  })
  if (!res.ok) return fail(res, 'Could not save the description.')
  return { ok: true }
}

export async function getHermesProfileSoul(
  name: string,
): Promise<ProfileResult<{ content: string; exists: boolean }>> {
  const res = await serveGetDetailed<{ content?: string; exists?: boolean }>(
    `/api/profiles/${enc(name)}/soul`,
  )
  if (!res.data) {
    return fail({ status: res.status ?? res.error?.status, error: res.error?.message }, 'Could not load the personality.')
  }
  return {
    ok: true,
    data: {
      content: typeof res.data.content === 'string' ? res.data.content : '',
      exists: res.data.exists === true,
    },
  }
}

export async function putHermesProfileSoul(name: string, content: string): Promise<ProfileResult> {
  const res = await serveSend('PUT', `/api/profiles/${enc(name)}/soul`, { content })
  if (!res.ok) return fail(res, 'Could not save the personality.')
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Tone presets for the Personality editor
// ---------------------------------------------------------------------------

export interface TonePreset {
  id: 'friendly' | 'concise' | 'professional' | 'playful'
  label: string
  text: string
}

export const TONE_PRESETS: readonly TonePreset[] = [
  {
    id: 'friendly',
    label: 'Friendly',
    text:
      'You are warm, encouraging and easy to talk to. Use plain everyday words, ' +
      'explain things patiently, and check in when something might be unclear.',
  },
  {
    id: 'concise',
    label: 'Concise',
    text:
      'You get straight to the point. Answer in as few words as possible, prefer ' +
      'short lists over paragraphs, and skip pleasantries unless asked.',
  },
  {
    id: 'professional',
    label: 'Professional',
    text:
      'You are calm, precise and professional. Write in clear complete sentences, ' +
      'state assumptions, and keep a courteous business tone.',
  },
  {
    id: 'playful',
    label: 'Playful',
    text:
      'You are upbeat and playful. Keep things light with a bit of humour, while ' +
      'still giving accurate, useful answers.',
  },
] as const

/** Which preset (if any) the personality text currently matches exactly. */
export function matchTonePreset(content: string): TonePreset['id'] | null {
  const t = content.trim()
  return TONE_PRESETS.find((p) => p.text === t)?.id ?? null
}

// ---------------------------------------------------------------------------
// Keep a roster agent's hermes profile in step with profile edits
// ---------------------------------------------------------------------------

/**
 * Apply an AgentInfo edit (name / description) to the agent's hermes profile.
 * Returns the (possibly renamed) profile id, or an error. Never throws.
 */
export async function syncProfileEdit(
  profile: string,
  patch: { name?: string; description?: string },
): Promise<ProfileResult<{ name: string }>> {
  let current = profile
  if (typeof patch.name === 'string' && patch.name.trim()) {
    const renamed = await renameHermesProfile(current, patch.name)
    if (!renamed.ok) return renamed
    current = renamed.data?.name ?? current
  }
  if (typeof patch.description === 'string') {
    const described = await setHermesProfileDescription(current, patch.description)
    if (!described.ok) return { ok: false, error: described.error, data: { name: current } }
  }
  return { ok: true, data: { name: current } }
}

/**
 * AgentInfo edit → hermes profile, then stamp a renamed profile id back onto
 * the roster agent. Failures are logged; the app-side edit already landed.
 */
export async function syncAgentProfile(
  agentId: string,
  profile: string,
  patch: { name?: string; description?: string },
): Promise<void> {
  const res = await syncProfileEdit(profile, { name: patch.name, description: patch.description })
  const renamed = res.data?.name
  if (renamed && renamed !== profile) {
    const { setState } = await import('./agents/store')
    setState((st) => ({
      agents: st.agents.map((a) => (a.id === agentId ? { ...a, hermesProfile: renamed } : a)),
    }))
  }
  if (!res.ok) {
    const { logger } = await import('./logger')
    logger.warn('[nub] agent profile sync failed', res.error)
  }
}
