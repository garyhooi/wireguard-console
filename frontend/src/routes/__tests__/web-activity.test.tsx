// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
import { render, screen, waitFor, within } from '@testing-library/react'
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

describe('WebActivityPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
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
        if (url.includes('/api/web-activity')) {
          return { ok: true, status: 200, json: async () => records } as Response
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
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
})
