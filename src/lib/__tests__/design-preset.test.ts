import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_PRESETS, DESIGN_KEY, DESIGN_SCHEMA_VERSION, DESIGN_TOKEN_NAMES, FONT_STACKS,
  commitDesignPreview, contrastChecks, designTokens, failingChecks, getDesignState, initDesign,
  parsePreset, parsePresetFile, previewDesign, resetDesign, resetDesignStoreForTests, revertDesign,
  serializePreset, setDesignProfile, setDesignScope, type DesignPreset,
} from '../design-preset'

const desk = (): DesignPreset => ({ ...BUILTIN_PRESETS[0]!.preset })
const root = () => document.documentElement
const token = (name: string) => root().style.getPropertyValue(name)

beforeEach(() => {
  window.localStorage.clear()
  root().removeAttribute('style')
  root().removeAttribute('data-design')
  root().removeAttribute('data-theme')
  resetDesignStoreForTests()
})

describe('strict preset parsing', () => {
  it('accepts a well-formed preset and lowercases its colours', () => {
    const parsed = parsePreset({ ...desk(), accent: '#AABBCC' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.preset.accent).toBe('#aabbcc')
  })

  it('rejects unknown fields instead of ignoring them', () => {
    const parsed = parsePreset({ ...desk(), css: 'body{display:none}', styleTag: '<style>' })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.errors).toContain('preset.css: unknown field')
      expect(parsed.errors).toContain('preset.styleTag: unknown field')
    }
  })

  it('rejects missing fields and reports each one', () => {
    const { ink: _ink, radius: _radius, ...rest } = desk()
    const parsed = parsePreset(rest)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.errors).toContain('preset.ink: missing')
      expect(parsed.errors).toContain('preset.radius: missing')
    }
  })

  it('rejects out-of-range and wrong-typed values with field paths', () => {
    const cases: Array<[string, unknown, string]> = [
      ['radius', 999, 'preset.radius'],
      ['radius', -4, 'preset.radius'],
      ['radius', 12.5, 'preset.radius'],
      ['radius', '12', 'preset.radius'],
      ['accent', 'red', 'preset.accent'],
      ['accent', 'url(https://example.com/x.png)', 'preset.accent'],
      ['canvas', '#fff', 'preset.canvas'],
      ['theme', 'sepia', 'preset.theme'],
      ['density', 'wide', 'preset.density'],
      ['font', 'comic-sans', 'preset.font'],
      ['motion', 'slow', 'preset.motion'],
      ['name', '', 'preset.name'],
    ]
    for (const [field, value, path] of cases) {
      const parsed = parsePreset({ ...desk(), [field]: value })
      expect(parsed.ok, `${field}=${String(value)}`).toBe(false)
      if (!parsed.ok) expect(parsed.errors.some((error) => error.startsWith(path)), path).toBe(true)
    }
  })

  it('rejects non-objects and malformed names', () => {
    expect(parsePreset(null).ok).toBe(false)
    expect(parsePreset([]).ok).toBe(false)
    expect(parsePreset('Dusk').ok).toBe(false)
    const parsed = parsePreset({ ...desk(), name: 'a\u0000b' })
    expect(parsed.ok).toBe(false)
  })
})

describe('versioned preset file import', () => {
  it('round-trips through serializePreset', () => {
    const parsed = parsePresetFile(serializePreset(BUILTIN_PRESETS[4]!.preset))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.preset).toEqual(BUILTIN_PRESETS[4]!.preset)
  })

  it('rejects a wrong kind, a wrong schema version, and unknown envelope fields', () => {
    const envelope = JSON.parse(serializePreset(desk()))
    for (const broken of [
      { ...envelope, kind: 'something-else' },
      { ...envelope, schemaVersion: DESIGN_SCHEMA_VERSION + 1 },
      { ...envelope, extra: true },
    ]) {
      const parsed = parsePresetFile(JSON.stringify(broken))
      expect(parsed.ok).toBe(false)
    }
  })

  it('rejects non-JSON text and a JSON array without applying anything', () => {
    initDesign()
    for (const text of ['', 'not json', '[]', '{"kind":"hermes-desk.design-preset"}']) {
      const parsed = parsePresetFile(text)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.errors.length).toBeGreaterThan(0)
    }
    expect(root().hasAttribute('data-design')).toBe(false)
    expect(token('--ca-canvas')).toBe('')
  })

  it('reports the inner field path for a bad preset inside a valid envelope', () => {
    const envelope = JSON.parse(serializePreset(desk()))
    envelope.preset.radius = 99
    const parsed = parsePresetFile(JSON.stringify(envelope))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors.some((error) => error.includes('preset.radius'))).toBe(true)
  })
})

