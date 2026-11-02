import { beforeEach, describe, expect, it } from 'vitest'
import type { BusNotification } from '../hermes-rest'
import {
  NOTIFICATIONS_STORAGE_KEY,
  NOTIFY_MAX_POLL_DELAY_MS,
  NOTIFY_POLL_MS,
  filterNotifications,
  kindGroup,
  kindLabel,
  mergeNotifications,
  nextPollDelayMs,
  readLocalNotifications,
  writeLocalNotifications,
} from '../notifications'

function n(partial: Partial<BusNotification>): BusNotification {
  return { id: 'x', title: 't', ...partial }
}

describe('notifications local cache', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('returns [] when nothing is stored', () => {
    expect(readLocalNotifications()).toEqual([])
  })

  it('drops malformed entries but keeps valid ones', () => {
    const raw = JSON.stringify([
      n({ id: 'a', title: 'A' }),
      null,
      { title: 'no id' },
      { id: 7, title: 'bad id' },
      { id: 'b' },
      'nope',
    ])
    window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, raw)
    expect(readLocalNotifications().map((x) => x.id)).toEqual(['a'])
  })

  it('returns [] for corrupt stored payloads', () => {
    window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, '{not json')
    expect(readLocalNotifications()).toEqual([])
    window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, '{"id":"obj"}')
    expect(readLocalNotifications()).toEqual([])
  })

  it('round-trips and caps to the newest 100 by `at`', () => {
    const items = Array.from({ length: 105 }, (_, i) =>
      n({ id: `n${i}`, title: `N${i}`, at: new Date(2026, 0, 1 + i).toISOString() }),
    )
    writeLocalNotifications(items)
    const loaded = readLocalNotifications()
    expect(loaded).toHaveLength(100)
    // newest (highest index) survives; oldest five are dropped
    expect(loaded.some((x) => x.id === 'n104')).toBe(true)
    expect(loaded.some((x) => x.id === 'n4')).toBe(false)
  })

  it('mergeNotifications dedupes by id with server winning', () => {
    const merged = mergeNotifications(
      [n({ id: 'a', title: 'local A' }), n({ id: 'b', title: 'B', read: true })],
      [n({ id: 'a', title: 'server A', at: '2026-01-02T00:00:00Z' })],
    )
    expect(merged.map((x) => x.title)).toEqual(['server A', 'B'])
  })

  it('mergeNotifications preserves a local read flag when server leaves it unset', () => {
    const merged = mergeNotifications(
      [n({ id: 'a', read: true })],
      [n({ id: 'a', title: 'refreshed' })],
    )
    expect(merged[0].read).toBe(true)
  })

  it('mergeNotifications keeps an item read here even if a stale server copy says unread', () => {
    // A refresh that left before "Mark all read" reached the server answers
    // with the old unread state; it must not bring the badge back.
    const merged = mergeNotifications(
      [n({ id: 'a', read: true }), n({ id: 'b', read: false })],
      [n({ id: 'a', title: 'refreshed', read: false }), n({ id: 'b', read: true })],
    )
    expect(merged.find((x) => x.id === 'a')).toMatchObject({ title: 'refreshed', read: true })
    // Read on another device: the server's read still wins.
    expect(merged.find((x) => x.id === 'b')?.read).toBe(true)
  })

  it('mergeNotifications sorts newest first and tolerates missing `at`', () => {
    const merged = mergeNotifications(
      [n({ id: 'old', at: '2026-01-01T00:00:00Z' }), n({ id: 'no-date' })],
      [n({ id: 'new', at: '2026-03-01T00:00:00Z' })],
    )
    // missing `at` sorts last (empty-string compare)
    expect(merged.map((x) => x.id)).toEqual(['new', 'old', 'no-date'])
  })
})

describe('notifications kinds + poll schedule (#17)', () => {
  it('kindGroup exact-matches the server kind contract, rest group as other', () => {
    expect(kindGroup(n({ kind: 'pr' }))).toBe('pr')
    expect(kindGroup(n({ kind: 'ci' }))).toBe('ci')
    expect(kindGroup(n({ kind: 'issue' }))).toBe('issue')
    expect(kindGroup(n({ kind: 'push' }))).toBe('other')
    expect(kindGroup(n({ kind: 'comment' }))).toBe('other')
    expect(kindGroup(n({}))).toBe('other')
  })

  it('filterNotifications keeps All intact and narrows per filter without dropping unknowns from All', () => {
    const items = [
      n({ id: 'a', kind: 'pr' }),
      n({ id: 'b', kind: 'ci' }),
      n({ id: 'c', kind: 'issue' }),
      n({ id: 'd', kind: 'push' }),
    ]
    expect(filterNotifications(items, 'all').map((x) => x.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterNotifications(items, 'pr').map((x) => x.id)).toEqual(['a'])
    expect(filterNotifications(items, 'ci').map((x) => x.id)).toEqual(['b'])
    expect(filterNotifications(items, 'issue').map((x) => x.id)).toEqual(['c'])
  })

  it('kindLabel shortens known kinds and passes unknown kinds through trimmed', () => {
    expect(kindLabel('pr')).toBe('PR')
    expect(kindLabel('ci')).toBe('CI')
    expect(kindLabel('issue')).toBe('Issue')
    expect(kindLabel('push')).toBe('push')
    expect(kindLabel(undefined)).toBe('')
  })

  it('nextPollDelayMs polls at base when healthy, doubles per failure, caps at 10 minutes', () => {
    expect(nextPollDelayMs(0)).toBe(NOTIFY_POLL_MS)
    expect(nextPollDelayMs(-2)).toBe(NOTIFY_POLL_MS)
    expect(nextPollDelayMs(1)).toBe(2 * NOTIFY_POLL_MS)
    expect(nextPollDelayMs(2)).toBe(4 * NOTIFY_POLL_MS)
    expect(nextPollDelayMs(10)).toBe(NOTIFY_MAX_POLL_DELAY_MS)
    expect(nextPollDelayMs(99)).toBe(NOTIFY_MAX_POLL_DELAY_MS)
    expect(NOTIFY_MAX_POLL_DELAY_MS).toBe(600_000)
  })
})
