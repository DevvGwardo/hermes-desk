import { describe, expect, it } from 'vitest'
import { dateGroupOf, fileTabOf, formatWhen, friendlyName } from '../file-library'

const NOW = new Date(2026, 9, 2, 12, 0).getTime()
const DAY = 86_400_000

describe('friendlyName', () => {
  it('drops the extension and separators', () => {
    expect(friendlyName('/w/leon_profile.json')).toBe('Leon profile')
    expect(friendlyName('/w/retro-90s-site.html')).toBe('Retro 90s site')
    expect(friendlyName('/w/report-2026-09-27.md')).toBe('Report 2026-09-27')
    expect(friendlyName('/w/image (82).png')).toBe('Image (82)')
    expect(friendlyName('/w/Makefile')).toBe('Makefile')
  })

  it('calls camera and screenshot files what they are', () => {
    expect(friendlyName('/w/PXL_20260927_215733834.jpg')).toBe('Photo')
    expect(friendlyName('/w/IMG_1234.HEIC')).toBe('Photo')
    expect(friendlyName('/w/VID_20260101.mp4')).toBe('Video')
    expect(friendlyName('/w/Screenshot 2026-09-01 at 10.00.png')).toBe('Screenshot')
  })
})

describe('fileTabOf', () => {
  it('sorts files into Photos, Docs and Sites; data stays in All only', () => {
    expect(fileTabOf('/w/a.PNG')).toBe('photos')
    expect(fileTabOf('/w/a.mov')).toBe('photos')
    expect(fileTabOf('/w/a.pdf')).toBe('docs')
    expect(fileTabOf('/w/a.md')).toBe('docs')
    expect(fileTabOf('/w/a.m4a')).toBe('docs')
    expect(fileTabOf('/w/a.html')).toBe('sites')
    expect(fileTabOf('/w/a.json')).toBeNull()
    expect(fileTabOf('/w/a.py')).toBeNull()
  })
})

describe('dates', () => {
  it('groups like a phone', () => {
    expect(dateGroupOf(NOW - 60_000, NOW)).toBe('Today')
    expect(dateGroupOf(NOW - DAY, NOW)).toBe('Yesterday')
    expect(dateGroupOf(NOW - 4 * DAY, NOW)).toBe('This week')
    expect(dateGroupOf(new Date(2026, 9, 1).getTime() - DAY * 20, NOW)).toBe('Earlier')
    expect(dateGroupOf(null, NOW)).toBe('Earlier')
  })

  it('formats when', () => {
    expect(formatWhen(NOW - DAY, NOW)).toBe('Yesterday')
    expect(formatWhen(null, NOW)).toBe('')
    expect(formatWhen(new Date(2025, 0, 5).getTime(), NOW)).toMatch(/2025/)
  })
})
