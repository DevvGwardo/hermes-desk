import type { Character, ClipSpec, MotionSpec, Palette, PalettePackage } from './types'

const rigs = import.meta.glob<string>('./characters/*/rig.svg', { eager: true, query: '?raw', import: 'default' })
const motions = import.meta.glob<MotionSpec>('./characters/*/motion.json', { eager: true, import: 'default' })
const palettes = import.meta.glob<PalettePackage>('./characters/*/palette.json', { eager: true, import: 'default' })
const clipFiles = import.meta.glob<ClipSpec>('./characters/*/clips/*.json', { eager: true, import: 'default' })

export const characters: Record<string, Character> = {}
for (const path of Object.keys(rigs).sort()) {
  const id = path.split('/')[2]
  const motion = motions[`./characters/${id}/motion.json`]
  const palette = palettes[`./characters/${id}/palette.json`]
  const clips: Record<string, ClipSpec> = {}
  for (const [file, clip] of Object.entries(clipFiles)) {
    const match = /^\.\/characters\/([^/]+)\/clips\/([^/]+)\.json$/.exec(file)
    if (match?.[1] === id) clips[match[2]] = clip
  }
  if (motion && palette) characters[id] = { id, svg: rigs[path], motion, palette, clips }
}

export function agentPalettes(character: Character): Array<{ name: string; palette: Palette }> {
  const agents = character.palette.agents ?? []
  return Array.isArray(agents)
    ? agents.map((palette, i) => ({ name: `Agent ${i + 1}`, palette }))
    : Object.entries(agents).map(([name, palette]) => ({ name, palette }))
}
