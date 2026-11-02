import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLICK_ONCE_RE,
  HUD_MARKER_NOTE,
  POINT_ONCE_RE,
  TYPE_ONCE_RE,
  hudMarkerNoteEnabled,
  withHudMarkerNote,
} from '../hud-protocol'

/**
 * The marker grammar has to survive three separate places agreeing:
 *   - the NOTE, which teaches the model the syntax;
 *   - the REGEXES, which the renderer parses replies with;
 *   - the INJECTION, which decides which turns see the note at all.
 * A note that documents [CLICK:x,y] while the parser looks for something else
 * produces no error anywhere — the cat just quietly does nothing. These tests
 * exist to make that disagreement loud.
 */

// Resolved from the project root (vitest runs there) rather than via
// import.meta.url — this fs shim rejects `file:` URL objects.
const DOC = resolve(process.cwd(), 'docs/hud-surface-note.md')
const TRANSPORT = resolve(process.cwd(), 'src/lib/agents/hermes-transport.ts')

describe('HUD_MARKER_NOTE — the text that teaches the model', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('documents all three markers', () => {
    expect(HUD_MARKER_NOTE).toContain('[POINT:')
    expect(HUD_MARKER_NOTE).toContain('[CLICK:')
    expect(HUD_MARKER_NOTE).toContain('[TYPE:')
  })

  it('bans guessed coordinates — there is no screen capture yet', () => {
    expect(HUD_MARKER_NOTE).toMatch(/NEVER guess coordinates/)
    // the ban is only credible if the note also says why
    expect(HUD_MARKER_NOTE).toMatch(/screenshot/i)
  })

  it('teaches that coordinates can be negative (multi-monitor)', () => {
    expect(HUD_MARKER_NOTE).toMatch(/negative/i)
  })

  it('caps the blast radius: one act marker per reply, no destructive clicks', () => {
    expect(HUD_MARKER_NOTE).toMatch(/At most ONE act marker/)
    expect(HUD_MARKER_NOTE).toMatch(/destructive/i)
  })

  it('its worked example actually parses with the shipped regex', () => {
    // The drift this catches: note says [POINT:x,y:label], parser expects a
    // different shape, model emits correct-looking markers, cat never moves.
    const example = '[POINT:842,510:Save button]'
    expect(HUD_MARKER_NOTE).toContain(example)
    const m = POINT_ONCE_RE.exec(example)
    if (!m) throw new Error('note example did not parse')
    expect([m[1], m[2], m[3]]).toEqual(['842', '510', 'Save button'])
  })

  it('every marker form the note documents parses — [CLICK:] and [TYPE:] too', () => {
    const c = CLICK_ONCE_RE.exec('[CLICK:640,480]')
    if (!c) throw new Error('[CLICK:] did not parse')
    expect([c[1], c[2]]).toEqual(['640', '480'])
    const t = TYPE_ONCE_RE.exec('[TYPE:hello there]')
    if (!t) throw new Error('[TYPE:] did not parse')
    expect(t[1]).toBe('hello there')
  })
})

describe('withHudMarkerNote — prepend without corrupting the prompt', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('prepends the note and keeps the user text verbatim', () => {
    const out = withHudMarkerNote('where is the save button?')
    expect(out).toBe(`${HUD_MARKER_NOTE}\n\nwhere is the save button?`)
  })

  it('leaves empty and whitespace-only prompts alone', () => {
    expect(withHudMarkerNote('')).toBe('')
    expect(withHudMarkerNote('   ')).toBe('   ')
  })

  it('survives a non-string prompt instead of throwing', () => {
    expect(withHudMarkerNote(null as unknown as string)).toBe('')
    expect(withHudMarkerNote(undefined as unknown as string)).toBe('')
  })

  it('an explicit `enabled: false` wins without touching storage', () => {
    expect(withHudMarkerNote('hello', false)).toBe('hello')
    expect(withHudMarkerNote('hello', true)).toContain('hello')
  })
})

describe('the kill switch (once the server ships its own note)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('is on by default', () => {
    expect(hudMarkerNoteEnabled()).toBe(true)
  })

  it('localStorage nub:hud:markerNote = "off" turns it off', () => {
    localStorage.setItem('nub:hud:markerNote', 'off')
    expect(hudMarkerNoteEnabled()).toBe(false)
    expect(withHudMarkerNote('hello')).toBe('hello')
  })

  it('any other stored value leaves it on', () => {
    localStorage.setItem('nub:hud:markerNote', 'on')
    expect(hudMarkerNoteEnabled()).toBe(true)
    localStorage.setItem('nub:hud:markerNote', '')
    expect(hudMarkerNoteEnabled()).toBe(true)
  })

  it('a storage that throws fails OPEN, not closed', () => {
    // Safari private mode throws on localStorage access. Failing closed would
    // silently strip the grammar; failing open just shows the note.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(hudMarkerNoteEnabled()).toBe(true)
  })
})

describe('docs/hud-surface-note.md is the copy-paste proposal', () => {
  it('contains the canonical note verbatim — no drift', () => {
    const doc = readFileSync(DOC, 'utf8')
    expect(doc).toContain(HUD_MARKER_NOTE)
  })

  it('says it is a proposal, so nobody mistakes it for shipped behaviour', () => {
    const doc = readFileSync(DOC, 'utf8')
    expect(doc).toMatch(/Status: PROPOSAL/)
  })
})

describe('injection — the note reaches the model on HUD turns only', () => {
  const src = readFileSync(TRANSPORT, 'utf8')

  it('imports the shared note rather than inlining a second copy', () => {
    expect(src).toMatch(/import \{ withHudMarkerNote \} from '\.\.\/hud-protocol'/)
  })

  it('gates priming on this window actually being the HUD', () => {
    expect(src).toMatch(/function hudPrimedText\(/)
    expect(src).toMatch(/isHudWindow\(\) \? withHudMarkerNote\(text\) : text/)
  })

  it('primes the user turn and leaves the two subagent turns alone', () => {
    // Three turns carry surface:"hud". Only the user's own turn is primed:
    // the note tells the reader it IS the cat, and a background worker is not.
    const hudSubmits = src.match(/servePromptSubmit\(client, \{[^}]*hudSurface\(\)[^}]*\}\)/g) ?? []
    expect(hudSubmits.length).toBe(3)
    expect(hudSubmits.filter((s) => s.includes('hudPrimedText(')).length).toBe(1)
    expect(src).toMatch(/text: hudPrimedText\(promptWithPeerRoster\(/)
  })

  it('primes the peer-roster prompt, i.e. the model input, never the rendered reply', () => {
    // If the note landed on the reply instead, the user would read it.
    expect(src).toMatch(/text: hudPrimedText\([^)]*promptWithPeerRoster/)
  })
})
