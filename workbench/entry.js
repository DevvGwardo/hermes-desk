import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { vzt, al, Aqe, tzt, dzt, uzt, Oqe, rpe } from '../src/lib/grok-orb/core.js'

/**
 * Mount the verbatim engine into a plain DOM node (no JSX needed).
 * Returns { state, shape, setState, setShape, setPaused, setGaze, api, unmount }.
 */
function mount(props, container) {
  let current = { ...props }
  const wrap = document.createElement('span')
  // CSS vars MUST live on a wrapper that contains the svg (engine reads var()).
  wrap.style.cssText = `--fg:${props.fgColor || '#b7d9ff'};--bg:${props.bgColor || '#1a3d6b'};display:inline-block;line-height:0`
  container.appendChild(wrap)
  const ref = { current: null }
  const root = createRoot(wrap)
  let renderQueued = false
  const render = () => {
    if (renderQueued) return
    renderQueued = true
    requestAnimationFrame(() => {
      renderQueued = false
      root.render(createElement(vzt, {
        state: current.state || 'idle',
        shape: current.shape || 'cat',
        size: current.size || 96,
        paused: !!current.paused,
        gazeTarget: current.gazeTarget ?? null,
        particlePalette: current.particlePalette,
        title: current.title,
        ref,
      }))
    })
  }
  render()
  return {
    get state() { return current.state },
    get shape() { return current.shape },
    setState(s) { current.state = s; render() },
    setShape(s) { current.shape = s; render() },
    setPaused(p) { current.paused = p; render() },
    /** Live gaze update — re-renders with the new target without remounting. */
    setGaze(t) { current.gazeTarget = t; render() },
    setParticles(pp) { current.particlePalette = pp; render() },
    api: ref,
    unmount() { root.unmount(); wrap.remove() },
  }
}

window.GrokEngine = { vzt, mount, al, Aqe, tzt, dzt, uzt, Oqe, rpe }
