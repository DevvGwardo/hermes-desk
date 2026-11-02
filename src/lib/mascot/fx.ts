import { num } from './pose'
import type { FxSpec } from './types'

const NS = 'http://www.w3.org/2000/svg'
interface Particle { el: SVGElement; spec: FxSpec; index: number; count: number }

/** Fixed-size SVG effect pool. No timers, layout reads, or per-frame nodes. */
export class FxLayer {
  private layer: SVGGElement
  private particles: Particle[] = []
  constructor(svg: SVGElement) {
    this.layer = svg.ownerDocument.createElementNS(NS, 'g')
    this.layer.setAttribute('data-mascot-fx', '')
    this.layer.setAttribute('pointer-events', 'none')
    this.layer.setAttribute('aria-hidden', 'true')
    svg.append(this.layer)
  }
  set(specs: FxSpec[]) {
    this.layer.replaceChildren()
    this.particles = []
    for (const spec of specs) {
      const count = Math.max(1, Math.min(12, Math.floor(spec.count ?? (spec.type === 'dots' ? 3 : 2))))
      for (let index = 0; index < count; index++) {
        const el = this.layer.ownerDocument.createElementNS(NS,
          spec.type === 'zzz' ? 'text' : spec.type === 'dots' || spec.type === 'ring' ? 'circle' : 'path')
        el.setAttribute('fill', spec.color ?? 'var(--m-accent, #ffda85)')
        const size = spec.size ?? 7
        if (spec.type === 'zzz') {
          el.textContent = 'z'
          el.setAttribute('font-family', 'system-ui, sans-serif')
          el.setAttribute('font-size', String(size * 3))
          el.setAttribute('font-weight', '700')
        } else if (spec.type === 'dots') el.setAttribute('r', String(size))
        else if (spec.type === 'ring') {
          el.setAttribute('r', String(size * 2))
          el.setAttribute('fill', 'none')
          el.setAttribute('stroke', spec.color ?? 'var(--m-accent, #ffda85)')
          el.setAttribute('stroke-width', '3')
        } else if (spec.type === 'sweat') {
          el.setAttribute('d', `M0 ${-size * 2} Q${size * 2} ${size} 0 ${size} Q${-size * 2} ${size} 0 ${-size * 2}Z`)
          el.setAttribute('fill', spec.color ?? 'var(--m-shine, #e9f8ff)')
        } else {
          el.setAttribute('d', `M0 ${-size * 2} L${size / 2} ${-size / 2} L${size * 2} 0 L${size / 2} ${size / 2} L0 ${size * 2} L${-size / 2} ${size / 2} L${-size * 2} 0 L${-size / 2} ${-size / 2}Z`)
        }
        this.layer.append(el)
        this.particles.push({ el, spec, index, count })
      }
    }
  }
  draw(time: number, anchor: (part: string) => [number, number]) {
    for (const { el, spec, index, count } of this.particles) {
      const [ax, ay] = anchor(spec.anchor ?? 'part-head')
      const t = (time / Math.max(0.2, spec.duration ?? 1.8) + index / count) % 1
      let x = ax + (spec.x ?? 0)
      let y = ay + (spec.y ?? -90)
      let scale = 1
      let opacity = 1
      if (spec.type === 'dots') { x += (index - (count - 1) / 2) * 25; y -= Math.sin(t * Math.PI * 2) * 5 }
      else if (spec.type === 'ring') { scale = 0.5 + t * 3; opacity = 1 - t }
      else if (spec.type === 'sweat') { x += 65; y += t * 35; opacity = Math.sin(t * Math.PI) }
      else {
        x += (index % 2 ? -1 : 1) * (55 + index * 10)
        y -= t * 35
        scale = 0.6 + Math.sin(t * Math.PI) * 0.5
        opacity = Math.sin(t * Math.PI)
      }
      el.setAttribute('transform', `translate(${num(x)} ${num(y)}) scale(${num(scale)})`)
      el.setAttribute('opacity', num(opacity))
    }
  }
  destroy() { this.layer.remove(); this.particles = [] }
}
