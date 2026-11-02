import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { InlineShot } from '../LocalImage'
import { MAX_INLINE_IMAGE_DATA_URL_CHARS } from '../../lib/reply-media'

afterEach(cleanup)
describe('local inline image security', () => {
  const prefix = 'data:image/png;base64,'
  it('renders an in-cap raster data URL without a filesystem request', () => {
    const url = `${prefix}iVBORw0KGgo=`
    render(<InlineShot dataUrl={url} alt="Fixture image" />)
    expect(screen.getByAltText('Fixture image').getAttribute('src')).toBe(url)
  })
  it('shows a placeholder, not an image, for an over-cap data URL', () => {
    const { container } = render(<InlineShot dataUrl={prefix + 'A'.repeat(MAX_INLINE_IMAGE_DATA_URL_CHARS)} alt="Fixture image" />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('Image too large to show')).toBeTruthy()
  })
  it('refuses SVG data URLs at the render site', () => {
    const { container } = render(<InlineShot dataUrl="data:image/svg+xml;base64,PHN2Zz4=" alt="Fixture image" />)
    expect(container.querySelector('img')).toBeNull()
  })
})
