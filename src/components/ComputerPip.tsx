import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { getComputerBridge } from '../lib/desktop-bridge'
import type { ComputerBridge, ComputerFrame, ComputerState } from '../lib/desktop-bridge'
import '../styles/pip.css'

export type ComputerCaptureFrame = ComputerFrame
export type ComputerPreviewState = ComputerState
export type ComputerPreviewBridge = ComputerBridge

export interface ComputerPipProps {
  profile: string
  agentName?: string
  agentColor?: string
  onClose?: () => void
}

const emptyState: ComputerPreviewState = { open: false, mode: 'idle' }
const validImage = (frame: ComputerCaptureFrame) => Number.isFinite(frame.ts) && frame.ts > 0 &&
  frame.dataUrl.length <= 4 * 1024 * 1024 &&
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.dataUrl)
const safeColor = (color?: string) => /^#[0-9a-f]{6}$/i.test(color ?? '') ? color : '#8bb8e8'

export function ComputerPip({ profile, agentName, agentColor, onClose }: ComputerPipProps) {
  const bridge = getComputerBridge() as ComputerPreviewBridge | null
  const [state, setState] = useState<ComputerPreviewState>(emptyState)
  const [frame, setFrame] = useState<ComputerCaptureFrame | null>(null)
  const [now, setNow] = useState(Date.now)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const generation = useRef(0)
  const stateRef = useRef<ComputerPreviewState>(emptyState)

  useEffect(() => {
    const token = ++generation.current
    let active = true
    setState(emptyState)
    stateRef.current = emptyState
    setFrame(null)
    setError('')
    setPending(false)
    if (!bridge) return
    const offState = bridge.onState((value: ComputerPreviewState) => {
      if (!active || value.profile !== profile) return
      const previous = stateRef.current
      stateRef.current = value
      setState(value)
      if (!value.open || previous.sessionId !== value.sessionId) {
        setFrame(null)
        setDimensions({ width: 0, height: 0 })
      }
    })
    const offFrame = bridge.onFrame((value: ComputerCaptureFrame) => {
      if (!active || !stateRef.current.open) return
      if (!value.dataUrl) { setFrame(null); return }
      if ((value.profile && value.profile !== profile) ||
          (value.sessionId && value.sessionId !== stateRef.current.sessionId)) return
      if (validImage(value)) { setFrame(value); setNow(Date.now()) }
    })
    void Promise.resolve().then(() => {
      if (active && generation.current === token) return bridge.open(profile, { docked: true })
    }).catch(() => {
      if (active && generation.current === token) setError('Computer preview is unavailable.')
    })
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      active = false
      generation.current++
      offState()
      offFrame()
      window.clearInterval(timer)
      // Shell owns closing/docking. Unmounting must not close a floating PiP.
    }
  }, [bridge, profile])

  async function action(fn: () => Promise<void>) {
    if (pending) return
    const token = generation.current
    setPending(true)
    setError('')
    try { await fn() } catch {
      if (generation.current === token) setError('Action unavailable. Check the active session.')
    } finally { if (generation.current === token) setPending(false) }
  }

  const width = frame?.width || dimensions.width
  const height = frame?.height || dimensions.height
  const point = state.lastAction
  const showPoint = frame && point && width > 0 && height > 0 && Number.isFinite(point.x) &&
    Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height
  const age = frame ? Math.max(0, Math.floor((now - frame.ts) / 1000)) : null
  const color = safeColor(state.agentColor || agentColor)
  const controlled = state.mode === 'user-control'
  const canAct = !!bridge && state.open && !!state.sessionId && !controlled && !pending

  return (
    <section className="computer-pip" aria-label="Computer capture preview" style={{ '--pip-agent-color': color } as CSSProperties}>
      <header className="computer-pip-header">
        <h3><span className="computer-pip-dot" aria-hidden="true">●</span> Computer · {agentName || state.agentName || profile}</h3>
        <div className="computer-pip-controls">
          <button type="button" disabled={!canAct} onClick={() => void action(() => bridge!.takeControl())}>Take control</button>
          <button type="button" disabled={!canAct} onClick={() => void action(() => bridge!.paste())}>Paste</button>
          <button type="button" disabled={!bridge || pending} aria-label="Float computer preview" title="Float computer preview"
            onClick={() => void action(() => bridge!.open(profile, { docked: false }))}>⤢</button>
          <button type="button" aria-label="Close computer preview" disabled={pending}
            onClick={() => void action(async () => { await bridge?.close(); onClose?.() })}>×</button>
        </div>
      </header>
      <div className="computer-pip-preview">
        {frame ? (
          <div className="computer-pip-surface" style={width && height ? { aspectRatio: `${width} / ${height}` } : undefined}>
            <img src={frame.dataUrl} alt="Last completed computer-use capture"
              onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              onError={() => { setFrame(null); setError('Completed capture could not be decoded.') }} />
            {showPoint && <span className="computer-pip-point" aria-label="Agent's last action point"
              style={{ left: `${point.x / width * 100}%`, top: `${point.y / height * 100}%`,
                backgroundColor: safeColor(point.color || color) }} />}
          </div>
        ) : <p className="computer-pip-empty"><span>{bridge ? 'No completed capture yet.' : 'Computer preview requires Hermes Desk.'}</span><br /><span>This preview is not a live Mac feed.</span></p>}
      </div>
      <footer className="computer-pip-footer">
        <div className="computer-pip-age">{age === null ? 'No completed capture' : `Last capture · ${age}s ago`}</div>
        <div>{controlled ? 'You in control · use your Mac’s mouse and keyboard · preview is not live'
          : 'Watching · drag anywhere · Take control for mouse and keyboard'}</div>
        <div role="status">{error || state.detail || (state.readiness === 'unavailable' ? 'Computer-use permissions or driver unavailable.' : '')}</div>
      </footer>
    </section>
  )
}
