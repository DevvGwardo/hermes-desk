import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { hudActVisibilityGate } = require('./hud-act-gate.cjs')

const MAIN_CJS = readFileSync(resolve(process.cwd(), 'electron/main.cjs'), 'utf8')

describe('hud-act-gate module (D-03 visibility floor)', () => {
  it('allows acting when the HUD is expanded (collapsed=false)', () => {
    expect(hudActVisibilityGate(false)).toEqual({ allowed: true })
  })

  it('refuses with hud-collapsed when the cat is collapsed to the orb', () => {
    const verdict = hudActVisibilityGate(true)
    expect(verdict.allowed).toBe(false)
    expect(verdict.error).toBe('hud-collapsed')
    expect(verdict.hint).toBeTruthy()
  })

  it('treats missing/undefined state as collapsed (fail-closed on unknown visibility)', () => {
    // A caller that lost track of hudCollapse must not get an implicit allow.
    expect(hudActVisibilityGate(undefined).allowed).toBe(false)
    expect(hudActVisibilityGate(null).allowed).toBe(false)
  })
})

describe('main.cjs wiring (D-03)', () => {
  it('both act handlers consult the visibility gate BEFORE the trust check', () => {
    // The gate must sit ahead of screenAct.actStatus in both handlers so a
    // collapsed HUD refuses before any Accessibility probe or spawn.
    const clickHandler = MAIN_CJS.slice(MAIN_CJS.indexOf("function hudClickAt"), MAIN_CJS.indexOf('maia:hud:clickAt'))
    expect(clickHandler).toContain('hudActVisibilityGate')
    const visIdx = clickHandler.indexOf('hudActVisibilityGate')
    const trustIdx = clickHandler.indexOf('actStatus')
    expect(visIdx).toBeGreaterThan(-1)
    expect(trustIdx).toBeGreaterThan(visIdx)
  })

  it('typeText handler refuses through the same gate', () => {
    const typeHandler = MAIN_CJS.slice(MAIN_CJS.indexOf("ipcHandle('maia:hud:typeText'"), MAIN_CJS.indexOf('execFile(osascript'))
    expect(typeHandler).toContain('hudActVisibilityGate')
    expect(typeHandler).toContain('hudActVisibilityGate(hudCollapse.collapsed)')
  })

  it('no inline `hudCollapse.collapsed` spawnless refusal remains in main.cjs — the gate module is the single source', () => {
    // The pre-refactor inline `if (hudCollapse.collapsed) return …` shape is
    // what this replaces; if it reappears, the module and the handler drifted.
    expect(MAIN_CJS).not.toMatch(/if \(hudCollapse\.collapsed\) \{\s*\n\s*return/)
  })
})
