// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DepartmentsPage } from '../_authenticated/departments'

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
  {
    id: 'd1',
    name: 'Engineering',
    user_count: 3,
    created_at: '2026-10-20T09:00:00Z',
  },
  {
    id: 'd2',
    name: 'Sales',
    user_count: 0,
    created_at: '2026-10-19T09:00:00Z',
  },
]

describe('DepartmentsPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/departments') return jsonRes(departments)
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('lists departments with their user counts and actions', async () => {
    renderWithClient(<DepartmentsPage />)
    await waitFor(() => expect(screen.getByText('Engineering')).toBeTruthy())

    const engineering = screen.getByText('Engineering').closest('tr')!
    expect(within(engineering).getByText('3')).toBeTruthy()
    expect(within(engineering).getByRole('button', { name: 'Edit Engineering' })).toBeTruthy()
    expect(within(engineering).getByRole('button', { name: 'Delete Engineering' })).toBeTruthy()

    const sales = screen.getByText('Sales').closest('tr')!
    expect(within(sales).getByText('0')).toBeTruthy()
  })

  it('creates a department from the modal', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/departments' && init?.method === 'POST') {
        return jsonRes(
          { id: 'd3', name: 'Operations', user_count: 0, created_at: '' },
          201,
        )
      }
      if (url === '/api/departments') return jsonRes([])
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<DepartmentsPage />)
    // Empty state also offers "Add department"; the header button is first.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Add department' }))[0])
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Operations' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add department' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/departments' && init?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call![1]?.body))).toEqual({ name: 'Operations' })
    })
  })

  it('deletes a department after confirmation', async () => {
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmMock)
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonRes({ status: 'deleted', users_cleared: 3 })
      }
      if (url === '/api/departments') return jsonRes(departments)
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithClient(<DepartmentsPage />)
    await screen.findByText('Engineering')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Engineering' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')
      expect(call).toBeTruthy()
      expect(call![0]).toBe('/api/departments/d1')
    })
    // The confirm warns that assigned users are unassigned, not deleted.
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining('3 user(s) will be unassigned'),
    )
  })
})
