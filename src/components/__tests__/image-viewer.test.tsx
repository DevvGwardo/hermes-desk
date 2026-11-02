import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ImageViewerHost } from '../ImageViewer'
import { InlineShot } from '../LocalImage'
import { closeViewer } from '../../lib/image-viewer'

const A = 'data:image/png;base64,iVBORw0KGgo='
const B = 'data:image/png;base64,iVBORw0KGgpB'

afterEach(() => {
  act(() => closeViewer())
  cleanup()
})

function renderChat() {
  render(
    <>
      <div className="overflow-y-auto">
        <InlineShot dataUrl={A} alt="First" zoom />
        <p>text between</p>
        <InlineShot dataUrl={B} alt="Second" zoom />
      </div>
      <ImageViewerHost />
    </>,
  )
  // jsdom never decodes: report both pictures loaded.
  for (const img of screen.getAllByRole('img')) fireEvent.load(img)
}

describe('image viewer', () => {
  it('opens the clicked picture and walks the others in page order', () => {
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'View Second full size' }))
    const dialog = screen.getByRole('dialog', { name: 'Second, 2 of 2' })
    expect(dialog).toBeTruthy()

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByRole('dialog', { name: 'First, 1 of 2' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }))
    expect(screen.getByRole('dialog', { name: 'Second, 2 of 2' })).toBeTruthy()
  })

  it('closes on Escape and on the backdrop, not on the picture', async () => {
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'View First full size' }))
    const shown = screen.getAllByAltText('First').at(-1)!
    fireEvent.click(shown)
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('image-viewer')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'View First full size' }))
    fireEvent.click(screen.getByTestId('image-viewer-stage'))
    await waitFor(() => expect(screen.queryByTestId('image-viewer')).toBeNull())
  })

  it('offers Save and Copy for a picture from the agent', () => {
    renderChat()
    fireEvent.click(screen.getByRole('button', { name: 'View First full size' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })
})
