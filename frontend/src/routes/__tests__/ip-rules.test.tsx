// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { IPBlockingPage } from '../_authenticated/ip-rules'

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function jsonRes(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response
}

/** Non-2xx response: apiJson reads text() to surface the {error} message. */
function errRes(error: string, status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error }),
    text: async () => JSON.stringify({ error }),
  } as Response
}

const rules = [
  {
    id: 'r-v4',
    scope: 'global',
    user_id: null,
    user_email: '',
    user_full_name: '',
    cidr: '203.0.113.0/24',
    note: 'CDN edge',
    created_at: '2026-10-20T09:00:00Z',
  },
  {
    id: 'r-v6',
    scope: 'user',
    user_id: 'u1',
    user_email: 'alice@example.com',
    user_full_name: 'Alice Tan',
    cidr: '2001:db8:bad::/48',
    note: '',
    created_at: '2026-10-19T09:00:00Z',
  },
]

const status = {
  enabled: true,
  rules_total: 2,
  global_rules: 1,
  user_rules: 1,
  expected_entries: 3,
  applied_servers: 1,
  failed_servers: 0,
  local_servers: [
    { server_id: 's1', name: 'SG-1', interface: 'wg0', ok: true, error: '' },
  ],
  unexpanded_user_rules: 0,
  conflicts: [],
}

describe('IPBlockingPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/ip-rules/status')) {
          return jsonRes(status)
        }
        if (url === '/api/ip-rules') {
          return jsonRes(rules)
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('lists global IPv4 and user-scoped IPv6 rules with family badges', async () => {
    renderWithClient(<IPBlockingPage />)
    await waitFor(() => expect(screen.getByText('203.0.113.0/24')).toBeTruthy())

    const v4Row = screen.getByText('203.0.113.0/24').closest('tr')!
    expect(within(v4Row).getByText('IPv4')).toBeTruthy()
    expect(within(v4Row).getByText('Global')).toBeTruthy()
    expect(within(v4Row).getByText('CDN edge')).toBeTruthy()

    const v6Row = screen.getByText('2001:db8:bad::/48').closest('tr')!
    expect(within(v6Row).getByText('IPv6')).toBeTruthy()
    expect(within(v6Row).getByText('Alice Tan')).toBeTruthy()
    // Empty note falls back to an em dash.
    expect(within(v6Row).getByText('—')).toBeTruthy()

    // Enforcement strip: one teal line when everything is applied.
    expect(screen.getByText('Applied on 1 server(s) — 2 rule(s) active.')).toBeTruthy()
  })

  it('posts a new global rule from the add modal', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/ip-rules' && init?.method === 'POST') {
        return jsonRes(
          {
            id: 'r-new',
            scope: 'global',
            user_id: null,
            user_email: '',
            user_full_name: '',
            cidr: '203.0.113.0/24',
            note: '',
            created_at: '',
          },
          201,
        )
      }
      if (url.includes('/api/ip-rules/status')) return jsonRes(status)
      if (url === '/api/ip-rules') return jsonRes([])
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<IPBlockingPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add IP rule' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('IP address or CIDR'), {
      target: { value: '203.0.113.0/24' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/ip-rules' && init?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        scope: 'global',
        cidr: '203.0.113.0/24',
        note: '',
      })
    })
  })

  it('shows the server validation error inline when a CIDR is rejected', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/ip-rules' && init?.method === 'POST') {
        return errRes('invalid CIDR: default routes are not allowed', 400)
      }
      if (url.includes('/api/ip-rules/status')) return jsonRes(status)
      if (url === '/api/ip-rules') return jsonRes([])
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<IPBlockingPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add IP rule' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('IP address or CIDR'), {
      target: { value: '0.0.0.0/0' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('invalid CIDR: default routes are not allowed')
    // The modal stays open so the admin can correct the value.
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('deletes a rule after confirmation and refetches', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    let listCalls = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return jsonRes({ status: 'deleted' })
      if (url.includes('/api/ip-rules/status')) return jsonRes(status)
      if (url === '/api/ip-rules') {
        listCalls += 1
        return jsonRes(rules)
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<IPBlockingPage />)
    await screen.findByText('203.0.113.0/24')
    expect(listCalls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Delete 203.0.113.0/24' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')
      expect(call).toBeTruthy()
      expect(call![0]).toBe('/api/ip-rules/r-v4')
      expect(listCalls).toBe(2)
    })
  })

  it('shows the disabled status strip when the kill-switch is off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/ip-rules/status')) return jsonRes({ ...status, enabled: false })
        if (url === '/api/ip-rules') return jsonRes(rules)
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    renderWithClient(<IPBlockingPage />)
    const disabled = await screen.findByText(
      'IP blocking is disabled for this deployment (WG_IP_BLOCK=0).',
    )
    expect(disabled.closest('[role="status"]')?.className).toContain('bg-red-500/10')
    expect(screen.queryByText(/Applied on/)).toBeNull()
  })
})
