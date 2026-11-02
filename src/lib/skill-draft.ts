/** A contextual handoff prepares a normal prompt, never executes or installs a skill. */
export interface SkillDraftRequest { threadKey: string; text: string }
const EVENT = 'hermes-desk:skill-draft'

export function skillRequest(name: string): string {
  return `Use the installed skill "${name}" for this task. First load it with skill_view and check its prerequisites. If anything is missing, explain what is needed and ask before installing tools, enabling integrations, or changing credentials.`
}

const GENUI_MENTION_RE = /\b(?:render_ui|hermes_desk_render_ui|mcp__?hermes[_-]desk__?render_ui)\b/i

export function genUiRequest(): string {
  return [
    'Use the Hermes Desk MCP tool `mcp__hermes_desk__render_ui` (`render_ui`) to render a bounded, data-only Generated UI card.',
    'Because `tools.tool_search.enabled: auto` defers MCP schemas, first call `tool_search` with `{"queries":["hermes desk render_ui"]}` and `tool_describe` with `{"names":["mcp__hermes_desk__render_ui"]}`, then call `mcp__hermes_desk__render_ui` with `{"version":1,"components":[...]}` (`stat`, `table`, `bar_chart`, or `checklist`, plain text only — never use `::preview` directives or write HTML files as a substitute).',
    'If `tool_search` returns no `mcp__hermes_desk__render_ui` tool in this session, tell the user to enable this profile in Settings -> Workspace -> Agent browsing and start a new chat session.',
  ].join(' ')
}

export function withGenUiPromptHint(text: string): string {
  const trimmed = text.trim()
  if (!GENUI_MENTION_RE.test(trimmed)) return text
  const hint = genUiRequest()
  if (trimmed.includes('mcp__hermes_desk__render_ui') && trimmed.includes('tool_search')) return text
  return `[Named specialists on this desktop · Hermes Desk GenUI note: ${hint}]\n\nUser:\n${trimmed}`
}

export function requestSkillDraft(request: SkillDraftRequest): void {
  window.dispatchEvent(new CustomEvent<SkillDraftRequest>(EVENT, { detail: request }))
}

export function onSkillDraft(callback: (request: SkillDraftRequest) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<SkillDraftRequest>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

export function appendSkillRequest(draft: string, request: string): string {
  if (draft.includes(request)) return draft
  return draft.trim() ? `${draft}\n\n${request}` : `${request}\n\nTask: `
}
