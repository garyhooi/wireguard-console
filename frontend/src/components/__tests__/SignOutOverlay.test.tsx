// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SignOutOverlay } from '../SignOutOverlay'

describe('SignOutOverlay', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows the session-terminated stage and calls onDone after ~1.8s', () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    render(<SignOutOverlay onDone={onDone} />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText('SESSION TERMINATED')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1799)
    expect(onDone).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
