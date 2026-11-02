/**
 * GitHub-style activity grid for Home: one column per week, one row per
 * weekday, a single-hue ramp (brighter = more chats). Fits as many weeks as
 * the card has room for (up to a year), hover/arrow keys show the day, and a
 * monthly table carries the same numbers for anyone not reading the colour.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { buildHeatmap, heatCellLabel, HEAT_WEEKS, type HeatCell } from '../../lib/home-heatmap'

const CELL = 11
const GAP = 3
const STEP = CELL + GAP
const LABEL_W = 30
const TOP = 18
const MIN_WEEKS = 12
const DAY_LABELS: Record<number, string> = { 1: 'Mon', 3: 'Wed', 5: 'Fri' }

export function heatWeeksFor(width: number): number {
  if (!width) return HEAT_WEEKS
  return Math.max(MIN_WEEKS, Math.min(HEAT_WEEKS, Math.floor((width - LABEL_W + GAP) / STEP)))
}

function rangeLabel(weeks: number): string {
  return weeks >= 52 ? 'Last 12 months' : `Last ${weeks} weeks`
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export interface ActivityHeatmapProps {
  counts: ReadonlyMap<string, number>
  now: number
}

export function ActivityHeatmap({ counts, now }: ActivityHeatmapProps) {
  const frame = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    setWidth(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const weeks = heatWeeksFor(width)
  const model = useMemo(() => buildHeatmap(counts, now, weeks), [counts, now, weeks])
  const [active, setActive] = useState<{ w: number; d: number } | null>(null)
  const [keyboard, setKeyboard] = useState(false)
  const helpId = useId()
  const cell: HeatCell | undefined = active ? model.weeks[active.w]?.[active.d] : undefined
  const shown = cell && !cell.future ? cell : undefined
  const svgWidth = LABEL_W + model.weeks.length * STEP - GAP
  const svgHeight = TOP + 7 * STEP - GAP

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const w = Math.floor((event.clientX - box.left - LABEL_W + GAP / 2) / STEP)
    const d = Math.floor((event.clientY - box.top - TOP + GAP / 2) / STEP)
    const next = model.weeks[w]?.[d]
    setKeyboard(false)
    setActive(next && !next.future ? { w, d } : null)
  }
  const lastPast = () => {
    const w = model.weeks.length - 1
    return { w, d: model.weeks[w].findLastIndex((c) => !c.future) }
  }
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const move = moves[event.key]
    if (!move && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    setKeyboard(true)
    if (event.key === 'Home') return setActive({ w: 0, d: 0 })
    if (event.key === 'End') return setActive(lastPast())
    const from = active ?? lastPast()
    const w = Math.max(0, Math.min(model.weeks.length - 1, from.w + move[0]))
    const d = Math.max(0, Math.min(6, from.d + move[1]))
    if (!model.weeks[w][d].future) setActive({ w, d })
  }

  const tipX = active ? LABEL_W + active.w * STEP + CELL / 2 : 0
  const tipY = active ? TOP + active.d * STEP : 0
  const tipSide = tipX > svgWidth - 90 ? 'end' : tipX < 90 ? 'start' : 'center'

  return <section className="hd-heat" aria-labelledby={`${helpId}-title`}>
    <header className="hd-heat-header">
      <h2 id={`${helpId}-title`} className="hd-home-heading">Activity</h2>
      <span className="hd-heat-range">{rangeLabel(model.weeks.length)}</span>
    </header>
    <dl className="hd-heat-stats">
      <div className="hd-heat-stat"><dt>Active days</dt><dd>{model.activeDays}</dd>
        <dd className="hd-heat-sub">of {model.weeks.flat().filter((c) => !c.future).length} days</dd></div>
      <div className="hd-heat-stat"><dt>Current streak</dt>
        <dd>{model.currentStreak}<span>{model.currentStreak === 1 ? ' day' : ' days'}</span></dd>
        <dd className="hd-heat-sub">Longest {model.longestStreak} {model.longestStreak === 1 ? 'day' : 'days'}</dd>
      </div>
      <div className="hd-heat-stat"><dt>Busiest day</dt>
        <dd>{model.busiest ? <>{model.busiest.count}<span>{model.busiest.count === 1 ? ' chat' : ' chats'}</span></> : '—'}</dd>
        {model.busiest && <dd className="hd-heat-sub">{shortDate(model.busiest.date)}</dd>}
      </div>
    </dl>
    <div className="hd-heat-frame" ref={frame}>
      <svg className="hd-heat-grid" width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        role="group" aria-roledescription="activity calendar" aria-labelledby={`${helpId}-title`} aria-describedby={`${helpId}-help`}
        tabIndex={0} onPointerMove={pick} onPointerLeave={() => { if (!keyboard) setActive(null) }}
        onKeyDown={onKey} onFocus={() => { if (!active) { setKeyboard(true); setActive(lastPast()) } }}
        onBlur={() => { setActive(null); setKeyboard(false) }}>
        {model.months.map((month) => <text key={`${month.label}-${month.week}`} className="hd-heat-label"
          x={LABEL_W + month.week * STEP} y={11}>{month.label}</text>)}
        {Object.entries(DAY_LABELS).map(([d, label]) => <text key={label} className="hd-heat-label"
          x={0} y={TOP + Number(d) * STEP + CELL - 2}>{label}</text>)}
        {model.weeks.map((week, w) => week.map((day, d) => day.future ? null : <rect key={day.day}
          className="hd-heat-cell" data-level={day.level} data-day={day.day} data-count={day.count}
          x={LABEL_W + w * STEP} y={TOP + d * STEP} width={CELL} height={CELL} rx={2.5} />))}
        {shown && <rect className="hd-heat-focus" x={LABEL_W + active!.w * STEP - 1.5} y={TOP + active!.d * STEP - 1.5}
          width={CELL + 3} height={CELL + 3} rx={3.5} />}
      </svg>
      {shown && <div className="hd-heat-tip" data-side={tipSide} role="presentation"
        style={{ left: tipX, top: tipY }}>{heatCellLabel(shown)}</div>}
    </div>
    <p id={`${helpId}-help`} className="desk-sr-only">
      Chats active per day. {model.activeDays} active days. Use the arrow keys to move between days.
    </p>
    <p className="desk-sr-only" aria-live="polite">{keyboard && shown ? heatCellLabel(shown) : ''}</p>
    <footer className="hd-heat-footer">
      <details className="hd-heat-table">
        <summary>View as table</summary>
        <table>
          <thead><tr><th scope="col">Month</th><th scope="col">Active days</th><th scope="col">Chats</th></tr></thead>
          <tbody>{[...model.monthly].reverse().map((row) => <tr key={row.label}>
            <th scope="row">{row.label}</th><td>{row.activeDays}</td><td>{row.chats}</td>
          </tr>)}</tbody>
        </table>
      </details>
      <div className="hd-heat-legend" aria-hidden="true">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((level) => <i key={level} className="hd-heat-swatch" data-level={level} />)}
        <span>More</span>
      </div>
    </footer>
  </section>
}
