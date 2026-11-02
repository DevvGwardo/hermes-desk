import { afterEach, expect, it } from 'vitest'
import { CHAT_MIN_WIDTH, initialWorkspaceOpen, panelBudget, WORKSPACE_MIN_WIDTH, WORKSPACE_OPEN_KEY } from '../shell-layout'

afterEach(() => window.localStorage.clear())

it('keeps new workspaces closed and preserves explicitly saved open preferences', () => {
  expect(initialWorkspaceOpen()).toBe(false)
  window.localStorage.setItem(WORKSPACE_OPEN_KEY, 'true')
  expect(initialWorkspaceOpen()).toBe(true)
})
it('protects chat space across supported windows and actual resized navigation widths', () => {
  for (const contentWidth of [1440, 1280, 1024, 960]) {
    for (const navigationWidth of [60, 208, 240, 480]) {
      for (const textScale of [1, 1.25, 2]) {
        const layout = panelBudget({ contentWidth, navigationWidth, textScale }, 620, WORKSPACE_MIN_WIDTH)
        if (layout.presentation === 'docked') {
          expect(layout.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH * textScale)
          expect(layout.width).toBeGreaterThanOrEqual(WORKSPACE_MIN_WIDTH * textScale)
          expect(layout.chatWidth + layout.width + navigationWidth + 1).toBe(contentWidth)
        } else expect(contentWidth - navigationWidth).toBeLessThan((CHAT_MIN_WIDTH + WORKSPACE_MIN_WIDTH) * textScale + 1)
      }
    }
  }
})
