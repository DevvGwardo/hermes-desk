import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createMascot } from '../lib/mascot/engine'
import { ManualFrameClock, mascotFrameClock } from '../lib/mascot/frame-clock'
import { agentPalettes, characters } from '../lib/mascot/registry'
import { MASCOT_STATES } from '../lib/mascot/types'
import type { Character, FrameClock, MascotHandle, Palette } from '../lib/mascot/types'
import { StageLab } from './stage'
import './styles.css'

const params = new URLSearchParams(location.search)
const capture = params.get('capture') === '1'
const perf = params.get('perf') === '1'
const initialMode = params.get('mode') === 'stage' ? 'stage' : 'gallery'
const manual = new ManualFrameClock()
const clock = capture ? manual : mascotFrameClock
const available = Object.values(characters)
const entries = params.get('character') ? available.filter(c => c.id === params.get('character')) : available

interface LabApi {
  ready: boolean
  characterIds: string[]
  setState(state: string): void
  setPalette(index: number): void
  setReducedMotion(on: boolean): void
  react(name: string): void
  advance(ms: number): void
  stats: typeof mascotFrameClock.stats
  resetStats(): void
}
declare global { interface Window { mascotLab: LabApi } }

function Preview({ character, size, state, palette, reduced, interactive, register, frameClock = clock, index = 0, autonomy = false }: {
  character: Character; size: number; state: string; palette: Palette; reduced: boolean; interactive: boolean
  register: (handle: MascotHandle) => () => void; frameClock?: FrameClock; index?: number; autonomy?: boolean
}) {
  const host = useRef<HTMLSpanElement>(null)
  const engine = useRef<MascotHandle | null>(null)
  const latest = useRef({ state, palette, reduced, size })
  latest.current = { state, palette, reduced, size }
  useLayoutEffect(() => {
    const value = createMascot(host.current!, {
      svg: character.svg, motion: character.motion, ...latest.current, reducedMotion: latest.current.reduced,
      interactive, clock: frameClock, seed: `lab:${character.id}:${index}`, clips: character.clips,
    })
    engine.current = value
    const remove = register(value)
    return () => { remove(); value.destroy() }
  }, [character, interactive, register, frameClock, index])
  useLayoutEffect(() => { engine.current?.setState(state) }, [state])
  useLayoutEffect(() => { engine.current?.setPalette(palette) }, [palette])
  useLayoutEffect(() => { engine.current?.setReducedMotion(reduced) }, [reduced])
  useLayoutEffect(() => { engine.current?.setAutonomy(autonomy) }, [autonomy])
  return <span ref={host} className="mascot-preview" style={{ width: size, height: size }} data-size={size} />
}

