/**
 * Which skills can actually work on a hosted Linux agent VM.
 *
 * Source: docs/hermes-saas-coverage.md Appendix A ("Hide" and "Hide v1").
 * The gallery and the installed list both run every skill through
 * `skillFeasibility`; anything that can't work (macOS apps, LAN devices,
 * GPUs, loopback-only OAuth, desktop-only tooling) or that we deliberately
 * keep out of v1 (wallets, payments, niche infra) is hidden, never shown as
 * a broken card.
 */

export type SkillHideReason =
  | 'mac-only'
  | 'local-device'
  | 'gpu'
  | 'loopback-sign-in'
  | 'desktop-only'
  | 'not-in-v1'
  | 'platform'

/** Plain-language reason (secondary text / tests; never an error). */
export const HIDE_REASON_COPY: Record<SkillHideReason, string> = {
  'mac-only': 'Needs a Mac',
  'local-device': 'Needs a device on your home network',
  gpu: 'Needs a graphics card (GPU)',
  'loopback-sign-in': 'Its sign-in only works on your own computer',
  'desktop-only': 'Needs a desktop screen or local app',
  'not-in-v1': 'Not available yet',
  platform: 'Not supported on your agent’s system',
}

/** Skill name (last path segment, lowercase) → why it's hidden. */
export const HIDDEN_SKILLS: Readonly<Record<string, SkillHideReason>> = {
  // macOS-only (skills/apple/*)
  'apple-notes': 'mac-only',
  'apple-reminders': 'mac-only',
  findmy: 'mac-only',
  imessage: 'mac-only',
  // Local vault / LAN / local desktop apps
  obsidian: 'local-device',
  openhue: 'local-device',
  'touchdesigner-mcp': 'desktop-only',
  'unreal-mcp': 'desktop-only',
  brain_mcp: 'local-device',
  'brain-mcp': 'local-device',
  'neuroskill-bci': 'local-device',
  'openclaw-migration': 'desktop-only',
  'computer-use': 'desktop-only',
  // Loopback-only OAuth / per-user developer apps
  spotify: 'loopback-sign-in',
  xurl: 'loopback-sign-in',
  // GPU mlops (optional-skills/mlops + GPU creative generators)
  accelerate: 'gpu',
  clip: 'gpu',
  'flash-attention': 'gpu',
  llava: 'gpu',
  'nemo-curator': 'gpu',
  obliteratus: 'gpu',
  peft: 'gpu',
  'pytorch-fsdp': 'gpu',
  'pytorch-lightning': 'gpu',
  saelens: 'gpu',
  simpo: 'gpu',
  slime: 'gpu',
  'stable-diffusion': 'gpu',
  'tensorrt-llm': 'gpu',
  torchtitan: 'gpu',
  training: 'gpu',
  whisper: 'gpu',
  'audiocraft-audio-generation': 'gpu',
  heartmula: 'gpu',
  // Hide v1 (sensitive / niche)
  evm: 'not-in-v1',
  hyperliquid: 'not-in-v1',
  solana: 'not-in-v1',
  polymarket: 'not-in-v1',
  'mpp-agent': 'not-in-v1',
  'stripe-link-cli': 'not-in-v1',
  'stripe-projects': 'not-in-v1',
  godmode: 'not-in-v1',
  'hermes-s6-container-supervision': 'not-in-v1',
  'docker-management': 'not-in-v1',
  'mcp-oauth-remote-gateway': 'not-in-v1',
  'minecraft-modpack-server': 'not-in-v1',
  'pokemon-player': 'not-in-v1',
}

/** Whole categories hidden (identifier `official/<category>/<skill>`). */
export const HIDDEN_CATEGORIES: Readonly<Record<string, SkillHideReason>> = {
  apple: 'mac-only',
  blockchain: 'not-in-v1',
  payments: 'not-in-v1',
  gaming: 'not-in-v1',
}

export interface SkillFeasibilityInput {
  name?: string | null
  identifier?: string | null
  category?: string | null
  /** Frontmatter `platforms`, when known. */
  platforms?: readonly string[] | null
}

export type SkillFeasibility = { ok: true } | { ok: false; reason: SkillHideReason; label: string }

function slug(s: string): string {
  return s.trim().toLowerCase()
}

/** Last path segment of a hub identifier or name (`official/apple/findmy` → `findmy`). */
export function skillBaseName(input: SkillFeasibilityInput): string {
  const raw = (input.name && input.name.trim()) || (input.identifier ?? '')
  const parts = slug(raw).split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** Category from `official/<category>/<skill>` identifiers, else `category`. */
export function skillCategory(input: SkillFeasibilityInput): string {
  if (input.category && input.category.trim()) return slug(input.category)
  const parts = slug(input.identifier ?? '').split('/').filter(Boolean)
  if (parts[0] === 'official' && parts.length >= 3) return parts[1]
  return ''
}

/** False when the skill's `platforms` list is present and excludes linux. */
export function platformsAllowLinux(platforms: readonly string[] | null | undefined): boolean {
  if (!platforms || platforms.length === 0) return true
  return platforms.some((p) => slug(p) === 'linux')
}

function hidden(reason: SkillHideReason): SkillFeasibility {
  return { ok: false, reason, label: HIDE_REASON_COPY[reason] }
}

export function skillFeasibility(input: SkillFeasibilityInput): SkillFeasibility {
  const names = new Set<string>([skillBaseName(input)])
  const idTail = slug(input.identifier ?? '').split('/').filter(Boolean).pop()
  if (idTail) names.add(idTail)
  for (const n of names) {
    const reason = HIDDEN_SKILLS[n]
    if (reason) return hidden(reason)
  }
  const cat = skillCategory(input)
  if (cat && HIDDEN_CATEGORIES[cat]) return hidden(HIDDEN_CATEGORIES[cat])
  if (!platformsAllowLinux(input.platforms)) return hidden('platform')
  return { ok: true }
}

export function isSkillFeasible(input: SkillFeasibilityInput): boolean {
  return skillFeasibility(input).ok
}

/** Keep only skills that can work on a hosted Linux VM. */
export function filterFeasibleSkills<T extends SkillFeasibilityInput>(list: readonly T[]): T[] {
  return list.filter((s) => isSkillFeasible(s))
}

/**
 * Appendix A "Connect card" + "Install + key/login" skills: the ones worth
 * checking for missing keys in the installed list when the agent doesn't
 * report readiness itself (checking every bundled skill would mean one
 * SKILL.md fetch each).
 */
export const KNOWN_SETUP_SKILLS: ReadonlySet<string> = new Set([
  'notion', 'airtable', 'gif-search', 'shopify', 'canvas', 'here-now', 'telephony', 'parallel-cli',
  'pinecone', 'pinecone-research', 'osint-investigation', 'agentmail', 'grok', 'openhands', 'actual-setup',
  'inference-sh-cli', 'cloudflare-temporary-deploy', 'publish-site', 'page-agent', 'evaluation',
  'lambda-labs', 'models', 'comfyui', 'fitness-nutrition', 'blocked-page-recovery', 'reddit-reading',
  '1password', 'github', 'himalaya', 'box', 'claude-code', 'codex', 'opencode', 'sherlock',
  'blogwatcher', 'scrapling', 'songsee', 'google-workspace', 'modal', 'siyuan',
])
