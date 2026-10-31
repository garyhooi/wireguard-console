// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProfilePage } from '../_authenticated/profile'

// The MFA panel talks to the server exclusively through mfaClient; mock the
// whole module so these tests exercise the UI state machine, not WebAuthn.
const mfaMocks = vi.hoisted(() => ({
  getMFAStatus: vi.fn(),
  addPasskey: vi.fn(),
  addTOTP: vi.fn(),
  finishTOTP: vi.fn(),
  removePasskey: vi.fn(),
  removeTOTP: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  startPasskeyStepUp: vi.fn(),
}))
vi.mock('../../lib/mfaClient', () => mfaMocks)
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,stub') },
}))

const mePayload = {
  id: 'admin-1',
  email: 'ops@example.com',
  role: 'super_admin',
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  mfa_enabled: true,
  mfa_methods: ['totp', 'passkey'],
  passkey_count: 1,
  recovery_codes_remaining: 7,
  passkey_available: true,
  require_methods: 'any',
}

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response
}

function renderProfile() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <ProfilePage />
    </QueryClientProvider>,
  )
}

const totpFactor = {
  id: 'totp',
  type: 'totp',
  label: 'Authenticator app',
  created_at: '2026-02-01T00:00:00Z',
  usable: true,
}

function passkeyFactor(id = 'pk-1', label = 'MacBook Pro') {
  return {
    id,
    type: 'passkey',
    label,
    created_at: '2026-02-03T00:00:00Z',
    last_used_at: '2026-03-01T00:00:00Z',
    attachment: 'platform',
    backup_eligible: true,
    usable: true,
  }
}

function statusPayload(overrides: Record<string, unknown> = {}) {
  return {
    mfa_enabled: true,
    methods: ['totp', 'passkey'],
    passkey_available: true,
    require_methods: 'any',
    recovery_codes_remaining: 7,
    totp_enabled: true,
    factors: [totpFactor, passkeyFactor()],
    ...overrides,
  }
}

