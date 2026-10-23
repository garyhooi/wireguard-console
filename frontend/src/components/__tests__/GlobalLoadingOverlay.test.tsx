// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { GlobalLoadingOverlay } from '../GlobalLoadingOverlay'
import { _resetLoadingForTests, beginLoading, endLoading } from '../../lib/loading'

function overlay() {
  return screen.queryByTestId('global-loading-overlay')
}

function percent(): string {
  return screen.getByTestId('global-loading-percent').textContent || ''
}

function percentNumber(): number {
  return Number.parseInt(percent(), 10)
}

function barWidth(): number {
  return Number.parseFloat(screen.getByTestId('global-loading-bar').style.width)
}

/** Render the overlay and make it visible (busy for longer than the 150 ms delay). */
function renderVisible() {
  render(<GlobalLoadingOverlay />)
  act(() => {
    beginLoading()
  })
  act(() => {
    vi.advanceTimersByTime(150)
  })
  expect(overlay()).not.toBeNull()
}

describe('GlobalLoadingOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetLoadingForTests()
  })

  afterEach(() => {
    cleanup()
    _resetLoadingForTests()
    vi.useRealTimers()
  })

  it('renders nothing while idle', () => {
    render(<GlobalLoadingOverlay />)
    expect(overlay()).toBeNull()
  })

  it('never flashes for work that finishes inside the 150 ms delay', () => {
    render(<GlobalLoadingOverlay />)
    act(() => {
      beginLoading()
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    act(() => {
      endLoading()
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(overlay()).toBeNull()
  })

  it('appears after 150 ms with a progress bar, percentage and WORKING label', () => {
    render(<GlobalLoadingOverlay />)
    act(() => {
      beginLoading()
    })
    act(() => {
      vi.advanceTimersByTime(149)
    })
    expect(overlay()).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    const el = overlay()
    expect(el).not.toBeNull()
    expect(el?.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status')).toBe(el)
    expect(percent()).toBe('8%')
    expect(barWidth()).toBe(8)
    expect(screen.getByText('WORKING')).toBeTruthy()
  })

  it('advances the percentage and the bar while work continues', () => {
    renderVisible()
    const firstPct = percentNumber()
    const firstWidth = barWidth()

    act(() => {
      vi.advanceTimersByTime(240)
    })

    expect(percentNumber()).toBeGreaterThan(firstPct)
    expect(barWidth()).toBeGreaterThan(firstWidth)
    // Fake progress never claims completion while requests are still running.
    expect(percentNumber()).toBeLessThanOrEqual(90)
    expect(barWidth()).toBeLessThanOrEqual(90)
  })

  it('jumps to 100% when work ends, then fades out and unmounts', () => {
    renderVisible()
    act(() => {
      vi.advanceTimersByTime(200)
    })

    act(() => {
      endLoading()
    })
    expect(percent()).toBe('100%')
    expect(barWidth()).toBe(100)

    // Guaranteed pause at 100% before the fade starts (350 ms minimum).
    act(() => {
      vi.advanceTimersByTime(349)
    })
    expect(overlay()).not.toBeNull()
    expect(overlay()?.style.opacity).toBe('1')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(overlay()).not.toBeNull()
    expect(overlay()?.style.opacity).toBe('0')

    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(overlay()).toBeNull()
  })

  it('stays visible for at least ~500 ms when the request finishes right after appearing', () => {
    renderVisible()
    act(() => {
      endLoading()
    })
    expect(percent()).toBe('100%')

    // 500 ms minimum visible: fade has not even started at 499 ms.
    act(() => {
      vi.advanceTimersByTime(499)
    })
    expect(overlay()).not.toBeNull()
    expect(overlay()?.style.opacity).toBe('1')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(overlay()?.style.opacity).toBe('0')

    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(overlay()).toBeNull()
  })

  it('cancels the hide and resumes when new work starts during completion', () => {
    renderVisible()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    act(() => {
      endLoading()
    })
    expect(percent()).toBe('100%')

    // Inside the completion window, a new request starts.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    act(() => {
      beginLoading()
    })

    expect(overlay()).not.toBeNull()
    expect(percent()).toBe('8%')
    expect(overlay()?.style.opacity).toBe('1')

    // Progress climbs again for the new burst.
    act(() => {
      vi.advanceTimersByTime(240)
    })
    expect(percentNumber()).toBeGreaterThan(8)
    expect(percentNumber()).toBeLessThanOrEqual(90)

    // And it still finishes cleanly afterwards.
    act(() => {
      endLoading()
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(overlay()).toBeNull()
  })

  it('keeps the overlay up while overlapping requests remain', () => {
    render(<GlobalLoadingOverlay />)
    act(() => {
      beginLoading()
      beginLoading()
    })
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(overlay()).not.toBeNull()

    act(() => {
      endLoading()
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    // One request still in flight: still fully visible, never 100%.
    expect(overlay()).not.toBeNull()
    expect(overlay()?.style.opacity).toBe('1')
    expect(percentNumber()).toBeLessThan(100)

    act(() => {
      endLoading()
    })
    expect(percent()).toBe('100%')
  })
})