describe('applied tokens stay inside the allowlist', () => {
  it('writes every allowlisted property and nothing else', () => {
    previewDesign(desk())
    const inline = Array.from(root().style)
    expect(inline.length).toBe(DESIGN_TOKEN_NAMES.length)
    for (const name of inline) expect(DESIGN_TOKEN_NAMES as readonly string[]).toContain(name)
    for (const name of DESIGN_TOKEN_NAMES) expect(token(name)).not.toBe('')
  })

  it('never carries CSS, a URL, a variable reference or a selector', () => {
    previewDesign({ ...desk(), radius: 24, font: 'serif', density: 'roomy', motion: 'none' })
    for (const name of DESIGN_TOKEN_NAMES) {
      const value = token(name)
      expect(value).not.toMatch(/url\(|var\(|javascript:|[;{}<>]/i)
    }
    expect(token('--ca-font')).toBe(FONT_STACKS.serif)
    expect(token('--ca-dur-1')).toBe('0ms')
    expect(token('--ca-radius')).toBe('24px')
  })

  it('derives tokens from validated colours only', () => {
    const tokens = designTokens(desk())
    expect(tokens['--ca-canvas']).toBe('#9ecdff')
    expect(tokens['--ca-card']).toBe('#ffffff')
    for (const value of Object.values(tokens)) expect(value).not.toMatch(/url\(|var\(|[;{}<>]/i)
  })
})

describe('dirty preview versus saved state', () => {
  it('previews without writing storage and clears on revert', () => {
    initDesign()
    const dark = { ...BUILTIN_PRESETS[1]!.preset }
    previewDesign(dark)
    expect(window.localStorage.getItem(DESIGN_KEY)).toBeNull()
    expect(getDesignState().dirty).toBe(true)
    expect(root().getAttribute('data-design')).toBe('')
    expect(token('--ca-canvas')).toBe('#000000')
    revertDesign()
    expect(getDesignState().dirty).toBe(false)
    expect(root().hasAttribute('data-design')).toBe(false)
    expect(token('--ca-canvas')).toBe('')
  })

  it('persists on commit only, in the versioned envelope', () => {
    initDesign()
    const paper = { ...BUILTIN_PRESETS[2]!.preset }
    previewDesign(paper)
    expect(commitDesignPreview()).toEqual(paper)
    const envelope = JSON.parse(window.localStorage.getItem(DESIGN_KEY)!)
    expect(envelope).toMatchObject({
      slice: 'hermes-desk.design-preset', schemaVersion: DESIGN_SCHEMA_VERSION, scope: 'client-persisted',
    })
    expect(envelope.value.global).toEqual(paper)
    expect(typeof envelope.savedAt).toBe('string')
    expect(getDesignState().dirty).toBe(false)
    expect(getDesignState().saved).toEqual(paper)
  })

  it('saves a blank name as “Custom design” instead of writing an invalid preset', () => {
    initDesign()
    previewDesign({ ...desk(), name: '   ' })
    const saved = commitDesignPreview()
    expect(saved?.name).toBe('Custom design')
    root().removeAttribute('style')
    resetDesignStoreForTests()
    initDesign()
    expect(getDesignState().saved?.name).toBe('Custom design')
    expect(token('--ca-canvas')).toBe('#9ecdff')
  })

  it('reapplies the saved preset after a reload and drops a corrupt one', () => {
    initDesign()
    previewDesign({ ...BUILTIN_PRESETS[3]!.preset })
    commitDesignPreview()
    root().removeAttribute('style')
    root().removeAttribute('data-design')
    resetDesignStoreForTests()
    initDesign()
    expect(token('--ca-canvas')).toBe('#e4ecdf')

    window.localStorage.setItem(DESIGN_KEY, JSON.stringify({
      slice: 'hermes-desk.design-preset', schemaVersion: DESIGN_SCHEMA_VERSION, scope: 'client-persisted',
      value: { global: { ...desk(), radius: 999 }, profiles: {} },
    }))
    root().removeAttribute('style')
    resetDesignStoreForTests()
    initDesign()
    expect(root().hasAttribute('data-design')).toBe(false)
    expect(getDesignState().saved).toBeNull()
  })
})

describe('per-profile selection', () => {
  it('uses the profile preset when one exists and the global preset otherwise', () => {
    initDesign()
    const global = { ...BUILTIN_PRESETS[2]!.preset }
    previewDesign(global)
    commitDesignPreview()

    setDesignProfile('nub')
    expect(getDesignState().saved).toEqual(global)

    const own = { ...BUILTIN_PRESETS[5]!.preset, name: 'Nub Ember' }
    setDesignScope('profile')
    previewDesign(own)
    commitDesignPreview()
    expect(getDesignState().saved).toEqual(own)
    expect(token('--ca-canvas')).toBe('#15100c')

    setDesignProfile('default')
    expect(getDesignState().saved).toEqual(global)
    expect(token('--ca-canvas')).toBe('#f2ede2')

    setDesignProfile('nub')
    expect(getDesignState().saved).toEqual(own)
  })

  it('falls back to the global preset when the profile preset is reset', () => {
    initDesign()
    previewDesign({ ...BUILTIN_PRESETS[2]!.preset })
    commitDesignPreview()
    setDesignScope('profile')
    previewDesign({ ...BUILTIN_PRESETS[5]!.preset })
    commitDesignPreview()

    resetDesign()
    expect(getDesignState().profilePreset).toBeNull()
    expect(getDesignState().saved).toEqual(BUILTIN_PRESETS[2]!.preset)
    expect(token('--ca-canvas')).toBe('#f2ede2')
  })

  it('drops an unsaved preview when the active profile changes', () => {
    initDesign()
    previewDesign({ ...BUILTIN_PRESETS[1]!.preset })
    expect(getDesignState().dirty).toBe(true)
    setDesignProfile('nub')
    expect(getDesignState().dirty).toBe(false)
    expect(getDesignState().preview).toBeNull()
  })
})

describe('storage failure', () => {
  it('keeps the design live when writing is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota') })
    initDesign()
    const dusk = { ...BUILTIN_PRESETS[4]!.preset }
    previewDesign(dusk)
    expect(() => commitDesignPreview()).not.toThrow()
    expect(getDesignState().saved).toEqual(dusk)
    expect(token('--ca-canvas')).toBe('#13111a')
  })

  it('falls back to no preset when reading is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Private mode') })
    expect(() => initDesign()).not.toThrow()
    expect(getDesignState().saved).toBeNull()
    expect(root().hasAttribute('data-design')).toBe(false)
  })
})

describe('contrast reporting', () => {
  it('ships only AA presets', () => {
    for (const { preset } of BUILTIN_PRESETS) {
      const failures = failingChecks(preset)
      expect(failures, preset.name).toEqual([])
      expect(contrastChecks(preset).length).toBe(6)
    }
  })

  it('names the failing pairing instead of hiding unreadable text', () => {
    const broken = { ...desk(), ink: '#8f8f8f' }
    const failures = failingChecks(broken)
    expect(failures.map((check) => check.id)).toContain('ink-surface')
    expect(failures.map((check) => check.id)).toContain('ink-canvas')
    const surface = failures.find((check) => check.id === 'ink-surface')!
    expect(surface.label).toBe('Body text on cards')
    expect(surface.ratio).toBeLessThan(4.5)
    expect(surface.pass).toBe(false)
  })

  it('steps the accent text tone up to AA even when the accent itself is bright', () => {
    const bright = { ...desk(), accent: '#ffe14d' }
    const tokens = designTokens(bright)
    expect(tokens['--ca-primary-text']).not.toBe('#ffe14d')
    const primary = contrastChecks(bright).find((check) => check.id === 'primary-surface')!
    expect(primary.pass).toBe(true)
  })
})