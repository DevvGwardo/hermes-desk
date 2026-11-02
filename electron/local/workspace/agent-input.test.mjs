import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { consume, dispatch } from './agent-input.cjs'

describe('agent input provenance', () => {
  it('consumes one exact synthetic event, not duplicates, another tab, or later native input', async () => {
    const contents = new EventEmitter()
    const other = new EventEmitter()
    const params = { type: 'mousePressed', x: 12, y: 20, button: 'left' }
    const event = { type: 'mouseDown', x: 12, y: 20, button: 'left' }
    await dispatch(contents, 'Input.dispatchMouseEvent', params, async () => {
      expect(consume(other, event)).toBe(false)
      expect(consume(contents, { ...event, x: 40 })).toBe(false)
      expect(consume(contents, event)).toBe(true)
      expect(consume(contents, event)).toBe(false)
    })
    expect(consume(contents, event)).toBe(false)
  })

  it('preserves real key modifiers and clears pending provenance after failed dispatch', async () => {
    const contents = new EventEmitter()
    const params = { type: 'keyDown', key: 'a', modifiers: 2 }
    await expect(dispatch(contents, 'Input.dispatchKeyEvent', params, async () => {
      expect(consume(contents, { type: 'keyDown', key: 'a', control: false })).toBe(false)
      expect(consume(contents, { type: 'keyDown', key: 'a', control: true })).toBe(true)
      throw new Error('Fixture dispatch failed')
    })).rejects.toThrow('Fixture dispatch failed')
    expect(consume(contents, { type: 'keyDown', key: 'a', control: true })).toBe(false)
  })
})
