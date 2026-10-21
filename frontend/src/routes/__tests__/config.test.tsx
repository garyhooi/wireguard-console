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

describe('Configuration → Security login lockout', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows the current policy and saves super-admin edits', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/config/smtp') && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ host: '', configured: false }) } as Response
      }
      if (url.includes('/api/admins/me') && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ role: 'super_admin' }) } as Response
      }
      if (url.includes('/api/config/step-up') && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ step_up_minutes: 0 }) } as Response
      }
      if (url.includes('/api/config/security') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            login_max_attempts: 3,
            login_ip_lockout_seconds: 60,
            login_account_lockout_seconds: 60,
          }),
        } as Response
      }
      if (url.includes('/api/config/security') && method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ status: 'updated' }) } as Response
      }
      throw new Error('unexpected fetch: ' + method + ' ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderPage()
    await screen.findByRole('button', { name: 'Email (SMTP)' })
    fireEvent.click(screen.getByRole('button', { name: 'Security' }))
    await screen.findByText('Login lockout')
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())

    expect((screen.getByLabelText('Failed attempts') as HTMLInputElement).value).toBe('3')
    expect((screen.getByLabelText('IP lockout (seconds)') as HTMLInputElement).value).toBe('60')
    expect((screen.getByLabelText('Account lockout (seconds)') as HTMLInputElement).value).toBe('60')

    fireEvent.change(screen.getByLabelText('Failed attempts'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('IP lockout (seconds)'), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText('Account lockout (seconds)'), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save lockout policy' }))

    await waitFor(() => {
      const patches = calls.filter(
        (c) => c.url.includes('/api/config/security') && (c.init?.method ?? 'GET').toUpperCase() === 'PATCH',
      )
      expect(patches.length).toBe(1)
      expect(JSON.parse(String(patches[0].init?.body))).toEqual({
        login_max_attempts: 4,
        login_ip_lockout_seconds: 30,
        login_account_lockout_seconds: 45,
      })
    })
    await screen.findByText(/Saved — new lockouts use these values/)
  })
})
