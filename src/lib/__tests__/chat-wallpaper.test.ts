import { beforeEach, describe, expect, it } from 'vitest'
import {
  CHAT_WALLPAPER_KEY,
  loadChatWallpaper,
  parseChatWallpaper,
  saveChatWallpaper,
} from '../chat-wallpaper'

describe('chat wallpaper', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to sky when nothing is stored', () => {
    expect(loadChatWallpaper()).toBe('sky')
  })

  it('persists a wallpaper and reloads it', () => {
    saveChatWallpaper('blush')
    expect(loadChatWallpaper()).toBe('blush')
    saveChatWallpaper('linen')
    expect(loadChatWallpaper()).toBe('linen')
  })

  it('falls back to sky for unknown stored values', () => {
    window.localStorage.setItem(CHAT_WALLPAPER_KEY, 'navy')
    expect(loadChatWallpaper()).toBe('sky')
    expect(parseChatWallpaper('not-a-wallpaper')).toBe('sky')
    expect(parseChatWallpaper(null)).toBe('sky')
  })
})
