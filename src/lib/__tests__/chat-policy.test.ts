import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import {
  isHomeChatSet,
  readChatPolicy,
  saveGroupChat,
  saveStrangerPolicy,
  strangerPolicyPath,
  toIdList,
} from '../chat-policy'
import { isAgentConfigPathWritable } from '../agent-config'

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
})

describe('chat policy', () => {
  it('every path it writes is allowlisted', () => {
    for (const p of ['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'sms', 'mattermost', 'matrix', 'bluebubbles']) {
      expect(isAgentConfigPathWritable(strangerPolicyPath(p)!)).toBe(true)
    }
    expect(strangerPolicyPath('email')).toBeNull()
    for (const p of [
      'slack.require_mention',
      'slack.allowed_channels',
      'slack.free_response_channels',
      'discord.auto_thread',
      'mattermost.allowed_channels',
      'matrix.allowed_rooms',
    ]) {
      expect(isAgentConfigPathWritable(p)).toBe(true)
    }
  })

  it('reads group + stranger settings from config', async () => {
    serveGetDetailed.mockResolvedValue({
      data: {
        discord: { require_mention: false, allowed_channels: '1, 2', free_response_channels: ['3'], auto_thread: true },
        platforms: { discord: { unauthorized_dm_behavior: 'ignore' } },
      },
      status: 200,
    })
    expect(await readChatPolicy('discord')).toEqual({
      group: { requireMention: false, allowedChannels: ['1', '2'], freeResponseChannels: ['3'], autoThread: true },
      stranger: 'ignore',
    })
    expect(await readChatPolicy('telegram')).toEqual({ group: null, stranger: null })
  })

  it('writes group settings as comma lists through the config patch', async () => {
    serveSend.mockResolvedValue({ ok: true, data: {} })
    await saveGroupChat('slack', {
      requireMention: true,
      allowedChannels: ['C1', 'C2'],
      freeResponseChannels: [],
      autoThread: false,
    })
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/config', {
      config: { slack: { require_mention: true, allowed_channels: 'C1,C2', free_response_channels: '' } },
    })
    await saveStrangerPolicy('telegram', 'pair')
    expect(serveSend).toHaveBeenLastCalledWith('PUT', '/api/config', {
      config: { platforms: { telegram: { unauthorized_dm_behavior: 'pair' } } },
    })
  })

  it('toIdList handles strings and arrays', () => {
    expect(toIdList(' a ,b,')).toEqual(['a', 'b'])
    expect(toIdList([1, ' x '])).toEqual(['1', 'x'])
    expect(toIdList(null)).toEqual([])
  })

  it('checks the home chat from delivery targets', async () => {
    serveGetDetailed.mockResolvedValueOnce({
      data: { targets: [{ id: 'local', home_target_set: true }, { id: 'telegram', home_target_set: false }] },
      status: 200,
    })
    expect(await isHomeChatSet('telegram')).toBe(false)
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/cron/delivery-targets')
    serveGetDetailed.mockResolvedValueOnce({ data: { targets: [{ id: 'telegram', home_target_set: true }] }, status: 200 })
    expect(await isHomeChatSet('telegram')).toBe(true)
    serveGetDetailed.mockResolvedValueOnce({ data: null, status: 404 })
    expect(await isHomeChatSet('telegram')).toBeNull()
  })
})
