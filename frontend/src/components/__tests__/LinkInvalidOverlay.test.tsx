// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { LinkInvalidOverlay } from '../LinkInvalidOverlay'

afterEach(cleanup)

describe('LinkInvalidOverlay', () => {
  it('renders a persistent full-screen red status with the title and detail', () => {
    render(
      <LinkInvalidOverlay
        title="LINK EXPIRED"
        detail="This invite link has expired. Ask your administrator to send you a new one."
      />,
    )

    const overlay = screen.getByTestId('link-invalid-overlay')
    expect(overlay.className).toContain('fixed')
    expect(overlay.className).toContain('inset-0')
    expect(overlay.getAttribute('role')).toBe('alert')

    expect(screen.getByText('LINK EXPIRED')).toBeTruthy()
    expect(
      screen.getByText('This invite link has expired. Ask your administrator to send you a new one.'),
    ).toBeTruthy()
    expect(screen.getByText(/Ask your administrator for a new link/i)).toBeTruthy()
  })
})
