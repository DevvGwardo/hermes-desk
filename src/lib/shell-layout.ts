/** 'plugin' is a plugin page; it is never in the URL, so a reload returns to chat. */
export type MainDestination = 'home' | 'chats' | 'chat' | 'routines' | 'plugin'
export type WorkspacePresentation = 'closed' | 'docked' | 'main'
export const CHAT_MIN_WIDTH = 480
export const WORKSPACE_MIN_WIDTH = 360
export const INSPECTOR_MIN_WIDTH = 320
export const WORKSPACE_OPEN_KEY = 'hermes-desk:workspace-open'

export function initialWorkspaceOpen(): boolean {
  try { return window.localStorage.getItem(WORKSPACE_OPEN_KEY) === 'true' }
  catch { return false }
}

export interface ShellGeometry {
  contentWidth: number
  navigationWidth: number
  textScale: number
}
export function panelBudget(geometry: ShellGeometry, preferredWidth: number, minimumWidth: number) {
  const available = Math.max(0, geometry.contentWidth - geometry.navigationWidth)
  const chatMinimum = CHAT_MIN_WIDTH * geometry.textScale
  const panelMinimum = minimumWidth * geometry.textScale
  const maximum = available - chatMinimum - 1
  const docked = maximum >= panelMinimum
  return {
    presentation: docked ? 'docked' as const : 'main' as const,
    width: docked ? Math.max(panelMinimum, Math.min(preferredWidth, maximum)) : available,
    maximum: docked ? maximum : available,
    chatWidth: docked ? available - Math.max(panelMinimum, Math.min(preferredWidth, maximum)) - 1 : available,
  }
}

export function destinationFor(route: { home: boolean; chats: boolean; routines: boolean }): MainDestination {
  return route.home ? 'home' : route.chats ? 'chats' : route.routines ? 'routines' : 'chat'
}
