/** Credential-free session metadata and profile-scoped model recovery guidance. */
export interface SessionModelRoute {
  model: string
  provider?: string
}

const label = (value: unknown): string | undefined => typeof value === 'string' &&
  value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
  ? value.trim() : undefined

export function sessionModelRoute(info: unknown): SessionModelRoute | undefined {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined
  const fields = info as Record<string, unknown>
  const model = label(fields.model)
  return model ? { model, provider: label(fields.provider) } : undefined
}

export function modelSelectionCommand(profile: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) return null
  return profile === 'default' ? 'hermes model' : `hermes -p ${profile} model`
}

const providers: Record<string, string> = {
  nous: 'Nous Research', openrouter: 'OpenRouter', anthropic: 'Anthropic',
  openai: 'OpenAI', 'openai-codex': 'OpenAI Codex', 'opencode-go': 'OpenCode Go',
  custom: 'Custom endpoint', llamacpp: 'Local model', ollama: 'Ollama',
}
export function modelProviderLabel(provider?: string): string {
  return provider ? providers[provider] ?? provider : 'Provider not reported'
}

/** A generic 404 can be a failed tool, not a model problem. Never infer a replacement model. */
export function isModelRouteError(message: string): boolean {
  return /\bmodel\b.{0,180}(?:not (?:available|found|supported)|isn['’]t available|does not exist|unknown|unavailable)/i.test(message) ||
    /\b(?:unknown|unsupported|invalid)\s+(?:model|provider)\b/i.test(message) ||
    /\bno endpoints found\b/i.test(message) ||
    /\b(?:nous portal|openrouter)\b.{0,100}\b(?:model|catalog)\b/i.test(message)
}

export interface ModelProviderOption {
  slug: string
  name: string
  models: string[]
  featured: string[]
  unavailable: string[]
  current: boolean
  /** null when Hermes did not say. */
  authenticated: boolean | null
  warning?: string
}

/** What `model.options` reports for one profile (and its live chat, when bound). */
export interface ModelOptionsView {
  model?: string
  provider?: string
  providers: ModelProviderOption[]
}

export type ModelSwitchScope = 'session' | 'global'

export interface ModelChoice {
  model: string
  provider: string
  scope: ModelSwitchScope
  /** Set after the user accepted Hermes's expensive-model warning. */
  confirmExpensive?: boolean
}

export type ModelSwitchOutcome =
  | { status: 'switched' | 'deferred'; scope: ModelSwitchScope; warning?: string }
  | { status: 'confirm'; message: string }

const strings = (value: unknown, limit: number): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => label(entry) === entry).slice(0, limit) : []

export function modelOptionsView(raw: unknown): ModelOptionsView {
  const fields = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const providers = Array.isArray(fields.providers) ? fields.providers : []
  return {
    model: label(fields.model),
    provider: label(fields.provider),
    providers: providers.flatMap((row): ModelProviderOption[] => {
      const r = row && typeof row === 'object' ? row as Record<string, unknown> : {}
      const slug = label(r.slug)
      if (!slug) return []
      return [{
        slug, name: label(r.name) ?? slug,
        models: strings(r.models, 2000), featured: strings(r.featured_models, 64),
        unavailable: strings(r.unavailable_models, 2000),
        current: r.is_current === true,
        authenticated: typeof r.authenticated === 'boolean' ? r.authenticated : null,
        warning: label(r.warning),
      }]
    }),
  }
}

/** The `/model` argument Hermes parses; null for anything main would refuse. */
export function modelSwitchValue(choice: Pick<ModelChoice, 'model' | 'provider' | 'scope'>): string | null {
  if (!/^[A-Za-z0-9_.:/@+]\S{0,255}$/.test(choice.model)) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(choice.provider)) return null
  if (choice.scope !== 'session' && choice.scope !== 'global') return null
  return `${choice.model} --provider ${choice.provider} --${choice.scope}`
}
