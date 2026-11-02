import { getWorkspaceBridge } from '../desktop-bridge'
import type { WorkspaceBridge } from '../desktop-bridge'

export interface ReaderPreview {
  url: string
  title: string
  snapshot: string
}

export interface WorkspaceShortcut {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

// CONTRACT: additive preload APIs, optional during mixed-version development.
export type WorkspaceFeatures = WorkspaceBridge & {
  readerPreview?(tabId: string): Promise<ReaderPreview>
  clearLaneData?(laneId: string): Promise<void>
  onShortcut?(callback: (shortcut: WorkspaceShortcut) => void): () => void
}

export function getWorkspaceFeatures(): WorkspaceFeatures | undefined {
  return getWorkspaceBridge() as WorkspaceFeatures | undefined
}

export function forwardWorkspaceShortcut(shortcut: WorkspaceShortcut): void {
  if (!shortcut || !(shortcut.metaKey || shortcut.ctrlKey) ||
      !(shortcut.key === 't' || (!shortcut.shiftKey && (shortcut.key === 'l' || /^[1-9]$/.test(shortcut.key))))) return
  window.dispatchEvent(new KeyboardEvent('keydown', { ...shortcut, cancelable: true }))
}
