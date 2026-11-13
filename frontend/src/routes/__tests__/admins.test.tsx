// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AdminsPage } from '../_authenticated/admins'

// ConfirmMFA (rendered by the page) resolves passkey availability itself only
// when the page omits the prop; the page always passes it, but mock the module
// so no fetch/WebAuthn path can leak into these tests.
const mfaMocks = vi.hoisted(() => ({
  getMFAStatus: vi.fn(),
  startPasskeyStepUp: vi.fn(),
}))
vi.mock('../../lib/mfaClient', () => mfaMocks)

const me = {
  id: 'admin-me',
  email: 'me@example.com',
  role: 'super_admin',
  passkey_available: true,
  passkey_count: 1,
}

const admins = [
  {
    id: 'admin-me',
    email: 'me@example.com',
    role: 'super_admin',
    totp_enabled: true,
    mfa_enabled: true,
    mfa_methods: ['passkey', 'totp'],
    passkey_count: 1,
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'admin-other',
    email: 'other@example.com',
    role: 'admin',
    totp_enabled: true,
    mfa_enabled: true,
    mfa_methods: ['passkey', 'totp'],
    passkey_count: 2,
    status: 'active',
    created_at: '2026-01-02T00:00:00Z',
  },
  {
    id: 'admin-nopk',
    email: 'plain@example.com',
    role: 'admin',
    totp_enabled: true,
    mfa_enabled: true,
    mfa_methods: ['totp'],
    passkey_count: 0,
    status: 'active',
    created_at: '2026-01-03T00:00:00Z',
  },
]

interface FetchCall {
  url: string
  init?: RequestInit
}

function jsonRes(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response
}

/** Non-2xx envelope: apiJson reads text() so code/body survive into ApiError. */
function errRes(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  const body = { error, ...extra }
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

let calls: FetchCall[] = []

/** Stub the API: GETs plus a PATCH handler receiving (body, patchIndex). */
function stubFetch(patch: (body: Record<string, unknown>, index: number) => Response) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/config/step-up') && method === 'GET') {
        // Grace window off: gated saves open ConfirmMFA immediately.
        return jsonRes({ step_up_minutes: 0 })
      }
      if (url.includes('/api/admins/me') && method === 'GET') {
        return jsonRes(me)
      }
      if (url === '/api/admins' && method === 'GET') {
        return jsonRes(admins)
      }
      if (/^\/api\/admins\/[^/]+$/.test(url) && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        const index = calls.filter((c) => (c.init?.method ?? 'GET').toUpperCase() === 'PATCH').length - 1
        return patch(body, index)
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }),
  )
}

function patchBodies(): Record<string, unknown>[] {
  return calls
    .filter((c) => (c.init?.method ?? 'GET').toUpperCase() === 'PATCH')
    .map((c) => JSON.parse(String(c.init?.body ?? '{}')) as Record<string, unknown>)
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <AdminsPage />
    </QueryClientProvider>,
  )
}

/** Open the inline email editor for a row and return its input. */
async function openEmailEditor(email: string): Promise<HTMLInputElement> {
  fireEvent.click(await screen.findByRole('button', { name: `Edit email for ${email}` }))
  return (await screen.findByDisplayValue(email)) as HTMLInputElement
}

/** Type a new email and press the row's Save button. */
async function editAndSave(current: string, next: string) {
  const input = await openEmailEditor(current)
  fireEvent.change(input, { target: { value: next } })
  fireEvent.click(screen.getByRole('button', { name: 'Save email' }))
}

