import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createMascot } from '../lib/mascot/engine'
import { mascotFrameClock } from '../lib/mascot/frame-clock'
import { existingStage } from '../lib/mascot/fx/stage'
import { agentPalettes } from '../lib/mascot/registry'
import { PARTICLE_TYPES } from '../lib/mascot/types'
import type { Character, FlightPath, MascotHandle, MascotLocation, ParticleType } from '../lib/mascot/types'

const PATHS: FlightPath[] = ['arc', 'swoop', 'direct', 'loop']
const PERCHES = [
  { id: 'inbox', label: 'Inbox card', note: 'data-mascot-perch · re-parents', perch: true },
  { id: 'approval', label: 'Approval', note: 'data-mascot-perch · edge right', perch: true, edge: 'right' as const },
  { id: 'note', label: 'Sticky note', note: 'tracked perch (no attribute)', perch: false },
  { id: 'shelf', label: 'Shelf', note: 'data-mascot-perch · edge left', perch: true, edge: 'left' as const },
]

export interface StageLabApi {
  play(name: string): Promise<string>
  flyTo(index: number, options?: { path?: FlightPath; speed?: number; returnHome?: boolean }): Promise<string>
  flyToPoint(x: number, y: number, path?: FlightPath): Promise<string>
  goHome(): Promise<string>
  emit(type: ParticleType, count?: number): void
  location(): MascotLocation
  particles(): number
}
declare global { interface Window { mascotStage?: StageLabApi } }

function Small({ character, index, autonomy }: { character: Character; index: number; autonomy: boolean }) {
  const host = useRef<HTMLSpanElement>(null)
  const handle = useRef<MascotHandle | null>(null)
  const palettes = agentPalettes(character)
  useLayoutEffect(() => {
    const value = createMascot(host.current!, {
      svg: character.svg, motion: character.motion, clips: character.clips, size: 40,
      palette: palettes[index % palettes.length]?.palette ?? character.palette.default,
      seed: `stage-small:${index}`, autonomy: true, interactive: true,
    })
    handle.current = value
    return () => value.destroy()
  }, [character, index, palettes])
  useLayoutEffect(() => { handle.current?.setAutonomy(autonomy) }, [autonomy])
  return <span ref={host} className="mascot-preview" style={{ width: 40, height: 40 }} />
}

