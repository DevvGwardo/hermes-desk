import { createHermesProfile, profileIdForName, putHermesProfileSoul } from '../agent-profiles'

/** hermes answers a create for a name it already has with 400 ("A profile
 *  named 'x' already exists…"); older dashboards used 409. */
function isAlreadyExists(res: { status?: number; error?: string }): boolean {
  return (res.status === 400 || res.status === 409) && /already exists/i.test(res.error ?? '')
}

/**
 * "New agent" on a hosted VM creates a real hermes profile (cloned from the
 * default one). Returns the profile id, or undefined when the agent cannot be
 * reached or predates the profiles API (the app-only roster entry still
 * works). Any other refusal (409 from the dashboard…) throws a plain-language
 * Error so the editor can show it.
 *
 * A name hermes already has is adopted, not refused: deleting an agent in the
 * app leaves its profile on the VM, so re-adding it (Marketplace) used to fail
 * with "already exists" (R40). The adopted profile gets this agent's SOUL.
 * `taken` lists profile ids live roster agents already use; one of those is
 * still refused so two agents never share a profile.
 */
export async function createBackingProfile(
  name: string,
  description?: string,
  personality?: string,
  taken?: ReadonlySet<string>,
): Promise<string | undefined> {
  const res = await createHermesProfile({ name, description })
  let profile: string | undefined
  if (res.ok) {
    profile = res.data?.name
  } else if (isAlreadyExists(res) && !taken?.has(profileIdForName(name))) {
    profile = profileIdForName(name)
  } else {
    if (!res.status || res.status === 404) return undefined
    throw new Error(res.error || 'Could not create the agent.')
  }
  // Best-effort: the profile exists either way; the personality can be
  // edited later from Agent info.
  if (profile && personality?.trim()) await putHermesProfileSoul(profile, personality.trim())
  return profile
}
