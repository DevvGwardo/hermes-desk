/** FX and presence state names for the product mark (FatCatIcon). */

export type FxState =
  | 'dots'
  | 'orbit'
  | 'radar'
  | 'progress'
  | 'gather'
  | 'wave'
  | 'send'
  | 'receive'
  | 'dock'
  | 'ball'
  | 'whirl'
  | 'pencil'
  | 'bang'
  | 'standby'

/** Presence keys that map through PRESENCE_TO_FX (dzt). */
export type PresenceState =
  | 'thinking'
  | 'orbit'
  | 'radar'
  | 'progress'
  | 'spawning'
  | 'dictating'
  | 'sending'
  | 'receiving'
  | 'uploading'
  | 'bouncing'
  | 'loading'
  | 'powering-down'
  | 'writing'
  | 'alerting'