export function StageLab({ character, reduced }: { character: Character; reduced: boolean }) {
  const host = useRef<HTMLSpanElement>(null)
  const api = useRef<MascotHandle | null>(null)
  const perchRefs = useRef<Array<HTMLDivElement | null>>([])
  const [path, setPath] = useState<FlightPath>('arc')
  const [speed, setSpeed] = useState(560)
  const [peak, setPeak] = useState(0)
  const [returnHome, setReturnHome] = useState(false)
  const [autonomy, setAutonomy] = useState(true)
  const [count, setCount] = useState(0)
  const [location, setLocation] = useState<MascotLocation>('home')
  const [last, setLast] = useState('')
  const [stats, setStats] = useState(mascotFrameClock.stats())
  const [particles, setParticles] = useState(0)
  useLayoutEffect(() => {
    const value = createMascot(host.current!, {
      svg: character.svg, motion: character.motion, clips: character.clips, size: 128,
      palette: character.palette.default, seed: 'stage-hero', interactive: true, autonomy: true, stageKey: 'hero',
      reducedMotion: reduced,
    })
    api.current = value
    return () => { value.destroy(); api.current = null }
  }, [character, reduced])
  useLayoutEffect(() => { api.current?.setAutonomy(autonomy) }, [autonomy])
  useEffect(() => {
    const timer = window.setInterval(() => {
      setStats(mascotFrameClock.stats())
      setParticles(existingStage(document)?.particles ?? 0)
      setLocation(api.current?.location() ?? 'home')
    }, 250)
    return () => window.clearInterval(timer)
  }, [])
  const report = (label: string) => (result: string) => { setLast(`${label}: ${result}`); return result }
  function flyTo(index: number, overrides: { path?: FlightPath; speed?: number; returnHome?: boolean } = {}) {
    const target = perchRefs.current[index]
    const perch = PERCHES[index]
    if (!target || !api.current) return Promise.resolve('missing')
    mascotFrameClock.resetStats()
    return api.current.flyTo(target, {
      path: overrides.path ?? path, speed: overrides.speed ?? speed, size: peak || undefined,
      returnHome: overrides.returnHome ?? returnHome, perch: true, edge: perch.edge,
    }).then(report(`fly → ${perch.label}`))
  }
  function flyToPoint(x: number, y: number, p = path) {
    mascotFrameClock.resetStats()
    return api.current?.flyTo({ x, y }, { path: p, speed, size: peak || undefined, returnHome }).then(report('fly → point')) ?? Promise.resolve('missing')
  }
  function emit(type: ParticleType, n = count) { api.current?.emit(type, n ? { count: n } : {}) }
  useEffect(() => {
    window.mascotStage = {
      play: name => api.current?.play(name).then(report(`clip ${name}`)) ?? Promise.resolve('missing'),
      flyTo, flyToPoint,
      goHome: () => api.current?.goHome({ speed }).then(report('home')) ?? Promise.resolve('missing'),
      emit, location: () => api.current?.location() ?? 'home',
      particles: () => existingStage(document)?.particles ?? 0,
    }
  })
  const clips = Object.keys(character.clips).sort()
  return <section className="stage-lab" aria-label="Stage mode">
    <div className="controls stage-controls">
      <div className="stage-row"><span className="stage-label">Clips</span>
        {clips.map(name => <button key={name} data-clip={name} onClick={() => void api.current?.play(name).then(report(`clip ${name}`))}>{name}</button>)}
      </div>
      <div className="stage-row"><span className="stage-label">Flight</span>
        <label>Path <select value={path} onChange={e => setPath(e.target.value as FlightPath)}>{PATHS.map(p => <option key={p}>{p}</option>)}</select></label>
        <label>Speed <input type="range" min={180} max={1400} step={20} value={speed} onChange={e => setSpeed(Number(e.target.value))} /> <b>{speed}px/s</b></label>
        <label>Peak size <input type="range" min={0} max={260} step={10} value={peak} onChange={e => setPeak(Number(e.target.value))} /> <b>{peak || 'off'}</b></label>
        <label><input type="checkbox" checked={returnHome} onChange={e => setReturnHome(e.target.checked)} /> Return home</label>
        <label><input type="checkbox" checked={autonomy} onChange={e => setAutonomy(e.target.checked)} /> Autonomous idle</label>
        <button onClick={() => void flyToPoint(window.innerWidth * (0.3 + Math.random() * 0.5), window.innerHeight * (0.25 + Math.random() * 0.5))}>Random point</button>
        <button onClick={() => void api.current?.goHome({ speed }).then(report('home'))}>Go home</button>
      </div>
      <div className="stage-row"><span className="stage-label">Particles</span>
        {PARTICLE_TYPES.map(type => <button key={type} data-particle={type} onClick={() => emit(type)}>{type}</button>)}
        <label>Count <input type="range" min={0} max={60} value={count} onChange={e => setCount(Number(e.target.value))} /> <b>{count || 'preset'}</b></label>
      </div>
      <div className="readout stage-readout" aria-live="off">
        <span><b>{location}</b> location</span>
        <span><b>{particles}</b> particles</span>
        <span><b>{stats.fps.toFixed(0)}</b> fps</span>
        <span><b>{stats.meanMs.toFixed(3)}</b> ms mean</span>
        <span><b>{stats.p95Ms.toFixed(3)}</b> ms p95</span>
        <span><b>{stats.maxMs.toFixed(3)}</b> ms max</span>
        <span className="stage-last">{last || '—'}</span>
      </div>
    </div>
    <div className="stage-floor">
      <div className="stage-home">
        <span ref={host} className="mascot-preview" style={{ width: 128, height: 128 }} data-stage-home />
        <span>Home slot</span>
      </div>
      {PERCHES.map((perch, i) => <div key={perch.id} ref={el => { perchRefs.current[i] = el }}
        className={`stage-perch stage-perch-${perch.id}`} data-mascot-perch={perch.perch ? '' : undefined} data-perch={perch.id}>
        <strong>{perch.label}</strong>
        <span>{perch.note}</span>
        <button onClick={() => void flyTo(i)}>Fly here</button>
      </div>)}
      <div className="stage-flock" aria-label="Perf fixture: twelve 40px autonomous mascots">
        {Array.from({ length: 12 }, (_, i) => <Small key={i} character={character} index={i} autonomy={autonomy} />)}
      </div>
    </div>
  </section>
}
