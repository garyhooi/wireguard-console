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
import { StatisticsPage } from '../_authenticated/statistics'

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

// Bytes chosen so every formatted value is a clean whole MB: 1 MiB = 1048576.
const MB = 1024 * 1024

const usageUsers = {
  scope: 'user',
  from: '2026-01-01',
  to: '2026-01-08',
  rows: [
    {
      id: 'u1',
      name: 'Alice Tan',
      email: 'alice@example.com',
      full_name: 'Alice Tan',
      rx_bytes: 1 * MB, // 1 MB
      tx_bytes: 1 * MB, // 1 MB → row total 2 MB
      peers: 2,
    },
    {
      id: 'u2',
      name: '',
      email: 'bob@example.com',
      full_name: '',
      rx_bytes: 2 * MB, // 2 MB
      tx_bytes: 1 * MB, // 1 MB → row total 3 MB
      peers: 1,
    },
  ],
}

const usagePeers = {
  scope: 'peer',
  from: '2026-01-01',
  to: '2026-01-08',
  rows: [
    {
      id: 'p1',
      name: 'MacBook',
      email: 'alice@example.com',
      full_name: 'Alice Tan',
      allowed_ip: '10.8.0.2',
      rx_bytes: 4 * MB,
      tx_bytes: 2 * MB,
    },
    {
      id: 'p2',
      name: 'iPhone',
      email: 'alice@example.com',
      full_name: 'Alice Tan',
      allowed_ip: '10.8.0.3',
      rx_bytes: 1 * MB,
      tx_bytes: 1 * MB,
    },
  ],
}

describe('StatisticsPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/stats/overview')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total_rx_bytes: 0,
              total_tx_bytes: 0,
              connected_peers: 0,
              total_peers: 2,
            }),
          } as Response
        }
        if (url.includes('/api/stats/traffic')) {
          return { ok: true, status: 200, json: async () => ({ series: [], top: [] }) } as Response
        }
        if (url.includes('/api/web-activity/top-domains')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ days: 7, allowed: [], blocked: [] }),
          } as Response
        }
        if (url.includes('/api/peers')) {
          return { ok: true, status: 200, json: async () => [] } as Response
        }
        if (url.includes('/api/stats/usage')) {
          const body = url.includes('scope=peer') ? usagePeers : usageUsers
          return { ok: true, status: 200, json: async () => body } as Response
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
  })

  // The peer-state table (above) has no tfoot; only the usage table does, so
  // a document-level tfoot query is unambiguous on this page.
  const tfoot = () => document.querySelector('tfoot')!

  it('sums all VPN users into a totals footer row', async () => {
    renderWithClient(<StatisticsPage />)
    await waitFor(() => expect(tfoot().textContent).toContain('Total · 2 VPN users'))
    // Alice rx 1 MB + tx 1 MB; Bob rx 2 MB + tx 1 MB
    expect(tfoot().textContent).toContain('3 MB') // total download 1+2
    expect(tfoot().textContent).toContain('2 MB') // total upload 1+1
    expect(tfoot().textContent).toContain('5 MB') // grand total
  })

  it('sums all peers into a totals footer row', async () => {
    renderWithClient(<StatisticsPage />)
    await waitFor(() => expect(tfoot().textContent).toContain('Total · 2 VPN users'))
    screen.getByText('By peer').click()
    await waitFor(() => expect(tfoot().textContent).toContain('Total · 2 peers'))
    // MacBook rx 4 + tx 2; iPhone rx 1 + tx 1
    expect(tfoot().textContent).toContain('5 MB') // total download 4+1
    expect(tfoot().textContent).toContain('3 MB') // total upload 2+1
    expect(tfoot().textContent).toContain('8 MB') // grand total
  })
})
