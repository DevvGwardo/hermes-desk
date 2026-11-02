export interface ShellShortcutActions {
  selectAgent(index: number): void
  openTab(lane: 'user' | 'agent'): void
  stopAll(): void
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'),
  )
}

export function handleShellShortcut(event: KeyboardEvent, actions: ShellShortcutActions): boolean {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey ||
    !(event.metaKey || event.ctrlKey)) return false
  const key = event.key.toLowerCase()
  // The emergency stop and new-tab commands work even in the composer.
  if (key === '.' || event.code === 'Period') {
    event.preventDefault()
    actions.stopAll()
    return true
  }
  if (key === 't') {
    event.preventDefault()
    actions.openTab(event.shiftKey ? 'agent' : 'user')
    return true
  }
  if (!event.shiftKey && /^[1-9]$/.test(key) && !isTextEntryTarget(event.target)) {
    event.preventDefault()
    actions.selectAgent(Number(key) - 1)
    return true
  }
  return false
}

export function installShellShortcuts(actions: ShellShortcutActions): () => void {
  const onKey = (event: KeyboardEvent) => { handleShellShortcut(event, actions) }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
