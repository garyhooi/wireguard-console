// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiJson } from '../api'
import { _resetLoadingForTests, getLoadingCount } from '../loading'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function jsonRes(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => (data === undefined ? '' : JSON.stringify(data)),
  } as Response
}

describe('apiFetch global loading instrumentation', () => {
  beforeEach(() => {
    _resetLoadingForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    _resetLoadingForTests()
  })

  it('counts a POST as busy until it resolves', async () => {
    const pending = deferred<Response>()
    const fetchMock = vi.fn(() => pending.promise)
    vi.stubGlobal('fetch', fetchMock)

    const request = apiJson<{ id: string }>('/api/servers', { method: 'POST', body: { name: 'eu-1' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getLoadingCount()).toBe(1)

    pending.resolve(jsonRes({ id: 'srv-1' }))
    await expect(request).resolves.toEqual({ id: 'srv-1' })
    expect(getLoadingCount()).toBe(0)
  })

  it('covers deletes and other non-GET methods', async () => {
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => pending.promise))

    const request = apiJson('/api/servers/srv-1', { method: 'DELETE' })
    expect(getLoadingCount()).toBe(1)

    pending.resolve(jsonRes(undefined, 204))
    await request
    expect(getLoadingCount()).toBe(0)
  })

  it('does not mark GET requests as busy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes([])))

    const request = apiJson('/api/servers')
    expect(getLoadingCount()).toBe(0)

    await expect(request).resolves.toEqual([])
    expect(getLoadingCount()).toBe(0)
  })

  it('returns to zero when the network request rejects', async () => {
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => pending.promise))

    const request = apiJson('/api/servers/srv-1', { method: 'DELETE' })
    expect(getLoadingCount()).toBe(1)

    const assertion = expect(request).rejects.toThrow('network down')
    pending.reject(new Error('network down'))
    await assertion
    expect(getLoadingCount()).toBe(0)
  })

  it('returns to zero when the API answers with an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ error: 'boom' }, 500)))

    const assertion = expect(apiJson('/api/servers', { method: 'POST', body: {} })).rejects.toThrow('boom')
    // beginLoading runs synchronously, before the fetch settles.
    expect(getLoadingCount()).toBe(1)
    await assertion
    expect(getLoadingCount()).toBe(0)
  })

  it('keeps the counter above zero while overlapping requests are in flight', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    )

    const a = apiJson('/api/servers', { method: 'POST', body: {} })
    const b = apiJson('/api/servers/srv-1/resync', { method: 'POST' })
    expect(getLoadingCount()).toBe(2)

    first.resolve(jsonRes({}))
    await a
    expect(getLoadingCount()).toBe(1)

    second.resolve(jsonRes({}))
    await b
    expect(getLoadingCount()).toBe(0)
  })
})
