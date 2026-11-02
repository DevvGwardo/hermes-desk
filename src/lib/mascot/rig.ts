import { composeTransform, fullPose } from './pose'
import type { MotionSpec, Palette } from './types'

export const PALETTE_KEYS = ['primary', 'secondary', 'accent', 'belly', 'ink', 'eye', 'shine'] as const
export function paletteVariables(palette: Palette = {}): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of PALETTE_KEYS) {
    const value = palette[key] ?? palette[`--m-${key}`]
    if (value) result[`--m-${key}`] = value
  }
  return result
}

/** Pixel padding for small rigs; leave full-size art and motion untouched. */
export function smallInsetTransform(inset: number, size: number): string {
  if (!Number.isFinite(inset) || inset < 0) throw new Error('Mascot small inset must be non-negative')
  if (size > 48 || inset === 0) return ''
  const scale = Math.max(0.5, 1 - 2 * inset / size)
  return `translate(256 256) scale(${scale}) translate(-256 -256)`
}

/** Packages are local art, not arbitrary markup. Reject active/external media. */
export function prepareRig(svg: string, prefix: string): string {
  if (!/^\s*<svg\b/i.test(svg) || !/viewBox\s*=\s*["']0\s+0\s+512\s+512["']/i.test(svg)) {
    throw new Error('Mascot rig must be an SVG with viewBox="0 0 512 512"')
  }
  if (/<\s*(?:script|foreignObject|image|iframe|animate\w*|set|style)\b/i.test(svg) ||
      /\bon\w+\s*=/i.test(svg) || /\b(?:href|xlink:href)\s*=\s*["'](?!#)/i.test(svg) ||
      /url\(\s*["']?(?!#|var\()[^)\s]+/i.test(svg)) {
    throw new Error('Mascot rig cannot contain active content or external references')
  }
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '-')
  const ids = new Map<string, string>()
  for (const match of svg.matchAll(/\bid=["']([^"']+)["']/g)) ids.set(match[1], `${safePrefix}-${match[1]}`)
  let result = svg.replace(/\bid=["']([^"']+)["']/g, (_, id: string) => {
    const part = id.startsWith('part-') ? ` data-mascot-part="${id.slice(5)}"` : ''
    const mouth = id.startsWith('mouth-') ? ` data-mascot-mouth="${id.slice(6)}"` : ''
    const pupil = /^pupil-[lr]$/.test(id) ? ` data-mascot-pupil="${id.slice(6)}"` : ''
    return `id="${ids.get(id)}"${part}${mouth}${pupil}`
  })
  result = result.replace(/url\(\s*["']?#([^)"'\s]+)["']?\s*\)/g, (_, id: string) => `url(#${ids.get(id) ?? id})`)
  result = result.replace(/((?:xlink:)?href=["'])#([^"']+)(["'])/g, (_, a: string, id: string, b: string) => `${a}#${ids.get(id) ?? id}${b}`)
  return result
}

/** DOM-free idle markup for SSR. The client replaces it before animation. */
export function staticRig(svg: string, motion: MotionSpec, prefix: string): string {
  const idle = motion.states.idle
  return prepareRig(svg, prefix).replace(/<svg\b[^>]*>/, tag =>
    tag.replace(/(?<!\s)\s+(?:width|height|style|aria-hidden)=["'][^"']*["']/g, '')
      .replace(/>/, ' width="100%" height="100%" style="display:block;overflow:visible" aria-hidden="true">'),
  ).replace(/<g\b[^>]*>/g, tag => {
    const part = tag.match(/data-mascot-part="([^"]+)"/)?.[1]
    const mouth = tag.match(/data-mascot-mouth="([^"]+)"/)?.[1]
    if (mouth) {
      const original = tag.match(/\bstyle=["']([^"']*)["']/)?.[1] ?? ''
      const style = original.replace(/(?:^|;)\s*display\s*:[^;]*/g, '')
      return tag.replace(/(?<!\s)\s+style=["'][^"']*["']/, '')
        .replace(/>/, ` style="${style};display:${mouth === (idle.mouth ?? 'neutral') ? 'inline' : 'none'}">`)
    }
    if (!part) return tag
    const pivot = (tag.match(/data-pivot=["']([^"']+)["']/)?.[1] ?? '0 0').split(/[\s,]+/).map(Number)
    const pose = fullPose(idle.pose?.[part] ?? idle.pose?.[`part-${part}`])
    if (part.startsWith('lid-')) pose.sy = 0
    const authored = tag.match(/\btransform=["']([^"']*)["']/)?.[1] ?? ''
    return tag.replace(/(?<!\s)\s+transform=["'][^"']*["']/, '').replace(/>/, ` transform="${composeTransform(pose, pivot)} ${authored}">`)
  })
}
