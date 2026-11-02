import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderCapture } from '../render-capture'

afterEach(() => { renderCapture.clear(); vi.useRealTimers() })

describe('bounded memory-only render capture', () => {
  it('is off until explicitly started and returns independently owned snapshots', () => {
    expect(renderCapture.record('commit', { rows: 4 })).toBe(false)
    expect(renderCapture.read().entries).toEqual([])
    renderCapture.start()
    renderCapture.record('commit', { rows: 4, sending: true })
    const snapshot = renderCapture.read()
    snapshot.entries[0].data.rows = 999
    snapshot.entries.length = 0
    expect(renderCapture.read().entries[0].data.rows).toBe(4)
  })

  it('allowlists fields and values instead of attempting to redact arbitrary strings', () => {
    renderCapture.start()
    renderCapture.record('scroll', {
      epoch: 1, rows: 50, scrollTop: 41.5, scrollHeight: 1e20, clientHeight: Infinity,
      active: true, pinned: 'FAKE sentinel secret', skin: 'messenger',
      prompt: 'FAKE sentinel secret', path: '/fake/private', threadKey: 'FAKE session id',
      error: new Error('FAKE sentinel secret'), components: ['FAKE dynamic component'],
    })
    expect(renderCapture.read().entries[0].data).toEqual({
      epoch: 1, rows: 50, scrollTop: 42, scrollHeight: 10_000_000, active: true, skin: 'messenger',
    })
    expect(renderCapture.record('FAKE event' as 'scroll', { rows: 99 })).toBe(false)
    renderCapture.record('commit', { skin: 'FAKE skin', rows: NaN, sending: 1 })
    expect(renderCapture.read().entries[1].data).toEqual({})
    expect(JSON.stringify(renderCapture.read())).not.toMatch(/sentinel|private|session id|dynamic|FAKE/)
  })

  it('keeps only the newest 128 events with monotonic sequence numbers', () => {
    renderCapture.start()
    for (let i = 0; i < 1000; i++) renderCapture.record('commit', { rows: i })
    const { entries } = renderCapture.read()
    expect(entries).toHaveLength(128)
    expect(entries[0].seq).toBe(873)
    expect(entries.at(-1)?.seq).toBe(1000)
  })

  it('does not notify React subscribers while recording renders or scrolls', () => {
    const listener = vi.fn()
    const unsubscribe = renderCapture.subscribe(listener)
    renderCapture.start()
    listener.mockClear()
    renderCapture.record('commit', { rows: 4 })
    renderCapture.record('scroll', { scrollTop: 90 })
    expect(listener).not.toHaveBeenCalled()
    renderCapture.stop()
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('freezes the first failure and retains only fixed classifications and component names', () => {
    renderCapture.start()
    renderCapture.record('scroll', { rows: 50 })
    renderCapture.fail(new Error('Maximum update depth exceeded FAKE sentinel secret'),
      '\n    at ChatPanel (http://fake/private?token=FAKE)\n    at FAKEPrivateComponent (/fake/private)\n    at App (/fake/private)')
    renderCapture.fail(new Error('Another FAKE failure'), '\n at MessageBody (/fake/private)')
    expect(renderCapture.record('scroll', { rows: 90 })).toBe(false)
    const snapshot = renderCapture.read()
    expect(snapshot.phase).toBe('failed')
    expect(snapshot.entries).toHaveLength(2)
    expect(snapshot.entries[1]).toMatchObject({
      event: 'failure', failure: 'maximum-depth', components: ['ChatPanel', 'App'],
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/sentinel|fake|private|Another|MessageBody/i)
    snapshot.entries[1].components?.push('FAKE mutation')
    expect(renderCapture.read().entries[1].components).toEqual(['ChatPanel', 'App'])
  })

  it('automatically stops after five minutes and deletes the frozen receipt five minutes later', () => {
    vi.useFakeTimers()
    renderCapture.start()
    renderCapture.record('commit', { rows: 4 })
    vi.advanceTimersByTime(5 * 60_000)
    expect(renderCapture.getPhase()).toBe('stopped')
    expect(renderCapture.record('commit')).toBe(false)
    expect(renderCapture.read().entries).toHaveLength(1)
    vi.advanceTimersByTime(5 * 60_000)
    expect(renderCapture.getPhase()).toBe('expired')
    expect(renderCapture.read().entries).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires stopped and failed receipts and starting fresh cancels the old expiry', () => {
    vi.useFakeTimers()
    renderCapture.start()
    renderCapture.fail('Minified React error #185; FAKE secret')
    vi.advanceTimersByTime(4 * 60_000)
    renderCapture.start()
    renderCapture.record('thread', { epoch: 1 })
    vi.advanceTimersByTime(60_000)
    expect(renderCapture.getPhase()).toBe('recording')
    expect(renderCapture.read().entries).toHaveLength(1)
    renderCapture.stop()
    vi.advanceTimersByTime(5 * 60_000)
    expect(renderCapture.read().entries).toEqual([])
  })

  it('removes global error listeners on stop, failure and clear without suppressing browser errors', () => {
    renderCapture.start()
    const error = new ErrorEvent('error', { message: 'FAKE secret', cancelable: true })
    expect(window.dispatchEvent(error)).toBe(true)
    expect(renderCapture.getPhase()).toBe('failed')
    expect(renderCapture.read().entries[0].failure).toBe('renderer-error')
    renderCapture.clear()
    window.dispatchEvent(new Event('unhandledrejection'))
    expect(renderCapture.read().entries).toEqual([])
    renderCapture.start()
    window.dispatchEvent(new Event('unhandledrejection'))
    expect(renderCapture.read().entries[0].failure).toBe('unhandled-rejection')
    renderCapture.clear()
    renderCapture.start()
    renderCapture.stop()
    window.dispatchEvent(new ErrorEvent('error', { message: 'FAKE secret' }))
    expect(renderCapture.getPhase()).toBe('stopped')
    expect(renderCapture.read().entries).toEqual([])
  })
})
