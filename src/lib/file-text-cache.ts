/**
 * Text of files the agent shared. Each open reads the file again (the agent
 * may have rewritten it since), but reads of the same file that overlap
 * share one request. Lab fixtures can seed text that is never re-read.
 */
import { readText } from './files-source'

const inFlight = new Map<string, Promise<string>>()
const primed = new Map<string, string>()

export function loadFileText(path: string): Promise<string> {
  const seeded = primed.get(path)
  if (seeded !== undefined) return Promise.resolve(seeded)
  const hit = inFlight.get(path)
  if (hit) return hit
  const pending = readText(path)
  inFlight.set(path, pending)
  const done = () => {
    if (inFlight.get(path) === pending) inFlight.delete(path)
  }
  pending.then(done, done)
  return pending
}

/** Seed a file's text without reading it (dev UI Lab fixtures). */
export function primeFileText(path: string, text: string) {
  primed.set(path, text)
}

export function resetFileTextCacheForTests() {
  inFlight.clear()
  primed.clear()
}
