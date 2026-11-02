/**
 * SKILL.md frontmatter → what a skill needs before it can run.
 *
 * Mirrors hermes `tools/skills_tool_setup.py::_get_required_environment_variables`
 * (merge `required_environment_variables`, `setup.collect_secrets` and legacy
 * `prerequisites.env_vars`; first entry per name wins) plus
 * `prerequisites.commands`, `required_credential_files` and `platforms`.
 *
 * The parser is a deliberately small YAML subset (block maps, block lists,
 * flow lists, quoted scalars, block scalars) — enough for skill frontmatter,
 * with no new dependency. Anything it can't read is skipped, never thrown.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }
type YamlMap = { [key: string]: YamlValue }

interface Line {
  indent: number
  text: string
}

const FENCE_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Raw frontmatter text between the leading `---` fences, or null. */
export function extractFrontmatter(md: string): string | null {
  const m = md.replace(/^﻿/, '').match(FENCE_RE)
  return m ? m[1] : null
}

/** Strip a trailing ` # comment` that sits outside quotes. */
function stripComment(text: string): string {
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd()
  }
  return text.trimEnd()
}

function toLines(src: string): Line[] {
  const out: Line[] = []
  for (const raw of src.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) {
      // Keep blank lines only as block-scalar separators; comments vanish.
      if (!raw.trim()) out.push({ indent: -1, text: '' })
      continue
    }
    const indent = raw.length - raw.replace(/^[ \t]+/, '').length
    out.push({ indent, text: raw.slice(indent) })
  }
  return out
}

