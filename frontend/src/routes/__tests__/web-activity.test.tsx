// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WebActivityPage } from '../_authenticated/web-activity'

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const summary = {
  scope: 'user',
  from: '2026-01-01',
  to: '2026-01-08',
  rows: [
    {
      scope: 'user',
      id: 'u1',
      name: 'Alice Tan',
      email: 'alice@example.com',
      peers: 1,
      allowed: 42,
      blocked: 3,
      last_seen: '2026-01-08T09:30:00Z',
    },
    {
      scope: 'user',
      id: 'u2',
      name: 'bob@example.com',
      email: 'bob@example.com',
      peers: 2,
      allowed: 8,
      blocked: 0,
      last_seen: null,
    },
  ],
}

const records = {
  from: '2026-01-01',
  to: '2026-01-08',
  limit: 200,
  count: 2,
  rows: [
    {
      id: 1,
      peer_id: 'p1',
      peer_name: 'MacBook',
      user_id: 'u1',
      user_name: 'Alice Tan',
      user_email: 'alice@example.com',
      client_ip: '10.8.0.2',
      host: 'www.youtube.com',
      base_domain: 'youtube.com',
      blocked: true,
      reason: 'FilteredBlackList',
      queried_at: '2026-01-08T09:30:00Z',
    },
    {
      id: 2,
      peer_id: 'p1',
      peer_name: 'MacBook',
      user_id: 'u1',
      user_name: 'Alice Tan',
      user_email: 'alice@example.com',
      client_ip: '10.8.0.2',
      host: 'www.google.com',
      base_domain: 'google.com',
      blocked: false,
      reason: null,
      queried_at: '2026-01-08T09:29:00Z',
    },
  ],
}

const emptyBlockedIPs = { days: 7, total_hits: 0, top: [], records: [] }

/** Default API mock; pass overrides for endpoint payloads a test cares about. */
function mockApi(overrides: { blockedIps?: unknown } = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes('/api/admins/me')) {
      return { ok: true, status: 200, json: async () => ({ id: 'a1', role: 'super_admin' }) } as Response
    }
    if (url.includes('/api/users')) {
      return { ok: true, status: 200, json: async () => [] } as Response
    }
    if (url.includes('/api/peers')) {
      return { ok: true, status: 200, json: async () => [] } as Response
    }
    if (url.includes('/api/web-activity/summary')) {
      return { ok: true, status: 200, json: async () => summary } as Response
    }
    if (url.includes('/api/web-activity/ip-blocked')) {
      return {
        ok: true,
        status: 200,
        json: async () => overrides.blockedIps ?? emptyBlockedIPs,
      } as Response
    }
    if (url.includes('/api/web-activity')) {
      return { ok: true, status: 200, json: async () => records } as Response
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

describe('WebActivityPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockApi())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders the per-user summary table', async () => {
    renderWithClient(<WebActivityPage />)
    await waitFor(() => expect(screen.getByText('Alice Tan')).toBeTruthy())
    expect(screen.getByText('bob@example.com')).toBeTruthy()
    // Blocked count renders.
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('renders housekeeping panel for super admin', async () => {
    renderWithClient(<WebActivityPage />)
    await waitFor(() => expect(screen.getByText('Housekeeping')).toBeTruthy())
    expect(screen.getByText(/retention window/)).toBeTruthy()
  })

  it('expands a row to show its records with blocked/allowed badges', async () => {
    renderWithClient(<WebActivityPage />)
    await waitFor(() => expect(screen.getByText('Alice Tan')).toBeTruthy())
    // The name appears in the summary table row (and the filters drop the
    // users list is empty here, so only the row matches — but guard anyway).
    const row = screen.getAllByText('Alice Tan')[0].closest('tr')!
    row.click()
    await waitFor(() => expect(screen.getByText('www.youtube.com')).toBeTruthy())
    expect(screen.getByText(/Blocked · FilteredBlackList/)).toBeTruthy()
    expect(screen.getByText('www.google.com')).toBeTruthy()
  })

  it('renders blocked-IP attempts with the per-user label and packet count', async () => {
    vi.stubGlobal(
      'fetch',
      mockApi({
        blockedIps: {
          days: 7,
          total_hits: 2,
          top: [{ dest_cidr: '203.0.113.0/24', hits: 2 }],
          records: [
            {
              id: 1,
              user_name: 'Alice Tan',
              user_email: 'alice@example.com',
              client_ip: '10.8.0.2',
              dest_cidr: '203.0.113.0/24',
              packets: 1234,
              sampled_at: '2026-01-08T09:30:00Z',
            },
            {
              id: 2,
              user_name: '',
              user_email: '',
              client_ip: '10.8.0.3',
              dest_cidr: '2001:db8:bad::/48',
              packets: 7,
              sampled_at: '2026-01-08T09:31:00Z',
            },
          ],
        },
      }),
    )

    renderWithClient(<WebActivityPage />)
    expect(await screen.findByText('Blocked IP attempts · last 7 days')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('203.0.113.0/24')).toBeTruthy())

    // Per-user record: user name, mono destination, thousands-separated packets.
    const userRow = screen.getByText('203.0.113.0/24').closest('tr')!
    expect(within(userRow).getByText('Alice Tan')).toBeTruthy()
    expect(within(userRow).getByText('1,234')).toBeTruthy()

    // A hit with no owning user comes from a global rule → "All peers".
    const globalRow = screen.getByText('2001:db8:bad::/48').closest('tr')!
    expect(within(globalRow).getByText('All peers')).toBeTruthy()
    expect(within(globalRow).getByText('7')).toBeTruthy()
  })
})
