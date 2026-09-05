// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  }
})
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { _resetTimezoneForTests } from '../../lib/timezone'
import { ConfigPage } from '../_authenticated/config'

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(<QueryClientProvider client={qc}><ConfigPage /></QueryClientProvider>)
}

function timezonePatchCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (c) => String(c[0]).includes('/api/config/timezone') && (c[1] as RequestInit)?.method === 'PATCH',
  )
}

describe('Configuration → Timezone', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    _resetTimezoneForTests()
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/config/smtp') && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ host: '', configured: false }) } as Response
      }
      if (url.includes('/api/config/email-templates') && method === 'GET') {
        return { ok: true, status: 200, json: async () => [] } as Response
      }
      if (url.includes('/api/config/timezone') && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ timezone: '' }) } as Response
      }
      if (url.includes('/api/config/timezone') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { timezone?: string }
        return { ok: true, status: 200, json: async () => ({ status: 'updated', timezone: body.timezone }) } as Response
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    _resetTimezoneForTests()
  })

  it('switches to the Timezone tab and saves a chosen zone', async () => {
    renderPage()
    await screen.findByRole('button', { name: 'Email (SMTP)' })

    fireEvent.click(screen.getByRole('button', { name: 'Timezone' }))
    await screen.findByText(/The display timezone for reports/)

    // Wait for the timezone-config GET to settle (loading → form).
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
    const zoneSel = screen.getByLabelText('Timezone') as HTMLSelectElement
    await waitFor(() => expect(zoneSel.value).toBe(''))

    // Status row shows the fallback when unset.
    expect(screen.getAllByText('Browser timezone').length).toBeGreaterThan(0)

    // Pick a zone from the Asia group.
    fireEvent.change(zoneSel, { target: { value: 'Asia/Kuala_Lumpur' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save timezone' }))

    await waitFor(() => {
      expect(timezonePatchCalls(fetchMock).length).toBeGreaterThan(0)
    })
    const body = JSON.parse(String(timezonePatchCalls(fetchMock)[0][1]?.body ?? '{}'))
    expect(body).toEqual({ timezone: 'Asia/Kuala_Lumpur' })

    await screen.findByText(/Timezone set to Asia\/Kuala_Lumpur/)
  })

  it('shows the reset action and clearing works', async () => {
    // Server has a zone configured.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/config/timezone') && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ timezone: 'Asia/Kuala_Lumpur' }) } as Response
      }
      if (url.includes('/api/config/timezone') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { timezone?: string }
        return { ok: true, status: 200, json: async () => ({ status: 'updated', timezone: body.timezone }) } as Response
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    })

    renderPage()
    await screen.findByRole('button', { name: 'Email (SMTP)' })
    fireEvent.click(screen.getByRole('button', { name: 'Timezone' }))

    // Currently shows the server zone (select value reflects it once loaded).
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
    const zoneSel = screen.getByLabelText('Timezone') as HTMLSelectElement
    await waitFor(() => expect(zoneSel.value).toBe('Asia/Kuala_Lumpur'))

    // Reset button is enabled (a zone is set) and clears it.
    fireEvent.click(screen.getByRole('button', { name: 'Reset to browser timezone' }))
    await waitFor(() => {
      const calls = timezonePatchCalls(fetchMock)
      expect(calls.length).toBeGreaterThan(0)
      const body = JSON.parse(String(calls[calls.length - 1][1]?.body ?? '{}'))
      expect(body).toEqual({ timezone: '' })
    })
    await screen.findByText(/Timezone cleared/)
  })
})
