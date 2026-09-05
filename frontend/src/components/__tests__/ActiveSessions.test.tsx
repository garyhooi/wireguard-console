// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ActiveSessions } from '../ActiveSessions'

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const sessions = {
  sessions: [
    {
      id: 'sess-current',
      ip_address: '203.0.113.5',
      user_agent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      created_at: '2026-01-01T08:00:00Z',
      last_seen_at: '2026-01-01T08:30:00Z',
      expires_at: '2026-01-02T08:00:00Z',
      is_current: true,
      is_pending_2fa: false,
    },
    {
      id: 'sess-other',
      ip_address: '198.51.100.7',
      user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1',
      created_at: '2026-01-01T07:00:00Z',
      last_seen_at: null,
      expires_at: '2026-01-02T07:00:00Z',
      is_current: false,
      is_pending_2fa: false,
    },
  ],
}

describe('ActiveSessions', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (url.includes('/api/admins/me/sessions') && method === 'GET') {
          return { ok: true, status: 200, json: async () => sessions } as Response
        }
        if (url.includes('/api/admins/me/sessions/revoke-others') && method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ revoked: 1 }) } as Response
        }
        if (url.includes('/api/admins/me/sessions/sess-other') && method === 'DELETE') {
          return { ok: true, status: 200, json: async () => ({ status: 'revoked' }) } as Response
        }
        throw new Error(`Unexpected request ${method} ${url}`)
      }),
    )
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders each live session with a current-device badge', async () => {
    renderWithClient(<ActiveSessions />)
    await waitFor(() => expect(screen.getByText('This device')).toBeTruthy())
    // Current = Chrome on macOS (is_current badge), other = the iPhone row.
    expect(screen.getByText(/Chrome on macOS/)).toBeTruthy()
    expect(screen.getByText(/Safari on iOS/)).toBeTruthy()
    expect(screen.getByText('203.0.113.5')).toBeTruthy()
    expect(screen.getByText('198.51.100.7')).toBeTruthy()
  })

  it('does not show a Revoke button on the current session', async () => {
    renderWithClient(<ActiveSessions />)
    await waitFor(() => expect(screen.getByText('This device')).toBeTruthy())
    const currentRow = screen.getByText('This device').closest('li')!
    expect(currentRow.querySelector('button')).toBeNull()
  })

  it('offers sign-out-of-others and counts the other session', async () => {
    renderWithClient(<ActiveSessions />)
    await waitFor(() => expect(screen.getByText('This device')).toBeTruthy())
    expect(screen.getByText('Sign out 1 other(s)')).toBeTruthy()
  })
})