function splitFlow(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (const c of inner) {
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

export function parseScalar(raw: string): YamlValue {
  const text = stripComment(raw).trim()
  if (text === '') return ''
  if (text.startsWith('[') && text.endsWith(']')) {
    return splitFlow(text.slice(1, -1)).map(parseScalar)
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const out: YamlMap = {}
    for (const part of splitFlow(text.slice(1, -1))) {
      const idx = part.indexOf(':')
      if (idx <= 0) continue
      out[unquote(part.slice(0, idx).trim())] = parseScalar(part.slice(idx + 1))
    }
    return out
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return unquote(text)
  }
  if (/^(true|yes|on)$/i.test(text)) return true
  if (/^(false|no|off)$/i.test(text)) return false
  if (/^(null|~)$/i.test(text)) return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

// The unquoted key ends on a non-space so the split before `:` is unique;
// a lazy `[^:#]*?\s*:` rescanned whitespace and went quadratic on long lines.
const KEY_RE = /^("[^"]*"|'[^']*'|[^\s:#'"](?:[^:#]*[^\s:#])?)\s*:(?:\s+(.*))?$/

class Parser {
  private i = 0
  private readonly lines: Line[]
  constructor(lines: Line[]) {
    this.lines = lines
  }

  private skipBlank(): void {
    while (this.i < this.lines.length && this.lines[this.i].indent < 0) this.i++
  }

  private peek(): Line | undefined {
    this.skipBlank()
    return this.lines[this.i]
  }

  parseBlock(indent: number): YamlValue {
    const first = this.peek()
    if (!first || first.indent < indent) return null
    if (first.text === '-' || first.text.startsWith('- ')) return this.parseList(first.indent)
    return this.parseMap(first.indent)
  }

  /** Lines deeper than `indent` joined (block scalar / wrapped plain scalar). */
  private collectDeeper(indent: number, fold: boolean): string {
    const parts: string[] = []
    while (this.i < this.lines.length) {
      const l = this.lines[this.i]
      if (l.indent >= 0 && l.indent <= indent) break
      parts.push(l.indent < 0 ? '' : l.text)
      this.i++
    }
    while (parts.length && parts[parts.length - 1] === '') parts.pop()
    return fold ? parts.join(' ').replace(/\s+/g, ' ').trim() : parts.join('\n')
  }

  private valueAfterKey(rest: string | undefined, keyIndent: number): YamlValue {
    const r = (rest ?? '').trim()
    if (r === '' || r.startsWith('#')) {
      const next = this.peek()
      if (!next) return null
      // YAML allows a block list at the same indent as its key.
      if (next.indent > keyIndent) return this.parseBlock(next.indent)
      if (next.indent === keyIndent && (next.text === '-' || next.text.startsWith('- '))) {
        return this.parseList(keyIndent)
      }
      return null
    }
    if (/^[|>][+-]?\d*$/.test(r)) return this.collectDeeper(keyIndent, r.startsWith('>'))
    const scalar = parseScalar(r)
    // Wrapped plain scalar: deeper lines continue the string.
    const next = this.lines[this.i]
    if (typeof scalar === 'string' && next && next.indent > keyIndent) {
      const more = this.collectDeeper(keyIndent, true)
      return more ? `${scalar} ${more}` : scalar
    }
    return scalar
  }

  parseMap(indent: number): YamlMap {
    const out: YamlMap = {}
    for (;;) {
      const line = this.peek()
      if (!line || line.indent !== indent) break
      if (line.text === '-' || line.text.startsWith('- ')) break
      const m = stripComment(line.text).match(KEY_RE) ?? line.text.match(KEY_RE)
      this.i++
      if (!m) continue
      out[unquote(m[1].trim())] = this.valueAfterKey(m[2], indent)
    }
    return out
  }

  parseList(indent: number): YamlValue[] {
    const out: YamlValue[] = []
    for (;;) {
      const line = this.peek()
      if (!line || line.indent !== indent) break
      if (!(line.text === '-' || line.text.startsWith('- '))) break
      const after = line.text === '-' ? '' : line.text.slice(2)
      const pad = after.length - after.trimStart().length
      const content = after.trimStart()
      if (content === '') {
        this.i++
        const next = this.peek()
        out.push(next && next.indent > indent ? this.parseBlock(next.indent) : null)
        continue
      }
      const km = stripComment(content).match(KEY_RE)
      if (km && !content.startsWith('[') && !content.startsWith('{') && !/^["']/.test(content.trim()) ) {
        // `- key: value` — rewrite as a map line at the key's column.
        const col = indent + 2 + pad
        this.lines[this.i] = { indent: col, text: content }
        out.push(this.parseMap(col))
        continue
      }
      this.i++
      out.push(this.valueAfterKey(content, indent))
    }
    return out
  }
}

/** Parse a YAML-subset document into a map (empty on anything unreadable). */
export function parseYamlSubset(src: string): YamlMap {
  try {
    const parser = new Parser(toLines(src))
    const v = parser.parseBlock(0)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Skill requirements
// ---------------------------------------------------------------------------

export interface SkillEnvRequirement {
  /** Env var name (technical; secondary text only). */
  name: string
  /** Human prompt ("Notion integration token"). */
  prompt: string
  help?: string
  /** Where to get the key, when the skill says. */
  url?: string
  optional?: boolean
  requiredFor?: string
}

export interface SkillRequirements {
  name?: string
  description?: string
  /** Declared platforms (lowercase) or null when the skill doesn't say. */
  platforms: string[] | null
  env: SkillEnvRequirement[]
  commands: string[]
  credentialFiles: string[]
  homepage?: string
  setupHelp?: string
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const URL_RE = /https?:\/\/[^\s"'<>)]+/

function asMap(v: YamlValue | undefined): YamlMap {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

function asList(v: YamlValue | undefined): YamlValue[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim()) return [v]
  return []
}

function str(v: YamlValue | undefined): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

function firstUrl(...texts: (string | undefined)[]): string | undefined {
  for (const t of texts) {
    if (!t) continue
    const m = t.match(URL_RE)
    if (m) return m[0].replace(/[.,;]+$/, '')
  }
  return undefined
}

export function requirementsFromFrontmatter(fm: YamlMap): SkillRequirements {
  const setup = asMap(fm.setup)
  const setupHelp = str(setup.help) || undefined
  const prereqs = asMap(fm.prerequisites)
  const hermesMeta = asMap(asMap(fm.metadata).hermes)

  const entries: { name: string; prompt?: string; help?: string; url?: string; optional?: boolean; requiredFor?: string }[] = []
  for (const item of asList(fm.required_environment_variables)) {
    if (typeof item === 'string') entries.push({ name: item })
    else if (item && typeof item === 'object' && !Array.isArray(item)) {
      entries.push({
        name: str(item.name) || str(item.env_var),
        prompt: str(item.prompt) || undefined,
        help: str(item.help) || undefined,
        url: str(item.provider_url) || str(item.url) || undefined,
        optional: item.optional === true,
        requiredFor: str(item.required_for) || undefined,
      })
    }
  }
  for (const item of asList(setup.collect_secrets)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    entries.push({
      name: str(item.env_var),
      prompt: str(item.prompt) || undefined,
      url: str(item.provider_url) || str(item.url) || undefined,
      optional: item.optional === true,
    })
  }
  for (const item of asList(prereqs.env_vars)) {
    const name = str(item)
    if (name) entries.push({ name })
  }

  const env: SkillEnvRequirement[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    const name = e.name.trim()
    if (!name || seen.has(name) || !ENV_NAME_RE.test(name)) continue
    seen.add(name)
    const help = e.help || (e.url ? undefined : setupHelp)
    const req: SkillEnvRequirement = {
      name,
      prompt: e.prompt || humanizeEnvName(name),
    }
    if (help) req.help = help
    const url = e.url || firstUrl(e.help, setupHelp)
    if (url) req.url = url
    if (e.optional) req.optional = true
    if (e.requiredFor) req.requiredFor = e.requiredFor
    env.push(req)
  }

  const platformsRaw = asList(fm.platforms).map((p) => str(p).toLowerCase()).filter(Boolean)
  const credentialFiles = asList(fm.required_credential_files)
    .map((f) => (typeof f === 'string' ? f : str(asMap(f).path)))
    .filter(Boolean)

  return {
    name: str(fm.name) || undefined,
    description: str(fm.description) || undefined,
    platforms: platformsRaw.length ? platformsRaw : null,
    env,
    commands: asList(prereqs.commands).map(str).filter(Boolean),
    credentialFiles,
    homepage: str(hermesMeta.homepage) || str(fm.homepage) || undefined,
    setupHelp,
  }
}

/** `NOTION_API_KEY` → "Notion API key" (fallback prompt). */
export function humanizeEnvName(name: string): string {
  const words = name
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => (['api', 'url', 'id', 'oauth'].includes(w) ? w.toUpperCase() : w))
  if (!words.length) return name
  const joined = words.join(' ').replace(/\bKEY\b/i, 'key')
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

export function parseSkillRequirements(md: string): SkillRequirements {
  const raw = extractFrontmatter(md)
  return requirementsFromFrontmatter(raw ? parseYamlSubset(raw) : {})
}
