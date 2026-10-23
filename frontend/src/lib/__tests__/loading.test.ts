import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetLoadingForTests,
  beginLoading,
  endLoading,
  getLoadingCount,
  subscribeLoading,
} from '../loading'

describe('loading store', () => {
  beforeEach(() => {
    _resetLoadingForTests()
  })

  it('starts idle and tracks overlapping work', () => {
    expect(getLoadingCount()).toBe(0)
    beginLoading()
    beginLoading()
    expect(getLoadingCount()).toBe(2)
    endLoading()
    expect(getLoadingCount()).toBe(1)
    endLoading()
    expect(getLoadingCount()).toBe(0)
  })

  it('never drops below zero on unbalanced endLoading calls', () => {
    endLoading()
    expect(getLoadingCount()).toBe(0)
  })

  it('notifies subscribers on every change and stops after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLoading(listener)
    beginLoading()
    expect(listener).toHaveBeenCalledTimes(1)
    endLoading()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    beginLoading()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('notifies every listener even when one unsubscribes mid-emit', () => {
    const calls: string[] = []
    const unsubscribeSelf = subscribeLoading(() => {
      calls.push('self')
      unsubscribeSelf()
    })
    subscribeLoading(() => calls.push('last'))
    beginLoading()
    expect(calls).toEqual(['self', 'last'])
    // The self-unsubscribed listener is gone for the next change.
    endLoading()
    expect(calls).toEqual(['self', 'last', 'last'])
  })

  it('_resetLoadingForTests zeroes the counter and drops subscribers', () => {
    beginLoading()
    beginLoading()
    const listener = vi.fn()
    subscribeLoading(listener)
    _resetLoadingForTests()
    expect(getLoadingCount()).toBe(0)
    beginLoading()
    expect(listener).not.toHaveBeenCalled()
  })
})
