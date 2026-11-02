import { useId, useRef, useState } from 'react'
import { isHexColor } from '../../../lib/color'
import {
  BUILTIN_PRESETS, DENSITIES, DENSITY_LABELS, FONT_IDS, FONT_LABELS, MOTION_LEVELS, MOTION_LABELS,
  RADIUS_MAX, RADIUS_MIN, commitDesignPreview, contrastChecks, designTokens,
  failingChecks, parsePresetFile, previewDesign, resetDesign, revertDesign, samePreset,
  serializePreset, setDesignScope, useDesign, type DesignPreset,
} from '../../../lib/design-preset'
import { Card, fieldClass, hintClass } from './common'

// 44px targets: this pane is used on a phone as often as on the desktop.
const actionClass = 'min-h-11 rounded-lg border border-[var(--desk-hairline-strong)] bg-[var(--desk-surface-3)] px-3 py-1.5 text-[13px] disabled:opacity-40'
const primaryActionClass = 'min-h-11 rounded-lg bg-[var(--desk-accent)] px-3 py-1.5 text-[13px] font-semibold text-[var(--desk-accent-ink)] disabled:opacity-40'
const presetButtonBase = 'flex min-h-11 flex-col items-start gap-1 rounded-lg border p-2 text-left text-[13px]'

/** A hex colour that is either picked or typed. Typing never applies a value
 *  that is not a full `#rrggbb`, so a partial paste cannot reach the canvas. */
function ColorField({ label, hint, value, onChange }: {
  label: string
  hint: string
  value: string
  onChange(next: string): void
}) {
  const id = useId()
  const [text, setText] = useState(value)
  const [typedError, setTypedError] = useState('')
  const last = useRef(value)
  // The preset can change underneath us (preset button, import, revert).
  if (last.current !== value) {
    last.current = value
    setText(value)
    setTypedError('')
  }
  const describe = `${id}-hint${typedError ? ` ${id}-error` : ''}`
  return <div>
    <label htmlFor={`${id}-text`} className="mb-1 block text-[12px] font-medium text-[var(--desk-text-secondary)]">{label}</label>
    <div className="flex items-center gap-2">
      <input id={`${id}-picker`} type="color" aria-label={`${label} picker`} value={value}
        aria-describedby={describe} onChange={(event) => onChange(event.target.value.toLowerCase())}
        className="h-11 w-12 shrink-0 cursor-pointer rounded-lg border border-[var(--desk-control-border)] bg-transparent p-1" />
      <input id={`${id}-text`} type="text" inputMode="text" spellCheck={false} maxLength={7}
        aria-label={label} aria-describedby={describe} value={text} className={`${fieldClass} font-mono`}
        onInput={(event) => {
          const next = event.currentTarget.value.trim()
          setText(next)
          const normalized = next.startsWith('#') ? next : `#${next}`
          if (isHexColor(normalized)) {
            setTypedError('')
            onChange(normalized.toLowerCase())
          } else {
            setTypedError(next ? `${label}: use a 6-digit hex like #2f7ed8` : '')
          }
        }}
        onBlur={() => { setText(value); setTypedError('') }} />
    </div>
    <p className={hintClass} id={`${id}-hint`}>{hint}</p>
    {typedError && <p className="mt-1 text-[12px] text-[var(--desk-danger)]" id={`${id}-error`} role="status">{typedError}</p>}
  </div>
}

