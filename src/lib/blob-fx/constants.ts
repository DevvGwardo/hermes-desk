/**
 * FX state tables for the product mark (FatCatIcon) and its demo: the state
 * list, demo labels and the presence → FX map. The clean-room blob-fx frame
 * engine these once fed was removed; the mark now renders the owl engine and
 * reads a presence, so these names are compatibility vocabulary only.
 */

import type { FxState, PresenceState } from './types'

export const FX_STATES: readonly FxState[] = [
  'dots',
  'orbit',
  'radar',
  'progress',
  'gather',
  'wave',
  'send',
  'receive',
  'dock',
  'ball',
  'whirl',
  'pencil',
  'bang',
  'standby',
] as const

/** Human-readable labels for Settings demo (presence → FX). */
export const FX_STATE_LABELS: Record<FxState, string> = {
  dots: 'dots · thinking',
  orbit: 'orbit',
  radar: 'radar',
  progress: 'progress',
  gather: 'gather · spawning',
  wave: 'wave · dictating',
  send: 'send · sending',
  receive: 'receive · receiving',
  dock: 'dock · uploading',
  ball: 'ball · bouncing',
  whirl: 'whirl · loading',
  pencil: 'pencil · writing',
  bang: 'bang · alerting',
  standby: 'standby · powering-down',
}

/** Presence → FX state (dzt table from state-definitions.js). */
export const PRESENCE_TO_FX: Record<PresenceState, FxState> = {
  thinking: 'dots',
  orbit: 'orbit',
  radar: 'radar',
  progress: 'progress',
  spawning: 'gather',
  dictating: 'wave',
  sending: 'send',
  receiving: 'receive',
  uploading: 'dock',
  bouncing: 'ball',
  loading: 'whirl',
  'powering-down': 'standby',
  writing: 'pencil',
  alerting: 'bang',
}

/** Blob / viewBox center ($e). */
