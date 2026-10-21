// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { LoginLockoutOverlay } from '../LoginLockoutOverlay'

describe('LoginLockoutOverlay', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('counts down and calls onUnlock exactly once at zero', () => {
    vi.useFakeTimers()
    const onUnlock = vi.fn()
    render(<LoginLockoutOverlay seconds={3} onUnlock={onUnlock} />)
    const timer = () => screen.getByTestId('lockout-remaining').textContent
    expect(screen.getByText('TOO MANY ATTEMPTS')).toBeTruthy()
    expect(timer()).toBe('0:03')

    act(() => vi.advanceTimersByTime(1000))
    expect(timer()).toBe('0:02')
    expect(onUnlock).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1000))
    expect(timer()).toBe('0:01')
    expect(onUnlock).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1000))
    expect(onUnlock).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(5000))
    expect(onUnlock).toHaveBeenCalledTimes(1)
  })
})
