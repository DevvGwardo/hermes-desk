/**
 * OS noun for copy that used to say "this Mac" everywhere.
 * Electron exposes `nubAgent.platform`; tests/browser default to Mac so
 * existing assertions stay stable.
 */
export function hostPlatform(): string {
  if (typeof window !== 'undefined') {
    const p = (window as { nubAgent?: { platform?: string } }).nubAgent?.platform
    if (typeof p === 'string' && p.trim()) return p
  }
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform
  }
  return 'darwin'
}

export function hostMachinePhrase(platform = hostPlatform()): string {
  if (platform === 'win32') return 'this PC'
  if (platform === 'linux') return 'this computer'
  return 'this Mac'
}