/** Fill the ConfirmMFA step-up modal with a code and confirm. */
async function submitStepUpCode(code = '123456') {
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('Authenticator or recovery code'), {
    target: { value: code },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
}

const confirmPanel = () => screen.getByTestId('passkey-reset-confirm')

describe('Admins → email change passkey reset', () => {
  beforeEach(() => {
    mfaMocks.getMFAStatus.mockReset()
    mfaMocks.startPasskeyStepUp.mockReset()
    // All PATCHes succeed without resetting unless a test overrides it.
    stubFetch(() => jsonRes({ status: 'updated' }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('warns only for passkey-holding admins whose draft email changed', async () => {
    renderPage()

    // Other admin, 2 passkeys: no warning until the draft differs.
    const input = await openEmailEditor('other@example.com')
    expect(screen.queryByTestId('passkey-reset-warning')).toBeNull()

    fireEvent.change(input, { target: { value: 'new-other@example.com' } })
    expect(screen.getByTestId('passkey-reset-warning').textContent).toBe(
      "Saving resets this admin's 2 passkeys. They'll need to add a new passkey after this; authenticator app and recovery codes keep working.",
    )

    // Reverting the draft hides it again.
    fireEvent.change(input, { target: { value: 'other@example.com' } })
    expect(screen.queryByTestId('passkey-reset-warning')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))

    // Self, 1 passkey: singular + self copy.
    const selfInput = await openEmailEditor('me@example.com')
    fireEvent.change(selfInput, { target: { value: 'new-me@example.com' } })
    expect(screen.getByTestId('passkey-reset-warning').textContent).toBe(
      'Saving resets your 1 passkey. Add a new passkey in Profile afterwards; authenticator app and recovery codes keep working.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }))

    // No passkeys: no warning at all.
    const plainInput = await openEmailEditor('plain@example.com')
    fireEvent.change(plainInput, { target: { value: 'new-plain@example.com' } })
    expect(screen.queryByTestId('passkey-reset-warning')).toBeNull()
  })

  it('shows an explicit inline confirmation on Save and Cancel keeps the row editing', async () => {
    renderPage()
    await editAndSave('other@example.com', 'new-other@example.com')

    // Explicit confirmation, no API call yet.
    await screen.findByTestId('passkey-reset-confirm')
    expect(patchBodies()).toHaveLength(0)
    const panel = confirmPanel()
    expect(within(panel).getByText('Reset passkeys and change email?')).toBeTruthy()
    expect(within(panel).getByText(/Saving resets this admin's 2 passkeys/)).toBeTruthy()
    expect(within(panel).getByText('Their other sessions will be signed out.')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Reset passkeys & save' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Cancel' })).toBeTruthy()

    // Cancel closes the panel but keeps the row in edit mode with the draft.
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('passkey-reset-confirm')).toBeNull())
    expect((screen.getByDisplayValue('new-other@example.com') as HTMLInputElement).value).toBe(
      'new-other@example.com',
    )
    expect(patchBodies()).toHaveLength(0)
  })

  it('sends reset_passkeys:true only after the explicit confirmation', async () => {
    stubFetch(() =>
      jsonRes({ status: 'updated', passkeys_reset: true, passkey_count: 2 }),
    )
    renderPage()
    await editAndSave('other@example.com', 'new-other@example.com')
    fireEvent.click(
      within(await screen.findByTestId('passkey-reset-confirm')).getByRole('button', {
        name: 'Reset passkeys & save',
      }),
    )

    // Only now does the MFA step-up open; the PATCH carries the reset flag.
    await submitStepUpCode()
    await waitFor(() =>
      expect(patchBodies()).toEqual([
        { email: 'new-other@example.com', code: '123456', reset_passkeys: true },
      ]),
    )
    await screen.findByText(
      'Email updated and 2 passkeys reset — new-other@example.com will need to add a new passkey.',
    )
    // Editor closed after success.
    expect(screen.queryByRole('button', { name: 'Save email' })).toBeNull()
  })

  it('handles a stale-count 409 passkeys_will_reset: confirmation, then retry with the flag', async () => {
    stubFetch((body, index) => {
      if (index === 0) {
        return errRes(409, "Changing this admin's email resets their passkeys. Confirm to continue.", {
          code: 'passkeys_will_reset',
          passkey_count: 2,
        })
      }
      return jsonRes({ status: 'updated', passkeys_reset: true, passkey_count: 2 })
    })
    renderPage()

    // The row says 0 passkeys (stale) so Save goes straight to the step-up.
    await editAndSave('plain@example.com', 'new-plain@example.com')
    await submitStepUpCode()

    // The server's 409 reopens the row with the inline confirmation,
    // using the count from the error (2, not the stale 0).
    const panel = await screen.findByTestId('passkey-reset-confirm')
    expect(within(panel).getByText(/Saving resets this admin's 2 passkeys/)).toBeTruthy()
    expect(patchBodies()[0]).toEqual({ email: 'new-plain@example.com', code: '123456' })
    expect(patchBodies()[0].reset_passkeys).toBeUndefined()
    // No transient red error — the actionable confirmation replaces it.
    expect(screen.queryByText(/Changing this admin's email resets their passkeys/)).toBeNull()

    fireEvent.click(within(panel).getByRole('button', { name: 'Reset passkeys & save' }))
    await submitStepUpCode('654321')

    await waitFor(() => expect(patchBodies()).toHaveLength(2))
    expect(patchBodies()[1]).toEqual({
      email: 'new-plain@example.com',
      code: '654321',
      reset_passkeys: true,
    })
    await screen.findByText(/Email updated and 2 passkeys reset/)
  })

  it('uses the self copy and notice when changing your own email with passkeys', async () => {
    stubFetch(() => jsonRes({ status: 'updated', passkeys_reset: true, passkey_count: 1 }))
    renderPage()
    await editAndSave('me@example.com', 'new-me@example.com')

    const panel = await screen.findByTestId('passkey-reset-confirm')
    expect(within(panel).getByText(/Saving resets your 1 passkey/)).toBeTruthy()
    expect(within(panel).getByText('Your other sessions will be signed out.')).toBeTruthy()

    fireEvent.click(within(panel).getByRole('button', { name: 'Reset passkeys & save' }))
    await submitStepUpCode()

    await waitFor(() =>
      expect(patchBodies()).toEqual([
        { email: 'new-me@example.com', code: '123456', reset_passkeys: true },
      ]),
    )
    await screen.findByText(
      'Your email was updated and your passkeys were reset — add a new passkey in Profile.',
    )
  })

  it('keeps today’s flow for admins without passkeys (no confirmation, no flag)', async () => {
    renderPage()
    await editAndSave('plain@example.com', 'new-plain@example.com')

    // No inline confirmation: straight to the MFA step-up modal.
    expect(screen.queryByTestId('passkey-reset-confirm')).toBeNull()
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/change plain@example.com's email to new-plain@example.com/)).toBeTruthy()

    await submitStepUpCode()
    await waitFor(() =>
      expect(patchBodies()).toEqual([{ email: 'new-plain@example.com', code: '123456' }]),
    )
    expect(patchBodies()[0].reset_passkeys).toBeUndefined()
    await screen.findByText('Email updated.')
  })
})
