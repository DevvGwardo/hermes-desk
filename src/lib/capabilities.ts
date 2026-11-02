/** Capabilities of the local-only Electron shell. No hosted or phone shell. */
export type Shell = 'electron' | 'web'
const bridge = typeof window !== 'undefined' ? window.nubAgent : undefined
export const shell: Shell = bridge ? 'electron' : 'web'
export const caps = {
  vmPreview: false,
  vmFs: false,
  hostFs: false,
  stt: typeof bridge?.sttTranscribe === 'function',
  localTasks: typeof bridge?.hermes === 'function',
  updates: false,
  plugins: Boolean(bridge?.plugins),
  hud: typeof bridge?.hud?.toggle === 'function',
} as const
export const isWebProd = false
