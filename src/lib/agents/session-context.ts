export interface SessionContextSnapshot {
  used: number
  maximum: number
  estimated: boolean
  source: string
  categories: { id: string; label: string; tokens: number }[]
  files: { label: string; path: string; tokens: number; loaded: boolean; status: string }[]
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096

/** Only manifest metadata, never instruction or memory bodies. */
export function sessionContextSnapshot(value: unknown): SessionContextSnapshot {
  const result = object(value)
  if (!count(result.context_used) || !count(result.context_max) ||
      !Array.isArray(result.categories) || !Array.isArray(result.context_files))
    throw new Error('Hermes did not return a context breakdown. Retry after a completed turn.')
  return {
    used: result.context_used, maximum: result.context_max,
    estimated: result.context_estimated !== false,
    source: text(result.context_source) ? result.context_source : 'unknown',
    categories: result.categories.slice(0, 128).map(object).filter(row =>
      text(row.id) && text(row.label) && count(row.tokens))
      .map(row => ({ id: row.id as string, label: row.label as string, tokens: row.tokens as number })),
    files: result.context_files.slice(0, 128).map(object).filter(row =>
      text(row.label) && text(row.path) && count(row.est_tokens) && typeof row.loaded === 'boolean' && text(row.status))
      .map(row => ({ label: row.label as string, path: row.path as string, tokens: row.est_tokens as number,
        loaded: row.loaded as boolean, status: row.status as string })),
  }
}
