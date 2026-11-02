import symbols from '../fx-art/symbols.svg?raw'

/**
 * One full-window, pointer-transparent overlay per document (motion v2 §2).
 * Above app content (popovers are 40), below modals (50).
 */
export const STAGE_Z = 45
export const STAGE_PARTICLE_CAP = 200
export interface Stage {
  doc: Document
  root: HTMLDivElement
  back: SVGSVGElement
  flights: HTMLDivElement
  front: SVGSVGElement
  /** Live particles across every emitter on this stage. */
  particles: number
  refs: number
}
const stages = new WeakMap<Document, Stage>()

function layer(doc: Document, defs: boolean): SVGSVGElement {
  const holder = doc.createElement('div')
  const inner = defs ? symbols.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '') : ''
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible">${inner}</svg>`
  return holder.firstElementChild as SVGSVGElement
}

export function acquireStage(doc: Document): Stage {
  let stage = stages.get(doc)
  if (!stage || !stage.root.isConnected) {
    const root = doc.createElement('div')
    root.id = 'mascot-stage'
    root.setAttribute('aria-hidden', 'true')
    root.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:var(--mascot-stage-z, ${STAGE_Z});overflow:hidden;contain:strict`
    const back = layer(doc, true)
    const flights = doc.createElement('div')
    flights.style.cssText = 'position:absolute;inset:0'
    const front = layer(doc, false)
    root.append(back, flights, front)
    doc.body.append(root)
    stage = { doc, root, back, flights, front, particles: 0, refs: 0 }
    stages.set(doc, stage)
  }
  stage.refs++
  return stage
}

export function releaseStage(stage: Stage) {
  stage.refs = Math.max(0, stage.refs - 1)
  if (stage.refs === 0) {
    stage.root.remove()
    stages.delete(stage.doc)
  }
}
export function existingStage(doc: Document): Stage | undefined { return stages.get(doc) }
