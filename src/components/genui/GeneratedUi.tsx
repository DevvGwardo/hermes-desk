import { memo, useId, useState } from 'react'
import { validatedGenUiEvents, type GenUiComponent, type GenUiChecklist } from '../../lib/genui'
import { readChecklist, writeChecklist } from './checklist-state'
import './genui.css'

// Charts and tables carry numbers, not pre-formatted strings: group thousands and stop at two decimals so a
// count reads 1,234,567 instead of 1234567 and 0.30000000000000004 instead of a wall of digits.
const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
const formatNumber = (value: number) => NUMBER.format(value)

function localStorageOrUndefined(): Storage | undefined {
  try { return window.localStorage } catch { return undefined }
}

function Checklist({ spec, storageKey, revision }: { spec: GenUiChecklist; storageKey?: string; revision: string }) {
  const [checked, setChecked] = useState(() => readChecklist(storageKey ? localStorageOrUndefined() : undefined, storageKey ?? '', revision, spec))
  return (
    <>
      <ul className="genui-checklist">
        {spec.items.map(item => <li key={item.id}>
          <label>
            <input type="checkbox" checked={checked.includes(item.id)} onChange={event => {
              const next = event.currentTarget.checked ? [...checked, item.id] : checked.filter(id => id !== item.id)
              setChecked(next)
              if (storageKey) writeChecklist(localStorageOrUndefined(), storageKey, revision, next)
            }} />
            <span>{item.label}</span>
          </label>
        </li>)}
      </ul>
      <p className="genui-note">{checked.length}/{spec.items.length} done · Your local notes only · never sent to the agent</p>
    </>
  )
}

function Widget({ spec, storageKey, revision }: { spec: GenUiComponent; storageKey?: string; revision: string }) {
  const headingId = useId()
  // One peak for the whole chart: each bar is a share of the largest value, and computing it once keeps the scale
  // consistent across items.
  const peak = spec.type === 'bar_chart' ? Math.max(...spec.items.map(point => point.value)) || 1 : 1
  return (
    <section className="genui-card" aria-labelledby={headingId} data-genui-type={spec.type}>
      <h4 id={headingId} className={spec.type === 'handbook' ? 'sr-only' : undefined}>{spec.title}</h4>
      {spec.type === 'stat' && <>
        <p className="genui-stat">{spec.value}</p>
        {spec.detail && <p className="genui-detail">{spec.detail}</p>}
      </>}
      {spec.type === 'table' && <div className="genui-table-scroll" role="region" aria-label={`${spec.title} table`} tabIndex={0}>
        <table><caption className="sr-only">{spec.title}</caption>
          <thead><tr>{spec.columns.map((column, i) => <th scope="col" key={i}>{column}</th>)}</tr></thead>
          <tbody>{spec.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => typeof cell === 'number'
            ? <td key={j} className="genui-num">{formatNumber(cell)}</td>
            : <td key={j}>{cell}</td>)}</tr>)}</tbody>
        </table>
        {spec.rows.length === 0 && <p className="genui-note">No rows provided</p>}
      </div>}
      {spec.type === 'bar_chart' && <ul className="genui-bars" aria-label={`${spec.title} bar chart`}>
        {spec.items.map((item, i) => <li key={i}>
          <div className="genui-bar-label"><span>{item.label}</span><span>{formatNumber(item.value)}{spec.unit ? ` ${spec.unit}` : ''}</span></div>
          <div className="genui-bar-track" aria-hidden="true"><div className="genui-bar" style={{
            width: `${100 * item.value / peak}%`,
            // A value that rounds down to nothing still draws: an empty track reads as a broken chart, not a zero.
            minWidth: item.value > 0 ? 2 : 0,
          }} /></div>
        </li>)}
      </ul>}
      {spec.type === 'checklist' && <Checklist spec={spec} storageKey={storageKey} revision={revision} />}
      {spec.type === 'handbook' && <>
        <p className="genui-hb-head"><span>{spec.title}</span><span className="genui-hb-sub">{spec.subtitle ?? 'SYSTEMS DATA'}</span></p>
        <ol className="genui-hb-paras">
          {spec.paragraphs.map((paragraph, i) => <li key={i}>
            <span className="genui-hb-num" aria-hidden="true">{i + 1}</span><span>{paragraph}</span>
          </li>)}
        </ol>
        {spec.columns && spec.rows && <div className="genui-table-scroll genui-hb-table" role="region"
          aria-label={`${spec.title} data`} tabIndex={0}>
          <table><thead><tr>{spec.columns.map((column, i) => <th scope="col" key={i}>{column}</th>)}</tr></thead>
            <tbody>{spec.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => typeof cell === 'number'
              ? <td key={j} className="genui-num">{formatNumber(cell)}</td>
              : <td key={j}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>}
        {spec.notice && <p className="genui-hb-notice" data-level={spec.notice.level}>
          <strong>{spec.notice.level}</strong><span>{spec.notice.text}</span></p>}
      </>}
    </section>
  )
}

export const GeneratedUi = memo(function GeneratedUi({ events, scope }: { events?: unknown; scope?: string }) {
  const valid = validatedGenUiEvents(events)
  // An unowned preview/hydrated row must never share interactive state.
  if (!scope || scope.length > 700) return null
  if (!valid.length) {
    // A rejected payload vanishes without a trace. Say so in development, so a card the model thought it sent is
    // debuggable instead of looking like the tool was never called.
    if (import.meta.env.DEV && Array.isArray(events) && events.length) {
      console.warn(`[genui] ${events.length} tool event(s) produced no renderable card`)
    }
    return null
  }
  return (
    <div className="genui" data-testid="generated-ui">
      <p className="genui-source">Generated UI <span>· Agent-provided data, not verified</span></p>
      {valid.map(event => {
        const revision = JSON.stringify(event.genui)
        return <div className="genui-group" key={`${scope}:${event.toolCallId}:${event.genuiOccurrence ?? 'legacy'}:${revision}`}>
          {event.genui!.components.map((spec, index) => <Widget spec={spec} key={index} revision={revision}
            storageKey={event.genuiOccurrence ? JSON.stringify([scope, event.toolCallId, event.genuiOccurrence, index]) : undefined} />)}
        </div>
      })}
    </div>
  )
})
