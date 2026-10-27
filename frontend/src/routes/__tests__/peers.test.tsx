// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// The page reaches the backend only through these two helpers, so mocking the
// module keeps this test focused on the create/retry UX (no fetch/CSRF
// plumbing involved).
vi.mock('../../lib/api', () => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
}))

import { apiJson } from '../../lib/api'
import { PeersPage } from '../_authenticated/peers'

const apiJsonMock = vi.mocked(apiJson)

interface CreatePeerBody {
  name: string
  server_id: string
  user_id: string
  send_email: boolean
  request_id: string
}

const PEER = {
  id: 'p1',
  user_id: 'u1',
  server_id: 's1',
  name: 'Alice MacBook',
  public_key: 'peer-public-key',
  allowed_ip: '10.0.0.2',
  status: 'active',
  last_handshake_at: null,
  created_at: '2026-01-01T00:00:00Z',
  user_email: 'alice@example.com',
  user_full_name: 'Alice Tan',
  server_name: 'HK-1',
}

/** The peer the mocked backend "already committed" when the create response
 *  is lost; it appears in the list after the onError refetch. */
const NEW_PEER = {
  ...PEER,
  id: 'p2',
  name: 'Gary Laptop',
  public_key: 'new-peer-public-key',
  allowed_ip: '10.0.0.9',
}

const SERVERS = [{ id: 's1', name: 'HK-1' }]
const USERS = [
  { id: 'u1', email: 'alice@example.com', full_name: 'Alice Tan', status: 'active' },
]

/** Every read the page performs; POST /api/peers is answered per test. */
async function defaultReads(path: string): Promise<unknown> {
  if (path === '/api/config/smtp') return { configured: false }
  if (path === '/api/peers') return [PEER]
  if (path === '/api/servers') return SERVERS
  if (path === '/api/users') return USERS
  throw new Error(`unexpected apiJson call: ${path}`)
}

function createCalls() {
  return apiJsonMock.mock.calls.filter(
    ([path, init]) => path === '/api/peers' && init?.method === 'POST',
  )
}

function postBody(call: (typeof apiJsonMock.mock.calls)[number]): CreatePeerBody {
  return call[1]!.body as CreatePeerBody
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false },
      mutations: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={qc}>
      <PeersPage />
    </QueryClientProvider>,
  )
}

/** Opens Add Peer, fills the required fields and submits once. */
async function openAddPeer(name = 'Gary Laptop') {
  await waitFor(() => expect(screen.getByText('Alice MacBook')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Add Peer' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('Device name'), { target: { value: name } })
  fireEvent.change(within(dialog).getByLabelText('Server'), { target: { value: 's1' } })
  fireEvent.change(within(dialog).getByLabelText('User'), { target: { value: 'u1' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create Peer' }))
  return dialog
}

describe('PeersPage resilient Add Peer flow', () => {
  beforeEach(() => {
    apiJsonMock.mockReset()
    apiJsonMock.mockImplementation(defaultReads)
  })

  afterEach(() => {
    cleanup()
  })

  it('sends a request_id in the create body and regenerates it for a new modal session', async () => {
    apiJsonMock.mockImplementation(async (path, init) => {
      if (path === '/api/peers' && init?.method === 'POST') {
        return { status: 'created', public_key: 'peer-pk', allowed_ip: '10.0.0.9' }
      }
      return defaultReads(path)
    })

    renderPage()
    await openAddPeer()
    await waitFor(() => expect(createCalls().length).toBe(1))

    const firstBody = postBody(createCalls()[0])
    expect(typeof firstBody.request_id).toBe('string')
    expect(firstBody.request_id.length).toBeGreaterThan(0)
    expect(firstBody).toMatchObject({
      name: 'Gary Laptop',
      server_id: 's1',
      user_id: 'u1',
      send_email: false,
    })

    // Success closes the modal; a brand-new session must not reuse the
    // previous idempotency key (its create already landed).
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await openAddPeer('Office Phone')
    await waitFor(() => expect(createCalls().length).toBe(2))
    expect(postBody(createCalls()[1]).request_id).not.toBe(firstBody.request_id)
  })

  it('reuses the same request_id when retrying after a network failure and treats the replay as success', async () => {
    let posts = 0
    apiJsonMock.mockImplementation(async (path, init) => {
      if (path === '/api/peers' && init?.method === 'POST') {
        posts += 1
        if (posts === 1) throw new TypeError('Load failed')
        // Replaying the same request_id: the backend reports the original peer.
        return { status: 'exists', public_key: 'peer-pk', allowed_ip: '10.0.0.7' }
      }
      return defaultReads(path)
    })

    renderPage()
    const dialog = await openAddPeer()

    const hint = await within(dialog).findByText(/may already have been created/i)
    expect(hint.textContent).toMatch(/no response/i)
    expect(within(dialog).getByRole('alert')).toBeTruthy()

    // Retry without reopening the modal: the deterministic id makes it a
    // replay, so no duplicate peer can be created.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Peer' }))
    await waitFor(() => expect(posts).toBe(2))
    expect(postBody(createCalls()[1]).request_id).toBe(postBody(createCalls()[0]).request_id)

    expect(await screen.findByText(/Created — peer IP 10\.0\.0\.7/)).toBeTruthy()
    expect(screen.queryByText('Load failed')).toBeNull()
  })

  it('shows the recovery hint and refetches peers when the create gets no response', async () => {
    let listCalls = 0
    apiJsonMock.mockImplementation(async (path, init) => {
      // A plain Error with the browser's network message (not a TypeError)
      // must be recognised as a lost response too.
      if (path === '/api/peers' && init?.method === 'POST') throw new Error('Failed to fetch')
      if (path === '/api/peers') {
        listCalls += 1
        // The write landed server-side: the refreshed list already has it.
        return listCalls === 1 ? [PEER] : [PEER, NEW_PEER]
      }
      return defaultReads(path)
    })

    renderPage()
    await openAddPeer()

    const hint = await screen.findByText(/may already have been created/i)
    expect(hint.textContent).toMatch(/no response/i)
    expect(hint.textContent).toMatch(/refreshed/i)
    expect(hint.textContent).toMatch(/retrying is safe/i)
    // The browser's raw failure message must never be shown as-is.
    expect(screen.queryByText('Failed to fetch')).toBeNull()

    // onError invalidates ['peers'], so the committed peer appears at once.
    await waitFor(() => expect(screen.getByText('Gary Laptop')).toBeTruthy())
    expect(listCalls).toBeGreaterThanOrEqual(2)
  })

  it('shows a positive notice for a created peer instead of the red error state', async () => {
    apiJsonMock.mockImplementation(async (path, init) => {
      if (path === '/api/peers' && init?.method === 'POST') {
        return { status: 'created', public_key: 'peer-pk', allowed_ip: '10.0.0.9' }
      }
      return defaultReads(path)
    })

    renderPage()
    await openAddPeer()

    const notice = await screen.findByText('Created — peer IP 10.0.0.9')
    expect(notice.closest('[role="status"]')).toBeTruthy()
    expect(notice.className).toMatch(/text-teal/)
    expect(notice.className).not.toMatch(/text-red/)
    // Success is not an error: no red alert, and the modal closes.
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('still shows a real API failure as a red error (not the network hint)', async () => {
    apiJsonMock.mockImplementation(async (path, init) => {
      if (path === '/api/peers' && init?.method === 'POST') {
        throw new Error('server is read-only')
      }
      return defaultReads(path)
    })

    renderPage()
    const dialog = await openAddPeer()

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toBe('server is read-only')
    expect(alert.className).toMatch(/text-red/)
  })
})
