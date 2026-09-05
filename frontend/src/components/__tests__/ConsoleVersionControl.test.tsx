// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConsoleVersionControl, INSTALL_CMD, UpdateCheckResponse } from '../ConsoleVersionControl'

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

const baseResponse: UpdateCheckResponse = {
  current: '1.0.0',
  latest: '1.0.0',
  latest_url: 'https://github.com/garyhooi/wireguard-console/releases/tag/v1.0.0',
  published_at: '2026-09-01T00:00:00Z',
  outdated: false,
  update: false,
  checked_at: '2026-09-06T00:00:00Z',
  install_cmd: INSTALL_CMD,
  releases_url: 'https://github.com/garyhooi/wireguard-console/releases',
  backup_first: true,
  backup_method: 'Backups page → New backup',
}

describe('ConsoleVersionControl', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/update/check')) return ok(baseResponse)
        throw new Error(`Unexpected request ${String(url)}`)
      }),
    )
    // jsdom has no real clipboard; stub the async API the component prefers.
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => undefined),
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the current version from the server', async () => {
    renderWithClient(<ConsoleVersionControl />)
    await waitFor(() => expect(screen.getByText('v1.0.0')).toBeTruthy())
  })

  it('opens the modal with current and latest when the version pill is clicked', async () => {
    renderWithClient(<ConsoleVersionControl />)
    await waitFor(() => expect(screen.getByText('v1.0.0')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^version 1\.0\.0/i }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByText(/WireGuard Console v1\.0\.0/)).toBeTruthy()
  })

  it('shows an "Update available" chip and modal steps when a newer release exists', async () => {
    const updatable = {
      ...baseResponse,
      latest: '1.1.0',
      latest_url: 'https://github.com/garyhooi/wireguard-console/releases/tag/v1.1.0',
      outdated: true,
      update: true,
    }
    vi.stubGlobal('fetch', vi.fn(async () => ok(updatable)))

    renderWithClient(<ConsoleVersionControl />)
    await waitFor(() => expect(screen.getByText(/Update available/i)).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "Update available" }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByText(/v1\.0\.0 → v1\.1\.0/)).toBeTruthy()
    // Backup-first guidance is front and centre.
    expect(screen.getByText(/Back up first/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Backups/ })).toBeTruthy()
    // The exact install one-liner is present.
    expect(screen.getByText(INSTALL_CMD)).toBeTruthy()
  })

  it('copies the install command when Copy is clicked', async () => {
    const updatable = {
      ...baseResponse,
      latest: '1.1.0',
      outdated: true,
      update: true,
    }
    vi.stubGlobal('fetch', vi.fn(async () => ok(updatable)))

    renderWithClient(<ConsoleVersionControl />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Update available" })).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Update available" }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /copy install command/i }))
    await waitFor(() => expect(screen.getByText(/Copied/i)).toBeTruthy())
    // The command copied is the server-provided one-liner.
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(updatable.install_cmd)
  })

  it('renders the GitHub Releases link pointing at the repo releases page', async () => {
    renderWithClient(<ConsoleVersionControl />)
    await waitFor(() => expect(screen.getByText('v1.0.0')).toBeTruthy())
    const link = screen.getByRole('link', { name: /view the latest release on github/i })
    expect(link.getAttribute('href')).toBe('https://github.com/garyhooi/wireguard-console/releases')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('does not claim an update when only the check failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ...baseResponse,
          latest: '',
          check_error: 'github returned HTTP 403',
          outdated: false,
          update: false,
        }),
      })),
    )
    renderWithClient(<ConsoleVersionControl />)
    await waitFor(() => expect(screen.getByText('v1.0.0')).toBeTruthy())
    expect(screen.queryByText(/Update available/i)).toBeNull()
  })
})
