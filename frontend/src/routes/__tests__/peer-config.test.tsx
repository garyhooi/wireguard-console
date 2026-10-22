// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// The page is rendered directly (outside a RouterProvider), so swap the
// file-route factory for a stub that resolves the /peer/$token param.
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ token: 'test-token' }),
  }),
}))

// jsdom has no canvas backend; QR generation is irrelevant to these tests.
vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async () => 'data:image/png;base64,stub'),
  },
}))

import { PeerConfigPage } from '../peer.$token'

function renderPage(minClaimMs = 20) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <PeerConfigPage minClaimMs={minClaimMs} />
    </QueryClientProvider>,
  )
}

function jsonRes(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response
}

const CONFIG = '[Interface]\nPrivateKey = stub-private-key\nAddress = 10.0.0.2/32\n'

let fetchMock: ReturnType<typeof vi.fn>

describe('PeerConfigPage claim gate', () => {
  beforeEach(() => {
    // jsdom has no 2D context; the holographic backdrop must degrade quietly.
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/peer-config/')) {
        return jsonRes({ peer_name: 'Test Device', config: CONFIG })
      }
      throw new Error('unexpected fetch: ' + String(url))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('opens on the claim screen without fetching the config', () => {
    renderPage()

    expect(screen.getByRole('heading', { name: 'Your VPN Configuration' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /claim configuration/i })).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('plays the claim hologram, fetches once, then reveals the config', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /claim configuration/i }))

    // Claim screen is replaced by the full-screen hologram and the fetch fires.
    expect(screen.getByTestId('config-claim-overlay')).toBeTruthy()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    // After the (shortened) minimum animation the config card is revealed.
    await waitFor(() => expect(screen.queryByTestId('config-claim-overlay')).toBeNull(), { timeout: 2000 })
    expect(screen.getByRole('heading', { name: 'Your VPN Configuration' })).toBeTruthy()
    expect(await screen.findByRole('button', { name: /download \.conf/i })).toBeTruthy()
    expect(screen.getByText('Test Device')).toBeTruthy()
    expect(screen.getByText(/PrivateKey = stub-private-key/)).toBeTruthy()
    expect(await screen.findByAltText('WireGuard config QR code')).toBeTruthy()
  })

  it('shows the invalid-link overlay when the link is expired or invalid', async () => {
    fetchMock.mockImplementation(async () => jsonRes({ error: 'Link is invalid or has expired' }, 404))
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /claim configuration/i }))

    expect(await screen.findByTestId('link-invalid-overlay')).toBeTruthy()
    expect(screen.getByText('LINK EXPIRED OR INVALID')).toBeTruthy()
  })
})
