import { expect, it } from 'vitest'
import { finishLocalSetup, shouldShowLocalSetup } from './local-setup'

it('shows first-run guidance even when a conversation is automatically selected, until acknowledged', () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  expect(shouldShowLocalSetup(storage)).toBe(true)
  finishLocalSetup(storage)
  expect(shouldShowLocalSetup(storage)).toBe(false)
})