describe('Profile → MFA management', () => {
  beforeEach(() => {
    for (const fn of Object.values(mfaMocks)) fn.mockReset()
    mfaMocks.startPasskeyStepUp.mockResolvedValue(undefined)
    mfaMocks.getMFAStatus.mockResolvedValue(statusPayload())
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase()
        if (url.includes('/api/admins/me/sessions') && method === 'GET') {
          return jsonResponse({ sessions: [] })
        }
        if (url.includes('/api/admins/me') && method === 'GET') {
          return jsonResponse(mePayload)
        }
        throw new Error(`Unexpected request ${method} ${url}`)
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('lists enrolled factors, the recovery-code count and the summary badge', async () => {
    renderProfile()

    await screen.findByText('MacBook Pro')
    expect(screen.getByText('Authenticator app')).toBeTruthy()
    expect(screen.getByText(/7 of 10 recovery codes remaining/)).toBeTruthy()
    expect(screen.getByText(/Added .* · last used/)).toBeTruthy()
    expect(screen.getAllByText('enabled').length).toBeGreaterThan(0)
  })

  it('shows the amber enrollment banner when no factor is enrolled', async () => {
    mfaMocks.getMFAStatus.mockResolvedValue(
      statusPayload({
        mfa_enabled: false,
        methods: [],
        totp_enabled: false,
        factors: [],
        recovery_codes_remaining: 0,
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase()
        if (url.includes('/api/admins/me/sessions') && method === 'GET') {
          return jsonResponse({ sessions: [] })
        }
        if (url.includes('/api/admins/me') && method === 'GET') {
          return jsonResponse({ ...mePayload, mfa_enabled: false, mfa_methods: [], passkey_count: 0 })
        }
        throw new Error(`Unexpected request ${method} ${url}`)
      }),
    )

    renderProfile()

    await screen.findByText(/Multi-factor authentication is not set up for your account/)
    expect(screen.getByText(/Add a passkey or an authenticator app below/)).toBeTruthy()
  })

  it('disables Add passkey when the deployment cannot use passkeys', async () => {
    mfaMocks.getMFAStatus.mockResolvedValue(
      statusPayload({
        passkey_available: false,
        passkey_reason: 'This console is served from an IP address',
        factors: [totpFactor],
      }),
    )
    renderProfile()

    await screen.findByText('Authenticator app')
    const addPasskey = screen.getByRole('button', { name: /Add passkey/ }) as HTMLButtonElement
    expect(addPasskey.disabled).toBe(true)
    expect(screen.getByText(/Passkeys are unavailable on this deployment/)).toBeTruthy()
  })

  it('adds a passkey after confirming with an authenticator code', async () => {
    mfaMocks.addPasskey.mockResolvedValue(undefined)
    renderProfile()
    await screen.findByText('MacBook Pro')

    fireEvent.click(screen.getByRole('button', { name: /Add passkey/ }))
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('Authenticator or recovery code')
    fireEvent.change(input, { target: { value: '123456' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(mfaMocks.addPasskey).toHaveBeenCalledWith('123456'))
    await screen.findByText('Passkey added.')
  })

  it('explains the last-factor refusal when removing the only factor', async () => {
    mfaMocks.getMFAStatus.mockResolvedValue(
      statusPayload({ passkey_available: false, factors: [totpFactor], methods: ['totp'] }),
    )
    const refusal = Object.assign(
      new Error('Your account must have at least one factor'),
      { code: 'mfa_last_factor' },
    )
    mfaMocks.removeTOTP.mockRejectedValue(refusal)

    renderProfile()
    await screen.findByText('Authenticator app')

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Authenticator or recovery code'), {
      target: { value: '123456' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

    await within(dialog).findByText(/can't remove your last sign-in factor/)
    await waitFor(() => expect(mfaMocks.removeTOTP).toHaveBeenCalledWith('123456'))
    expect(screen.queryByText(/Authenticator app removed/)).toBeNull()
  })

  it('adds an authenticator app with a QR code and enables it with the first code', async () => {
    mfaMocks.getMFAStatus.mockResolvedValue(
      statusPayload({ totp_enabled: false, methods: ['passkey'], factors: [passkeyFactor()] }),
    )
    mfaMocks.addTOTP.mockResolvedValue({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauth_url: 'otpauth://totp/wgc:ops@example.com?secret=JBSWY3DPEHPK3PXP',
    })
    mfaMocks.finishTOTP.mockResolvedValue(undefined)

    renderProfile()
    await screen.findByText('MacBook Pro')

    fireEvent.click(screen.getByRole('button', { name: /Add authenticator app/ }))
    const stepUpDialog = await screen.findByRole('dialog')
    fireEvent.change(within(stepUpDialog).getByLabelText('Authenticator or recovery code'), {
      target: { value: '123456' },
    })
    fireEvent.click(within(stepUpDialog).getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(mfaMocks.addTOTP).toHaveBeenCalledWith('123456'))
    await screen.findByText('JBSWY3DPEHPK3PXP')
    expect(screen.getByAltText('Authenticator setup QR code')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('6-digit code from the app'), {
      target: { value: '654321' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Verify & enable' }))

    await waitFor(() =>
      expect(mfaMocks.finishTOTP).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP', '654321'),
    )
    await screen.findByText('Authenticator app added.')
  })

  it('regenerates recovery codes, shows them once, and gates Done on acknowledgement', async () => {
    const codes = [
      'AAAABBBBCCCC',
      'DDDDEEEEFFFF',
      'GGGGHHHHIIII',
      'JJJJKKKKLLLL',
      'MMMMNNNNOOOO',
      'PPPPQQQQRRRR',
      'SSSSTTTTUUUU',
      'VVVVWWWWXXXX',
      'YYYYZZZZ2345',
      '6789ABCDEFGH',
    ]
    mfaMocks.regenerateRecoveryCodes.mockResolvedValue(codes)
    renderProfile()
    await screen.findByText('MacBook Pro')

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate recovery codes' }))
    const stepUpDialog = await screen.findByRole('dialog')
    fireEvent.change(within(stepUpDialog).getByLabelText('Authenticator or recovery code'), {
      target: { value: '123456' },
    })
    fireEvent.click(within(stepUpDialog).getByRole('button', { name: 'Regenerate' }))

    await screen.findByText('Save your recovery codes')
    expect(screen.getByText('AAAABBBBCCCC')).toBeTruthy()
    const done = screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement
    expect(done.disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox'))
    expect(done.disabled).toBe(false)
    fireEvent.click(done)

    await waitFor(() => expect(screen.queryByText('Save your recovery codes')).toBeNull())
  })
})
