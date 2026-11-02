import { useEffect, useRef, useState } from 'react'
import { FatCatIcon, type CatExpression } from './FatCatIcon'
import { NUBCAT_COLORS } from '../lib/agents'
import { FX_STATE_LABELS, FX_STATES, type FxState } from '../lib/blob-fx'

const EXPR_CYCLE: CatExpression[] = [
  'idle',
  'happy',
  'curious',
  'thinking',
  'working',
  'sleeping',
  'error',
]

const COLOR_CYCLE = [...NUBCAT_COLORS]

/**
 * The demo cycles blob-fx pattern names; each maps to the legacy
 * expression whose owl presence reads closest (dots→thinking, orbit→
 * waiting-approval, ball→happy, standby→sleep, …).
 */
const PATTERN_TO_STATE: Record<FxState, CatExpression> = {
  dots: 'thinking',
  orbit: 'orbit',
  radar: 'radar',
  progress: 'progress',
  gather: 'spawning',
  wave: 'dictating',
  send: 'sending',
  receive: 'receiving',
  dock: 'uploading',
  ball: 'bouncing',
  whirl: 'loading',
  pencil: 'writing',
  bang: 'alerting',
  standby: 'powering-down',
}

const PAUSE_MS = 5000

type DemoMode = 'colors' | 'fx' | 'expression' | 'grid'

/**
 * Compact strip that cycles nubcat COLORS, expressions and FX —
 * useful in Settings / polish demos. Defaults to colors so the four
 * palettes are visible immediately.
 */