export function DesignSection() {
  const state = useDesign()
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string[]>([])
  const [importNote, setImportNote] = useState('')
  const ids = useId()
  // Editing starts from whatever is on screen; "app default" edits clone the
  // shipped preset so a single tweak does not drop the whole palette.
  const base = state.shown ?? BUILTIN_PRESETS[0]!.preset
  const checks = contrastChecks(base)
  const failures = failingChecks(base)
  const tokens = designTokens(base)
  const savedForScope = state.scope === 'profile' ? state.profilePreset : state.globalPreset
  const scopeHasPreset = savedForScope !== null
  const update = (patch: Partial<DesignPreset>) => previewDesign({ ...base, ...patch })

  const loadFile = async (file: File) => {
    try {
      setImportText(await file.text())
    } catch {
      setImportError(['file: could not be read'])
    }
  }

  const runImport = () => {
    setImportNote('')
    const parsed = parsePresetFile(importText)
    if (!parsed.ok) {
      setImportError(parsed.errors)
      return
    }
    setImportError([])
    previewDesign(parsed.preset)
    setImportNote(`Imported “${parsed.preset.name}”. It is a preview — review it, then Apply.`)
  }

  const exportJson = serializePreset(base)
  const download = () => {
    try {
      const blob = new Blob([exportJson], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `hermes-desk-preset-${base.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      setImportError(['download: this window cannot save files — copy the JSON instead'])
    }
  }

  return <>
    <Card id="design" title="Design">
      <p className={hintClass}>
        Pick a preset to preview it on the whole app. Nothing is saved until you press Apply.
        Highlighted = previewing; “Saved” = stored for {state.scope === 'profile' ? `“${state.profile}”` : 'every profile'}.
        Reset returns to the shipped look.
      </p>
      <div role="group" aria-label="Design presets" className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {BUILTIN_PRESETS.map(({ id, preset }) => {
          const active = samePreset(preset, state.shown)
          const saved = samePreset(preset, savedForScope)
          return <button key={id} type="button" aria-pressed={active} onClick={() => previewDesign(preset)}
            className={`${presetButtonBase} relative ${active ? 'border-[var(--desk-accent)] bg-[var(--desk-accent-surface)]' : 'border-[var(--desk-hairline-strong)] bg-[var(--desk-surface-1)]'}`}>
            {saved && <span className="absolute right-2 top-2 rounded-full bg-[var(--desk-success-surface)] px-2 py-0.5 text-[11px] font-semibold text-[var(--desk-success)]">Saved</span>}
            <span className="flex items-center gap-1.5 font-medium">
              <span aria-hidden="true" className="inline-flex gap-1">
                {[preset.canvas, preset.surface, preset.accent].map((colour) => (
                  <span key={colour} className="h-3 w-3 rounded-full border border-[var(--desk-hairline-strong)]" style={{ background: colour }} />
                ))}
              </span>
              {preset.name}
            </span>
            <span className="text-[12px] text-[var(--desk-text-secondary)]">
              {preset.theme === 'dark' ? 'Dark' : 'Light'} · {DENSITY_LABELS[preset.density]} · {FONT_LABELS[preset.font]}
            </span>
          </button>
        })}
      </div>
    </Card>

    <Card id="design-preview" title="Live preview">
      <div aria-label="Design preview" role="group" style={{ background: tokens['--ca-canvas'], borderRadius: tokens['--ca-radius'], padding: 16 }}>
        <div style={{
          background: tokens['--ca-card'], color: tokens['--ca-ink'], borderRadius: tokens['--ca-radius'],
          border: `1px solid ${tokens['--ca-border']}`, padding: tokens['--ca-density-gap'],
          fontFamily: tokens['--ca-font'], boxShadow: tokens['--ca-shadow-soft'],
        }}>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
            <strong>Hermes</strong> · body text on a card,{' '}
            <span style={{ color: tokens['--ca-ink-muted'] }}>muted text beside it.</span>
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens['--ca-density-gap'], marginTop: tokens['--ca-density-gap'] }}>
            <span style={{
              alignSelf: 'flex-end', background: tokens['--ca-bubble-user'], color: '#ffffff',
              borderRadius: tokens['--ca-radius'], padding: '6px 10px', fontSize: 13,
            }}>A user bubble</span>
            <span style={{ color: tokens['--ca-primary-text'], fontSize: 13, fontWeight: 600 }}>Primary link</span>
            <span style={{ border: `1px solid ${tokens['--ca-field-border']}`, borderRadius: tokens['--ca-radius-sm'], padding: '4px 8px', fontSize: 12, alignSelf: 'flex-start' }}>Field border</span>
          </div>
        </div>
      </div>
      {failures.length === 0
        ? <p className={hintClass} role="status">Contrast: body, muted, primary text and button labels all meet WCAG AA.</p>
        : <div role="status" className="mt-2 rounded-lg border border-[var(--desk-warn)] p-2">
          <p className="text-[12px] font-medium text-[var(--desk-warn)]">Contrast warning — unreadable pairings:</p>
          <ul className="mt-1 list-inside list-disc text-[12px] text-[var(--desk-text-secondary)]">
            {failures.map((check) => <li key={check.id}>
              {check.label}: {check.ratio}:1 (needs {check.min}:1)
            </li>)}
          </ul>
        </div>}
      <ul aria-label="Contrast ratios" className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[12px] text-[var(--desk-text-secondary)] sm:grid-cols-2">
        {checks.map((check) => <li key={check.id} className="flex justify-between gap-2">
          <span>{check.label}</span>
          <span className={check.pass ? 'font-mono' : 'font-mono font-semibold text-[var(--desk-danger)]'}>
            {check.ratio}:1
          </span>
        </li>)}
      </ul>
    </Card>

    <Card id="design-custom" title="Custom design">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ColorField label="Accent colour" hint="Links, primary buttons and focus rings." value={base.accent} onChange={(accent) => update({ accent })} />
        <ColorField label="Canvas colour" hint="The page behind everything." value={base.canvas} onChange={(canvas) => update({ canvas })} />
        <ColorField label="Card colour" hint="Messages, panels and fields." value={base.surface} onChange={(surface) => update({ surface })} />
        <ColorField label="Text colour" hint="Body and heading text." value={base.ink} onChange={(ink) => update({ ink })} />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${ids}-radius`} className="mb-1 block text-[12px] font-medium text-[var(--desk-text-secondary)]">
            Corner radius — {base.radius}px
          </label>
          <input id={`${ids}-radius`} type="range" aria-label="Corner radius" min={RADIUS_MIN} max={RADIUS_MAX} step={2} value={base.radius}
            onChange={(event) => update({ radius: Number(event.target.value) })}
            className="h-9 w-full" aria-valuetext={`${base.radius} pixels`} />
        </div>
        <div>
          <label htmlFor={`${ids}-density`} className="mb-1 block text-[12px] font-medium text-[var(--desk-text-secondary)]">Density</label>
          <select id={`${ids}-density`} value={base.density} className={fieldClass}
            onChange={(event) => update({ density: event.target.value as DesignPreset['density'] })}>
            {DENSITIES.map((density) => <option key={density} value={density}>{DENSITY_LABELS[density]}</option>)}
          </select>
          <p className={hintClass}>Transcript spacing.</p>
        </div>
        <div>
          <label htmlFor={`${ids}-font`} className="mb-1 block text-[12px] font-medium text-[var(--desk-text-secondary)]">Font</label>
          <select id={`${ids}-font`} value={base.font} className={fieldClass}
            onChange={(event) => update({ font: event.target.value as DesignPreset['font'] })}>
            {FONT_IDS.map((font) => <option key={font} value={font}>{FONT_LABELS[font]}</option>)}
          </select>
          <p className={hintClass}>From a fixed list of safe stacks.</p>
        </div>
        <div>
          <label htmlFor={`${ids}-motion`} className="mb-1 block text-[12px] font-medium text-[var(--desk-text-secondary)]">Motion</label>
          <select id={`${ids}-motion`} value={base.motion} className={fieldClass}
            onChange={(event) => update({ motion: event.target.value as DesignPreset['motion'] })}>
            {MOTION_LEVELS.map((motion) => <option key={motion} value={motion}>{MOTION_LABELS[motion]}</option>)}
          </select>
          <p className={hintClass}>Animation length. None turns transitions off.</p>
        </div>
      </div>
      <div className="mt-3">
        <label htmlFor={`${ids}-name`} className="mb-1 block text-[12px] font-medium text-[var(--desk-text-secondary)]">Preset name</label>
        <input id={`${ids}-name`} type="text" aria-label="Preset name" maxLength={40} value={base.name} className={fieldClass}
          aria-describedby={`${ids}-name-hint`} onChange={(event) => update({ name: event.target.value })} />
        <p className={hintClass} id={`${ids}-name-hint`}>
          {base.name.trim() ? `${base.name.trim().length}/40 characters.` : 'A blank name is saved as “Custom design”.'}
        </p>
      </div>
    </Card>

    <Card id="design-save" title="Apply and save">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primaryActionClass} disabled={!state.dirty} onClick={() => commitDesignPreview()}>Apply</button>
        <button type="button" className={actionClass} disabled={!state.dirty} onClick={() => revertDesign()}>Revert</button>
        <button type="button" className={actionClass} disabled={!scopeHasPreset} onClick={() => resetDesign()}>
          Reset {state.scope === 'profile' ? 'this profile' : 'all profiles'}
        </button>
      </div>
      <p className="mt-2 text-[12px] font-medium" role="status">
        {state.dirty ? 'Previewing unsaved changes — they disappear on reload.' : 'No unsaved changes.'}
      </p>
      <div className="mt-3">
        <label htmlFor={`${ids}-scope`} className="mb-1 block text-[12px] font-medium text-[var(--desk-text-secondary)]">Save this preset for</label>
        <select id={`${ids}-scope`} value={state.scope} className={fieldClass}
          onChange={(event) => setDesignScope(event.target.value as 'global' | 'profile')}>
          <option value="global">Every profile</option>
          <option value="profile">Only “{state.profile}”</option>
        </select>
      </div>
      <p className={hintClass}>
        {state.profilePreset
          ? `In use now: “${state.profilePreset.name}”, saved for ${state.profile}${state.globalPreset ? ` (global fallback: ${state.globalPreset.name})` : ''}.`
          : state.globalPreset
            ? `In use now: “${state.globalPreset.name}” for every profile. This profile has no preset of its own.`
            : 'In use now: the app default look. Nothing is saved yet.'}
      </p>
      {state.scope === 'global' && state.profilePreset && (
        <p className={hintClass}>
          “{state.profile}” has its own preset, so resetting every profile will not change what you see — reset this profile to fall back.
        </p>
      )}
      <p className={hintClass}>
        A preset carries its own light or dark base, so applying one sets the Theme above to match it.
      </p>
    </Card>

    <Card id="design-transfer" title="Export or import">
      <p className={hintClass}>A preset file is versioned JSON. An agent can hand you one to paste or open here; nothing is applied until you press Apply.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={actionClass} onClick={download}>Download preset</button>
        <button type="button" className={actionClass} onClick={() => { setImportError([]); setImportNote(''); void navigator.clipboard?.writeText(exportJson).then(() => setImportNote('Copied the preset JSON.')).catch(() => setImportError(['copy: the clipboard is unavailable — select the JSON below'])) }}>
          Copy JSON
        </button>
      </div>
      <label htmlFor={`${ids}-export`} className="mt-3 mb-1 block text-[12px] font-medium text-[var(--desk-text-secondary)]">Current preset JSON</label>
      <textarea id={`${ids}-export`} readOnly rows={6} aria-label="Current preset JSON" value={exportJson}
        className={`${fieldClass} font-mono text-[11px]`} />
      <label htmlFor={`${ids}-import`} className="mt-3 mb-1 block text-[12px] font-medium text-[var(--desk-text-secondary)]">Paste a preset to import</label>
      <textarea id={`${ids}-import`} rows={6} aria-label="Paste a preset to import" value={importText} spellCheck={false}
        placeholder='{"kind":"hermes-desk.design-preset","schemaVersion":1,"preset":{…}}'
        onChange={(event) => setImportText(event.target.value)}
        className={`${fieldClass} font-mono text-[11px]`} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={actionClass} disabled={!importText.trim()} onClick={runImport}>Import as preview</button>
        <label className="text-[12px] text-[var(--desk-text-secondary)]">
          Or open a file
          <input type="file" accept="application/json,.json" aria-label="Choose a preset file"
            className="ml-2 align-middle text-[12px]"
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadFile(file) }} />
        </label>
      </div>
      {importError.length > 0 && <div role="alert" className="mt-2 rounded-lg border border-[var(--desk-danger)] p-2">
        <p className="text-[12px] font-medium text-[var(--desk-danger)]">Preset rejected — nothing was applied:</p>
        <ul className="mt-1 list-inside list-disc font-mono text-[11px] text-[var(--desk-text-secondary)]">
          {importError.map((message) => <li key={message}>{message}</li>)}
        </ul>
      </div>}
      {importNote && <p className="mt-2 text-[12px] text-[var(--desk-success)]" role="status">{importNote}</p>}
    </Card>
  </>
}