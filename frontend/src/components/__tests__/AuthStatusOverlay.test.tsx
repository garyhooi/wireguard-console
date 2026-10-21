// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AuthStatusOverlay } from '../AuthStatusOverlay'

describe('AuthStatusOverlay', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows the success animation and calls onDone after ~2s', () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    render(<AuthStatusOverlay status="success" onDone={onDone} />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText('IDENTITY VERIFIED')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1999)
    expect(onDone).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('shows the failure variant with the server message', () => {
    render(<AuthStatusOverlay status="failure" message="Invalid code" onDone={() => {}} />)
    expect(screen.getByText('VERIFICATION FAILED')).toBeTruthy()
    expect(screen.getByText('Invalid code')).toBeTruthy()
  })
})