function App() {
  const [state, setState] = useState(params.get('state') ?? 'idle')
  const [paletteIndex, setPalette] = useState(-1)
  const [reduced, setReduced] = useState(params.get('reduced') === '1')
  const [interactive, setInteractive] = useState(true)
  const [mode, setMode] = useState<'gallery' | 'stage'>(initialMode)
  const [autonomy, setAutonomy] = useState(false)
  const [stats, setStats] = useState(mascotFrameClock.stats())
  const handles = useRef(new Set<MascotHandle>())
  const register = useMemo(() => (handle: MascotHandle) => {
    handles.current.add(handle)
    return () => { handles.current.delete(handle) }
  }, [])
  const reactions = [...new Set(entries.flatMap(c => Object.keys(c.motion.reactions ?? {})))]
  function react(name: string) { for (const handle of handles.current) handle.react(name) }
  function play(name: string) { for (const handle of handles.current) void handle.play(name) }
  const clipNames = [...new Set(entries.flatMap(c => Object.keys(c.clips)))].sort()
  const stageCharacter = entries.find(c => Object.keys(c.clips).length) ?? entries[0]
  useEffect(() => {
    window.mascotLab = {
      ready: true, characterIds: available.map(c => c.id), setState, setPalette, setReducedMotion: setReduced,
      react, advance: ms => manual.advance(ms), stats: () => mascotFrameClock.stats(),
      resetStats: () => mascotFrameClock.resetStats(),
    }
    const timer = window.setInterval(() => setStats(mascotFrameClock.stats()), 1000)
    return () => { window.clearInterval(timer); window.mascotLab.ready = false }
  }, [])
  return <main>
    <header>
      <div className="eyebrow">HERMES DESK / CHARACTER SYSTEM</div>
      <h1>Mascot lab<span className="badge">{perf ? 'PERFORMANCE' : capture ? 'DETERMINISTIC' : 'LIVE'}</span></h1>
      <p>One engine. Every character. Springy gestures, quiet little details.</p>
      <div className="mode-tabs" role="tablist">
        {(['gallery', 'stage'] as const).map(m => <button key={m} role="tab" aria-selected={mode === m} aria-pressed={mode === m}
          onClick={() => setMode(m)} data-mode={m}>{m === 'gallery' ? 'Gallery' : 'Stage'}</button>)}
      </div>
      <div className="readout" aria-live="off">
        <span><b>{capture ? 'manual' : stats.fps.toFixed(0)}</b> fps</span>
        <span><b>{stats.meanMs.toFixed(3)}</b> ms mean</span>
        <span><b>{stats.p95Ms.toFixed(3)}</b> ms p95</span>
        <span><b>{stats.subscribers}</b> active</span>
      </div>
    </header>
    {mode === 'stage' && stageCharacter ? <StageLab character={stageCharacter} reduced={reduced} /> : <>
    <section className="controls" aria-label="Animation controls">
      <div className="state-buttons">{MASCOT_STATES.map(s => <button key={s} onClick={() => setState(s)} aria-pressed={state === s} data-state={s}>{s}</button>)}</div>
      <div className="secondary-controls">
        <label>Palette <select value={paletteIndex} onChange={e => setPalette(Number(e.target.value))}>
          <option value={-1}>Character default</option>
          {Array.from({ length: 8 }, (_, i) => <option key={i} value={i}>Agent {i + 1}</option>)}
        </select></label>
        <label><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} /> Reduced motion</label>
        <label><input type="checkbox" checked={interactive} onChange={e => setInteractive(e.target.checked)} /> Cursor look-at</label>
        <label><input type="checkbox" checked={autonomy} onChange={e => setAutonomy(e.target.checked)} /> Autonomous idle</label>
        <div className="reaction-buttons">{reactions.map(name => <button key={name} onClick={() => react(name)} data-reaction={name}>↗ {name}</button>)}</div>
      </div>
      {clipNames.length > 0 && <div className="secondary-controls clip-buttons">
        {clipNames.map(name => <button key={name} onClick={() => play(name)} data-clip={name}>▶ {name}</button>)}
      </div>}
    </section>
    <section className="gallery" data-gallery>
      {(perf ? entries.slice(0, 1) : entries).map(character => {
        const palettes = agentPalettes(character)
        const palette = palettes[paletteIndex]?.palette ?? character.palette.default
        return <article className="character-card" key={character.id} data-card={character.id}>
          <div className="card-heading"><h2>{character.id === '_test' ? 'Relay' : character.id}</h2><span>{character.id === '_test' ? 'TEST RIG' : 'CONCEPT'} / {state}</span></div>
          <div className="hero-stage">
            <Preview {...{ character, state, palette, reduced, interactive, register, autonomy }} size={160} />
            <div className="sidebar-sample"><Preview {...{ character, state, palette, reduced, interactive, register, autonomy }} size={40} index={1} /><span>40px<br />sidebar</span></div>
          </div>
          <div className="palette-strip">
            {(perf ? Array.from({ length: 11 }, (_, i) => palettes[i % Math.max(1, palettes.length)]) : palettes).map((p, i) =>
              <div key={i} className="palette-item">
                <Preview {...{ character, state, reduced, interactive, register, autonomy }} palette={p?.palette ?? palette} size={40} index={i + 2} />
                <span>{perf ? i + 2 : p?.name ?? i + 1}</span>
              </div>)}
          </div>
          <footer><span>160px · full rig</span><span>40px · lite: springs, gaze, clips · 30fps</span></footer>
        </article>
      })}
    </section>
    {mode === 'gallery' && <aside className="lab-note">
      {perf ? 'Budget fixture: one 160px hero + twelve 40px mascots. Script budget: < 2ms per frame.' : 'Hover anywhere to guide cursor-aware eyes. Offscreen cards pause. OS reduced-motion is overridden by this lab toggle.'}
    </aside>}
    </>}
    {!entries.length && <p role="alert">No complete character package matches this URL.</p>}
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
