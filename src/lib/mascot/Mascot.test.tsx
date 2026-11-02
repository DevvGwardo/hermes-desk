import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { Mascot } from './Mascot'
import { characters, agentPalettes } from './registry'
import { ManualFrameClock } from './frame-clock'
import { staticRig } from './rig'

afterEach(cleanup)
it('registry discovers complete packages including eight test palettes', () => {
  expect(characters._test.svg).toContain('viewBox="0 0 512 512"')
  expect(agentPalettes(characters._test)).toHaveLength(8)
})
it('SSR renders an isolated idle pose with a single mouth and open eyes', () => {
  const html = renderToString(<Mascot character="_test" state="happy" title="Relay" size={40} />)
  expect(html).toContain('aria-label="Relay"')
  const template = document.createElement('div')
  template.innerHTML = html
  expect(template.querySelector('svg')!.getAttribute('width')).toBe('100%')
  expect(template.querySelector('[data-mascot-part="head"]')!.getAttribute('transform')).toContain('rotate(0)')
  expect(template.querySelector('[data-mascot-part="lid-l"]')!.getAttribute('transform')).toContain('scale(1 0)')
  const shown = [...template.querySelectorAll<SVGGElement>('[data-mascot-mouth]')].filter(el => el.style.display !== 'none')
  expect(shown.map(el => el.dataset.mascotMouth)).toEqual(['neutral'])
})
it('updates a mounted engine without replacing it and unsubscribes on unmount', () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const clock = new ManualFrameClock()
  const view = render(<Mascot character="_test" clock={clock} size={160} />)
  const svg = view.container.querySelector('svg')
  expect(clock.subscribers).toBe(1)
  view.rerender(<Mascot character="_test" clock={clock} state="thinking" size={40} palette={{ primary: '#abcdef' }} />)
  expect(view.container.querySelector('svg')).toBe(svg)
  expect(svg!.dataset.mascotState).toBe('thinking')
  expect(svg!.dataset.mascotProfile).toBe('small')
  expect(svg!.style.getPropertyValue('--m-primary')).toBe('#abcdef')
  view.unmount()
  expect(clock.subscribers).toBe(0)
})
it('SSR mouth selection replaces any authored display property', () => {
  const svg = characters._test.svg.replace('id="mouth-neutral"', 'id="mouth-neutral" style="display:none;opacity:0.8"')
  const el = document.createElement('div')
  el.innerHTML = staticRig(svg, characters._test.motion, 'authored')
  const mouth = el.querySelector<SVGGElement>('[data-mascot-mouth="neutral"]')!
  expect(mouth.style.display).toBe('inline')
  expect(mouth.style.opacity).toBe('0.8')
})
it('staticRig stays linear on whitespace-padded svg and part tags', () => {
  vi.useRealTimers()
  const pad = ' '.repeat(50_000)
  const svg = characters._test.svg
    .replace('<svg ', `<svg${pad}`)
    .replace('id="part-tail" ', `id="part-tail"${pad}`)
    .replace('id="mouth-neutral"', `id="mouth-neutral"${pad}`)
  const started = performance.now()
  const html = staticRig(svg, characters._test.motion, 'padded')
  expect(performance.now() - started).toBeLessThan(500)
  expect(html).toContain('width="100%" height="100%"')
  expect(html).toMatch(/data-mascot-part="tail"[^>]*transform="/)
})
