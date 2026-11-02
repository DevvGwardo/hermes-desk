import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAgentConfig = vi.fn()
const patchAgentConfig = vi.fn()
vi.mock('../agent-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-config')>()
  return {
    ...actual,
    getAgentConfig: (...a: unknown[]) => getAgentConfig(...a),
    patchAgentConfig: (...a: unknown[]) => patchAgentConfig(...a),
  }
})

import {
  __resetLocaleSync,
  desiredTimeZone,
  deviceTimeZone,
  getTimeZoneOverride,
  hermesLanguageFor,
  getLastPushedTimeZone,
  localePatch,
  rememberPushedTimeZone,
  setTimeZoneOverride,
  shouldPushTimeZone,
  syncAgentLocale,
  syncAgentLocaleOnce,
  timeZoneOptions,
} from '../locale-sync'

const DEVICE_TZ = 'America/Chicago'
const realDTF = Intl.DateTimeFormat

beforeEach(() => {
  getAgentConfig.mockReset()
  patchAgentConfig.mockReset()
  __resetLocaleSync()
  window.localStorage.clear()
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
    ((...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
      const f = new realDTF(...args)
      const orig = f.resolvedOptions.bind(f)
      f.resolvedOptions = () => ({ ...orig(), timeZone: DEVICE_TZ })
      return f
    }) as unknown as typeof Intl.DateTimeFormat,
  )
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hermesLanguageFor', () => {
  it('maps device tags to hermes catalogs', () => {
    expect(hermesLanguageFor('de-DE')).toBe('de')
    expect(hermesLanguageFor('pt-BR')).toBe('pt')
    expect(hermesLanguageFor('zh-TW')).toBe('zh-hant')
    expect(hermesLanguageFor('zh-Hant-HK')).toBe('zh-hant')
    expect(hermesLanguageFor('zh-CN')).toBe('zh')
    expect(hermesLanguageFor('en-US')).toBe('en')
    expect(hermesLanguageFor('nl-NL')).toBeNull()
    expect(hermesLanguageFor('')).toBeNull()
  })
})

describe('time zone override', () => {
  it('defaults to the device zone and remembers a manual pick', () => {
    expect(deviceTimeZone()).toBe(DEVICE_TZ)
    expect(getTimeZoneOverride()).toBeNull()
    expect(desiredTimeZone()).toBe(DEVICE_TZ)
    setTimeZoneOverride('Asia/Tokyo')
    expect(getTimeZoneOverride()).toBe('Asia/Tokyo')
    expect(desiredTimeZone()).toBe('Asia/Tokyo')
    setTimeZoneOverride(null)
    expect(getTimeZoneOverride()).toBeNull()
  })

  it('survives blocked storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => setTimeZoneOverride('UTC')).not.toThrow()
    expect(getTimeZoneOverride()).toBeNull()
  })

  it('lists zones including UTC and the device zone', () => {
    const zones = timeZoneOptions()
    expect(zones).toContain('UTC')
    expect(zones).toContain(DEVICE_TZ)
  })
})

describe('localePatch', () => {
  it('pushes the zone when empty or different', () => {
    expect(localePatch({ timezone: '' }, { timeZone: 'Europe/Paris', language: null })).toEqual({ timezone: 'Europe/Paris' })
    expect(localePatch({ timezone: 'UTC' }, { timeZone: 'Europe/Paris', language: null })).toEqual({ timezone: 'Europe/Paris' })
    expect(localePatch({ timezone: 'Europe/Paris' }, { timeZone: 'Europe/Paris', language: null })).toEqual({})
    expect(localePatch({}, { timeZone: '', language: null })).toEqual({})
  })

  it('only replaces the default language', () => {
    const base = { timezone: 'X' }
    expect(localePatch({ ...base, display: { language: 'en' } }, { timeZone: 'X', language: 'de' })).toEqual({
      'display.language': 'de',
    })
    expect(localePatch(base, { timeZone: 'X', language: 'de' })).toEqual({ 'display.language': 'de' })
    expect(localePatch({ ...base, display: { language: 'fr' } }, { timeZone: 'X', language: 'de' })).toEqual({})
    expect(localePatch({ ...base, display: { language: 'en' } }, { timeZone: 'X', language: 'en' })).toEqual({})
  })
})

