// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DashboardPage } from '../_authenticated/dashboard'

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const stats = {
  total_peers: 10,
  active_peers: 8,
  suspended_peers: 1,
  total_users: 4,
  active_users: 3,
  total_servers: 2,
  connected_peers: 6,
}

const peers = [
  {
    id: 'p1',
    name: 'MacBook',
    allowed_ip: '10.8.0.2',
    status: 'active',
    last_handshake_at: null,
  },
]

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.includes('/api/peers') ? peers : stats
        return {
          ok: true,
          status: 200,
          json: async () => body,
        } as Response
      }),
    )
  })

  it('renders KPIs from the API', async () => {
    renderWithClient(<DashboardPage />)
    await waitFor(() => expect(screen.getByText('MacBook')).toBeTruthy())
    expect(screen.getByText('10')).toBeTruthy() // peers KPI
    expect(screen.getByText('6')).toBeTruthy() // connected KPI
    expect(screen.getByText('2')).toBeTruthy() // servers KPI
    expect(screen.getAllByText('10.8.0.2').length).toBeGreaterThan(0)
  })

  it('shows the empty state when there are no peers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.includes('/api/peers') ? [] : stats
        return { ok: true, status: 200, json: async () => body } as Response
      }),
    )
    renderWithClient(<DashboardPage />)
    await waitFor(() => expect(screen.getByText('No peers yet')).toBeTruthy())
  })
})