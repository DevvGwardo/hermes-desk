/**
 * Account-scoped permission for copying files between this computer and the
 * agent VM (Grok CopyToBox / CopyFromBox analogue).
 *
 * always — do not ask again
 * ask    — prompt Once / Always / Never (default)
 * never  — refuse copies
 */

export type CopyPermission = 'always' | 'ask' | 'never'

const KEY = 'nub.copyPermission'
const VALUES: CopyPermission[] = ['always', 'ask', 'never']

export function isCopyPermission(value: unknown): value is CopyPermission {
  return typeof value === 'string' && VALUES.includes(value as CopyPermission)
}

export function getCopyPermission(): CopyPermission {
  if (typeof window === 'undefined') return 'ask'
  try {
    const raw = window.localStorage.getItem(KEY)
    return isCopyPermission(raw) ? raw : 'ask'
  } catch {
    return 'ask'
  }
}

export function setCopyPermission(value: CopyPermission): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(KEY, value)
}

/** Once = proceed without changing the stored default. */
export type CopyPermissionChoice = CopyPermission | 'once'

export function applyCopyPermissionChoice(choice: CopyPermissionChoice): boolean {
  if (choice === 'never') {
    setCopyPermission('never')
    return false
  }
  if (choice === 'always') setCopyPermission('always')
  return true
}
