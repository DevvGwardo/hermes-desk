import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { describe, expect, it } from 'vitest'
import { SystemNotice } from './SystemNotice'

describe('SystemNotice', () => {
  it('keeps raw process output collapsed until the user opens details', () => {
    const { container } = render(<SystemNotice content="Background Process Finished" details="fixture output" />)
    const disclosure = container.querySelector('details')!
    expect(disclosure.open).toBe(false)
    expect(screen.getByText('Background Process Finished', { exact: false }).tagName).toBe('SUMMARY')
    fireEvent.click(disclosure.querySelector('summary')!)
    expect(disclosure.open).toBe(true)
    expect(screen.getByText('fixture output')).toBeVisible()
    fireEvent.click(disclosure.querySelector('summary')!)
    expect(disclosure.open).toBe(false)
  })

  it('renders commands and HTML-looking output as inert text', () => {
    const output = '<script>fixture()</script><a href="https://fixture.invalid">fixture link</a>'
    const { container } = render(<SystemNotice content="Background process update" details={output} />)
    expect(container.querySelector('pre')?.textContent).toBe(output)
    expect(container.querySelector('script, a, iframe')).toBeNull()
  })

  it('keeps existing system messages simple when no output details exist', () => {
    const { container } = render(<SystemNotice content="Conversation started." />)
    expect(screen.getByText('Conversation started.')).toBeVisible()
    expect(container.querySelector('details')).toBeNull()
  })
})
