// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MonitoringPage } from '../_authenticated/monitoring'

// Vitest runs without globals here, so RTL's auto-cleanup never registers;
// remove rendered DOM between tests explicitly or later tests see the
// previous render's elements.
afterEach(() => cleanup())

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

// 1 GiB = 1073741824 bytes for clean formatBytes output.
const GIB = 1024 * 1024 * 1024

const nodeWithMetrics = {
  id: 'n1',
  name: 'Singapore Node',
  location: 'SG',
  status: 'active',
  last_seen_at: new Date().toISOString(),
  last_status: 'ok',
  server_count: 2,
  metrics_at: new Date().toISOString(),
  metrics: {
    cpu: { cores: 4, percent: 12.5 },
    load: [0.42, 0.55, 0.48],
    mem: { total: 16 * GIB, used: 4 * GIB, percent: 25 },
    swap: { total: 2 * GIB, used: 0, percent: 0 },
    disk: [
      { mount: '/', device: '/dev/sda1', fs: 'ext4', total: 100 * GIB, used: 50 * GIB, percent: 50 },
    ],
    net: [{ interface: 'eth0', rx_bps: 1024, tx_bps: 2048 }],
    uptime_s: 3564000,
    host: { hostname: 'sg-1', os: 'linux', arch: 'amd64', kernel: '6.8.0', agent_version: 'e2e' },
    collected_at: new Date().toISOString(),
  },
}

const nodeNoMetrics = {
  id: 'n2',
  name: 'Old Agent Node',
  location: 'US',
  status: 'active',
  last_seen_at: new Date().toISOString(),
  last_status: 'ok',
  server_count: 1,
  metrics_at: null,
  metrics: {},
}

const localStatus = {
  hostname: 'Local host (console)',
  is_local: true,
  metrics_at: new Date().toISOString(),
  metrics: {
    cpu: { cores: 8, percent: 3.1 },
    mem: { total: 32 * GIB, used: 8 * GIB, percent: 25 },
    disk: [
      { mount: '/', device: '/dev/nvme0n1p2', fs: 'ext4', total: 500 * GIB, used: 250 * GIB, percent: 50 },
    ],
    uptime_s: 86400,
  },
}

describe('MonitoringPage', () => {
  beforeEach(() => {
  })

  function stubFetch(overrides: { local?: () => Promise<Response> } = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/nodes/local/status')) {
          if (overrides.local) return overrides.local()
          return { ok: true, status: 200, json: async () => localStatus } as Response
        }
        // /api/nodes
        return { ok: true, status: 200, json: async () => [nodeWithMetrics, nodeNoMetrics] } as Response
      }),
    )
  }

  it('renders node cards with CPU, memory and disk gauges', async () => {
    stubFetch()
    renderWithClient(<MonitoringPage />)

    await waitFor(() => expect(screen.getByText('Singapore Node')).toBeTruthy())
    expect(screen.getByText('Local host (console)')).toBeTruthy()
    expect(screen.getByText('Old Agent Node')).toBeTruthy()

    // CPU percent rendered
    expect(screen.getByText('12.5%')).toBeTruthy()
    // Memory used / total (4 GiB of 16 GiB)
    expect(screen.getByText('4 GB / 16 GB')).toBeTruthy()
    // Disk
    expect(screen.getByText('50 GB / 100 GB')).toBeTruthy()
    // Uptime 41d 6h
    expect(screen.getByText('41d 6h')).toBeTruthy()
  })

  it('shows a waiting state for agents without metrics', async () => {
    stubFetch()
    renderWithClient(<MonitoringPage />)
    await waitFor(() => expect(screen.getByText('Old Agent Node')).toBeTruthy())
    expect(screen.getAllByText(/Waiting for agent metrics/).length).toBeGreaterThan(0)
  })

  it('renders only remote nodes when the local helper is unavailable (503)', async () => {
    stubFetch({
      local: async () => ({ ok: false, status: 503, json: async () => ({ error: 'n/a' }) }) as Response,
    })
    renderWithClient(<MonitoringPage />)
    await waitFor(() => expect(screen.getByText('Singapore Node')).toBeTruthy())
    expect(screen.queryByText('Local host (console)')).toBeNull()
  })

  it('shows the empty state when there are no nodes and no local status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/nodes/local/status')) {
          return { ok: false, status: 503, json: async () => ({}) } as Response
        }
        return { ok: true, status: 200, json: async () => [] } as Response
      }),
    )
    renderWithClient(<MonitoringPage />)
    await waitFor(() => expect(screen.getByText('Nothing to monitor yet')).toBeTruthy())
  })
})