describe('shouldPushTimeZone (several devices, one agent)', () => {
  const base = { desired: 'America/Los_Angeles', lastPushed: null, override: null }
  it('fills a default zone', () => {
    expect(shouldPushTimeZone({ ...base, current: '' })).toBe(true)
    expect(shouldPushTimeZone({ ...base, current: 'UTC' })).toBe(true)
  })
  it('keeps a zone another device or the user set', () => {
    expect(shouldPushTimeZone({ ...base, current: 'America/New_York' })).toBe(false)
    expect(shouldPushTimeZone({ ...base, current: 'America/New_York', lastPushed: 'Europe/Paris' })).toBe(false)
  })
  it('moves a zone this device pushed itself (it travelled)', () => {
    expect(shouldPushTimeZone({ ...base, current: 'America/New_York', lastPushed: 'America/New_York' })).toBe(true)
  })
  it("sends this device's pick that never reached the agent", () => {
    expect(
      shouldPushTimeZone({ current: 'America/New_York', desired: 'Asia/Tokyo', lastPushed: 'America/New_York', override: 'Asia/Tokyo' }),
    ).toBe(true)
    expect(
      shouldPushTimeZone({ current: 'Europe/Paris', desired: 'Asia/Tokyo', lastPushed: 'Asia/Tokyo', override: 'Asia/Tokyo' }),
    ).toBe(false)
  })
  it('does nothing when already there', () => {
    expect(shouldPushTimeZone({ ...base, current: 'America/Los_Angeles' })).toBe(false)
  })
})

describe('syncAgentLocale', () => {
  it("keeps a zone another device set and doesn't take it over", async () => {
    getAgentConfig.mockResolvedValue({ kind: 'ok', config: { timezone: 'America/New_York', display: { language: 'de' } } })
    expect(await syncAgentLocale()).toEqual({ kind: 'kept', timeZone: 'America/New_York' })
    expect(patchAgentConfig).not.toHaveBeenCalled()
    expect(getLastPushedTimeZone()).toBeNull()
  })

  it('follows this device when it pushed the current zone itself', async () => {
    rememberPushedTimeZone('America/New_York')
    getAgentConfig.mockResolvedValue({ kind: 'ok', config: { timezone: 'America/New_York', display: { language: 'de' } } })
    patchAgentConfig.mockResolvedValue({ ok: true, data: null })
    await syncAgentLocale()
    expect(patchAgentConfig).toHaveBeenCalledWith({ timezone: DEVICE_TZ })
    expect(getLastPushedTimeZone()).toBe(DEVICE_TZ)
  })

  it('remembers the zone when already in sync, so a later move follows', async () => {
    getAgentConfig.mockResolvedValue({ kind: 'ok', config: { timezone: DEVICE_TZ, display: { language: 'de' } } })
    await syncAgentLocale()
    expect(getLastPushedTimeZone()).toBe(DEVICE_TZ)
  })

  it('patches timezone + language through the allowlisted writer', async () => {
    getAgentConfig.mockResolvedValue({ kind: 'ok', config: { timezone: '', display: { language: 'en' } } })
    patchAgentConfig.mockResolvedValue({ ok: true, data: null })
    const res = await syncAgentLocale()
    expect(patchAgentConfig).toHaveBeenCalledWith({ timezone: DEVICE_TZ, 'display.language': 'de' })
    expect(res).toEqual({ kind: 'pushed', patch: { timezone: DEVICE_TZ, 'display.language': 'de' } })
  })

  it('uses the manual override instead of the device zone', async () => {
    setTimeZoneOverride('Asia/Tokyo')
    getAgentConfig.mockResolvedValue({ kind: 'ok', config: { timezone: DEVICE_TZ, display: { language: 'de' } } })
    patchAgentConfig.mockResolvedValue({ ok: true, data: null })
    await syncAgentLocale()
    expect(patchAgentConfig).toHaveBeenCalledWith({ timezone: 'Asia/Tokyo' })
  })

  it('does nothing when in sync', async () => {
    getAgentConfig.mockResolvedValue({ kind: 'ok', config: { timezone: DEVICE_TZ, display: { language: 'de' } } })
    expect(await syncAgentLocale()).toEqual({ kind: 'in-sync' })
    expect(patchAgentConfig).not.toHaveBeenCalled()
  })

  it('runs once per session, retrying only while unreachable', async () => {
    getAgentConfig.mockResolvedValueOnce({ kind: 'unavailable', message: 'x' })
    expect(await syncAgentLocaleOnce()).toEqual({ kind: 'unreachable' })
    getAgentConfig.mockResolvedValue({ kind: 'ok', config: { timezone: 'UTC' } })
    patchAgentConfig.mockResolvedValue({ ok: true, data: null })
    expect(await syncAgentLocaleOnce()).toMatchObject({ kind: 'pushed' })
    expect(await syncAgentLocaleOnce()).toBeNull()
    expect(getAgentConfig).toHaveBeenCalledTimes(2)
  })

  it('reports a failed write', async () => {
    getAgentConfig.mockResolvedValue({ kind: 'ok', config: { timezone: 'UTC' } })
    patchAgentConfig.mockResolvedValue({ ok: false, data: null, error: 'nope' })
    expect(await syncAgentLocale()).toEqual({ kind: 'failed', error: 'nope' })
  })
})