export function FatCatIconDemo({ intervalMs = 1800 }: { intervalMs?: number }) {
  const [colorIdx, setColorIdx] = useState(0)
  const [exprIdx, setExprIdx] = useState(0)
  const [fxIdx, setFxIdx] = useState(0)
  const [mode, setMode] = useState<DemoMode>('colors')
  const [framed, setFramed] = useState(true)
  const pauseUntil = useRef(0)

  const color = COLOR_CYCLE[colorIdx]!
  const expression = EXPR_CYCLE[exprIdx]!
  const fxState = FX_STATES[fxIdx]!

  useEffect(() => {
    if (mode === 'grid') return
    const id = window.setInterval(() => {
      if (Date.now() < pauseUntil.current) return
      if (mode === 'colors') {
        setColorIdx((i) => (i + 1) % COLOR_CYCLE.length)
      } else if (mode === 'fx') {
        setFxIdx((i) => (i + 1) % FX_STATES.length)
      } else {
        setExprIdx((i) => (i + 1) % EXPR_CYCLE.length)
      }
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, mode])

  const pickColor = (i: number) => {
    pauseUntil.current = Date.now() + PAUSE_MS
    setMode('colors')
    setColorIdx(i)
  }

  const pickExpr = (i: number) => {
    pauseUntil.current = Date.now() + PAUSE_MS
    setMode('expression')
    setExprIdx(i)
  }

  const pickFx = (i: number) => {
    pauseUntil.current = Date.now() + PAUSE_MS
    setMode('fx')
    setFxIdx(i)
  }

  const activeExpression: CatExpression =
    mode === 'colors'
      ? 'idle'
      : mode === 'fx'
        ? PATTERN_TO_STATE[fxState]
        : expression

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {mode !== 'grid' && (
          <FatCatIcon
            shape="cat"
            fgColor={color}
            expression={activeExpression}
            size={120}
            framed={framed}
            title={
              mode === 'colors'
                ? `Nubcat — ${color}`
                : mode === 'fx'
                  ? `FX — ${FX_STATE_LABELS[fxState]}`
                  : `Demo — ${expression}`
            }
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => {
                pauseUntil.current = Date.now() + PAUSE_MS
                setMode('colors')
              }}
              className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                mode === 'colors'
                  ? 'bg-[var(--ca-primary-fill)] text-white'
                  : 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink-muted)]'
              }`}
            >
              Colors ({COLOR_CYCLE.length})
            </button>
            <button
              type="button"
              onClick={() => {
                pauseUntil.current = Date.now() + PAUSE_MS
                setMode('fx')
              }}
              className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                mode === 'fx'
                  ? 'bg-[var(--ca-primary-fill)] text-white'
                  : 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink-muted)]'
              }`}
            >
              FX ({FX_STATES.length})
            </button>
            <button
              type="button"
              onClick={() => {
                pauseUntil.current = Date.now() + PAUSE_MS
                setMode('grid')
              }}
              className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                mode === 'grid'
                  ? 'bg-[var(--ca-primary-fill)] text-white'
                  : 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink-muted)]'
              }`}
            >
              All 14
            </button>
            <button
              type="button"
              onClick={() => {
                pauseUntil.current = Date.now() + PAUSE_MS
                setMode('expression')
              }}
              className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                mode === 'expression'
                  ? 'bg-[var(--ca-primary-fill)] text-white'
                  : 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink-muted)]'
              }`}
            >
              Expressions
            </button>
            <button
              type="button"
              onClick={() => setFramed((f) => !f)}
              className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${
                framed
                  ? 'nub-solid-navy'
                  : 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink-muted)]'
              }`}
              title="Toggle navy chip frame"
            >
              {framed ? 'framed' : 'unframed'}
            </button>
          </div>
          {mode === 'colors' ? (
            <div className="flex flex-wrap gap-1">
              {COLOR_CYCLE.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => pickColor(i)}
                  className={`rounded-lg px-1.5 py-0.5 text-[9px] font-medium transition ${
                    i === colorIdx
                      ? 'bg-[var(--ca-primary-fill)] text-white'
                      : 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink)] hover:bg-[var(--ca-card)]'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          ) : mode === 'fx' ? (
            <div className="flex flex-wrap gap-1">
              {FX_STATES.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => pickFx(i)}
                  title={FX_STATE_LABELS[s]}
                  className={`rounded-lg px-1.5 py-0.5 text-[9px] font-medium transition ${
                    i === fxIdx
                      ? 'bg-[var(--ca-primary-fill)] text-white'
                      : 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink)] hover:bg-[var(--ca-card)]'
                  }`}
                >
                  {FX_STATE_LABELS[s] ?? s}
                </button>
              ))}
            </div>
          ) : mode === 'expression' ? (
            <div className="flex flex-wrap gap-1.5">
              {EXPR_CYCLE.map((e, i) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => pickExpr(i)}
                  className={`rounded-lg px-2 py-1 text-[10px] font-medium transition ${
                    i === exprIdx
                      ? 'bg-[var(--ca-primary-fill)] text-white'
                      : 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink)] hover:bg-[var(--ca-card)]'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {mode === 'grid' && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {FX_STATES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => pickFx(FX_STATES.indexOf(s))}
              className="flex flex-col items-center gap-1 rounded-xl bg-[var(--ca-primary-soft)] px-1 py-2 hover:bg-[var(--ca-card)]"
              title={FX_STATE_LABELS[s]}
            >
              <FatCatIcon
                expression={PATTERN_TO_STATE[s]}
                fgColor={color}
                size={44}
                framed={framed}
                title={FX_STATE_LABELS[s]}
              />
              <span className="max-w-full truncate text-[9px] font-medium text-[var(--ca-ink)]">
                {s}
              </span>
              <span className="max-w-full truncate text-[8px] text-[var(--ca-ink-muted)]">
                {FX_STATE_LABELS[s].split('·')[1]?.trim() ?? ''}
              </span>
            </button>
          ))}
        </div>
      )}

      <p className="text-[11px] text-[var(--ca-ink-muted)]">
        FatCatIcon — {COLOR_CYCLE.length} nubcats · {FX_STATES.length} FX states ·{' '}
        {mode === 'colors' ? (
          <>
            color: <strong>{color}</strong>
          </>
        ) : mode === 'fx' ? (
          <>
            fx: <strong>{FX_STATE_LABELS[fxState]}</strong>
          </>
        ) : mode === 'grid' ? (
          <>grid shows all {FX_STATES.length} FX states (click to focus)</>
        ) : (
          <>
            expression: <strong>{expression}</strong>
          </>
        )}
        {' · '}
        {framed ? 'navy frame' : 'transparent bg'} · manual pick pauses ~5s
      </p>
    </div>
  )
}
