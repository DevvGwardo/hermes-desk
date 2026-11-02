import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SessionFooter } from './SessionFooter'

afterEach(cleanup)
it('renders session-scoped todo progress and token/cost totals', () => {
  const { rerender } = render(<SessionFooter todos={[{ content: 'Read fixture', status: 'completed' }, { title: 'Write answer', status: 'pending' }, null]}
    usage={{ input_tokens: 1200, output_tokens: 200, cost_usd: 0.01 }} />)
  expect(screen.getByText('1/2 tasks')).toBeTruthy()
  expect(screen.getByLabelText('Session usage').textContent).toBe('1,400 tokens · $0.0100')
  rerender(<SessionFooter usage={{ total_tokens: NaN, cost_usd: -1 }} />)
  expect(screen.queryByLabelText('Session usage')).toBeNull()
  expect(screen.queryByText('Read fixture')).toBeNull()
})
