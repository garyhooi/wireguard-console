// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { UsersPage } from '../_authenticated/users'

function renderWithClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function jsonRes(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response
}

const departments = [
  { id: 'd1', name: 'Engineering', user_count: 1, created_at: '2026-10-20T09:00:00Z' },
  { id: 'd2', name: 'Sales', user_count: 0, created_at: '2026-10-19T09:00:00Z' },
]

const users = [
  {
    id: 'u1',
    email: 'alice@example.com',
    full_name: 'Alice Tan',
    department_id: 'd1',
    department_name: 'Engineering',
    status: 'active',
    invited_at: null,
    activated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'u2',
    email: 'bob@example.com',
    full_name: '',
    department_id: null,
    department_name: '',
    status: 'invited',
    invited_at: '2026-01-02T00:00:00Z',
    activated_at: null,
    created_at: '2026-01-02T00:00:00Z',
  },
]

describe('UsersPage departments', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/config/smtp')) {
          return jsonRes({ configured: false })
        }
        if (url === '/api/departments') return jsonRes(departments)
        if (url.includes('/api/users')) return jsonRes(users)
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows a department column with an em dash fallback', async () => {
    renderWithClient(<UsersPage />)
    await waitFor(() => expect(screen.getByText('Alice Tan')).toBeTruthy())

    const aliceRow = screen.getByText('alice@example.com').closest('tr')!
    expect(within(aliceRow).getByText('Engineering')).toBeTruthy()

    const bobRow = screen.getByText('bob@example.com').closest('tr')!
    expect(within(bobRow).getByText('—')).toBeTruthy()
  })

  it('sends the selected department in the invite body', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/users' && init?.method === 'POST') {
        return jsonRes({ invite_link: '' }, 201)
      }
      if (url.includes('/api/config/smtp')) return jsonRes({ configured: false })
      if (url === '/api/departments') return jsonRes(departments)
      if (url.includes('/api/users')) return jsonRes(users)
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<UsersPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Invite User' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Email'), {
      target: { value: 'carol@example.com' },
    })
    fireEvent.change(within(dialog).getByLabelText('Full Name'), {
      target: { value: 'Carol Lim' },
    })
    fireEvent.change(within(dialog).getByLabelText('Department (optional)'), {
      target: { value: 'd2' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Invite User' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/users' && init?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call![1]?.body))).toEqual({
        email: 'carol@example.com',
        full_name: 'Carol Lim',
        department_id: 'd2',
      })
    })
  })

  it('updates and clears a user department via PATCH', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/users/u1' && init?.method === 'PATCH') {
        return jsonRes({ status: 'updated' })
      }
      if (url.includes('/api/config/smtp')) return jsonRes({ configured: false })
      if (url === '/api/departments') return jsonRes(departments)
      if (url.includes('/api/users')) return jsonRes(users)
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<UsersPage />)
    await waitFor(() => expect(screen.getByText('Alice Tan')).toBeTruthy())

    // Assign Sales.
    fireEvent.click(screen.getByRole('button', { name: 'Edit department for alice@example.com' }))
    let dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Department'), {
      target: { value: 'd2' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/users/u1' && init?.method === 'PATCH',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call![1]?.body))).toEqual({ department_id: 'd2' })
    })

    // Re-open and clear it: null is sent so the API unassigns the user.
    fireEvent.click(screen.getByRole('button', { name: 'Edit department for alice@example.com' }))
    dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Department'), {
      target: { value: '' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/users/u1' && init?.method === 'PATCH',
      )
      expect(patches.length).toBe(2)
      expect(JSON.parse(String(patches[1][1]?.body))).toEqual({ department_id: null })
    })
  })
})
