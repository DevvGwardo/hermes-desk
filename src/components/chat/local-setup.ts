const key = 'hermes-desk:local-setup-seen'

export function shouldShowLocalSetup(storage: Pick<Storage, 'getItem'>): boolean {
  try { return storage.getItem(key) !== '1' } catch { return true }
}

export function finishLocalSetup(storage: Pick<Storage, 'setItem'>): void {
  try { storage.setItem(key, '1') } catch { /* The guide can still dismiss for this launch. */ }
}
