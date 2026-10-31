// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  navigateTo: vi.fn(),
  signOutAndRestart: vi.fn(async () => {}),
  getMFAState: vi.fn(),
  getMFAStatus: vi.fn(),
  beginTOTPEnrollment: vi.fn(),
  finishTOTPEnrollment: vi.fn(async () => {}),
  beginPasskeyEnrollment: vi.fn(),
  completePasskeyEnrollment: vi.fn(async () => {}),
  completeEnrollment: vi.fn(),
  detectWebAuthnSupport: vi.fn(async () => ({
    secureContext: true,
    hasPublicKeyCredential: true,
    platformAuthenticatorAvailable: true,
    supported: true,
  })),
  cancelCeremony: vi.fn(async () => {}),
  qrToDataURL: vi.fn(async () => 'data:image/png;base64,qr'),
}))

vi.mock('../../lib/mfaClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfaClient')>()
  return {
    ...actual,
    getMFAState: mocks.getMFAState,
    getMFAStatus: mocks.getMFAStatus,
    beginTOTPEnrollment: mocks.beginTOTPEnrollment,
    finishTOTPEnrollment: mocks.finishTOTPEnrollment,
    beginPasskeyEnrollment: mocks.beginPasskeyEnrollment,
    completePasskeyEnrollment: mocks.completePasskeyEnrollment,
    completeEnrollment: mocks.completeEnrollment,
    signOutAndRestart: mocks.signOutAndRestart,
    navigateTo: mocks.navigateTo,
  }
})

vi.mock('../../lib/webauthn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/webauthn')>()
  return {
    ...actual,
    detectWebAuthnSupport: mocks.detectWebAuthnSupport,
    cancelCeremony: mocks.cancelCeremony,
  }
})

vi.mock('qrcode', () => ({
  default: { toDataURL: mocks.qrToDataURL },
}))

import { MFASetupPage } from '../mfa-setup'
import { mfaCopy } from '../../lib/mfaCopy'

interface ApiErr extends Error {
  status?: number
  body?: unknown
}

function apiError(status: number, body: Record<string, unknown>): ApiErr {
  const err = new Error(String(body.error ?? 'Request failed')) as ApiErr
  err.status = status
  err.body = body
  return err
}

function enrollState(overrides: Record<string, unknown> = {}) {
  return {
    pending_kind: 'enroll',
    setup_methods: [],
    passkey_available: true,
    passkey_count: 0,
    recovery_codes_remaining: 0,
    expires_in_seconds: 300,
    require_methods: 'any',
    mfa_required: true,
    ...overrides,
  }
}

const RECOVERY_CODES = Array.from({ length: 10 }, (_, index) => `CODE-QQQQ-QQ${String(index).padStart(2, '0')}`)

function renderForced() {
  return render(<MFASetupPage successOverlayMs={20} />)
}

async function chooseTOTP() {
  const totpCard = await screen.findByRole('button', { name: /authenticator app/i })
  fireEvent.click(totpCard)
  const continueButton = screen.getByRole('button', { name: mfaCopy.setup.continueButton })
  await waitFor(() => expect((continueButton as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(continueButton)
}

beforeEach(() => {
  window.history.pushState({}, '', '/mfa-setup?forced=1')
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext

  mocks.navigateTo.mockReset()
  mocks.signOutAndRestart.mockReset().mockResolvedValue(undefined)
  mocks.getMFAState.mockReset()
  mocks.getMFAStatus.mockReset()
  mocks.beginTOTPEnrollment.mockReset().mockResolvedValue({
    secret: 'JBSWY3DPEHPK3PXP',
    otpauth_url: 'otpauth://totp/WireGuard:admin@example.com?secret=JBSWY3DPEHPK3PXP',
  })
  mocks.finishTOTPEnrollment.mockReset().mockResolvedValue(undefined)
  mocks.beginPasskeyEnrollment.mockReset().mockResolvedValue({
    challengeId: 'enroll-1',
    options: { challenge: 'reg' },
    rpId: 'example.com',
    expiresInSeconds: 300,
  })
  mocks.completePasskeyEnrollment.mockReset().mockResolvedValue(undefined)
  mocks.completeEnrollment.mockReset().mockResolvedValue({
    csrf_token: 'csrf-after-enroll',
    recovery_codes: RECOVERY_CODES,
  })
  mocks.detectWebAuthnSupport.mockReset().mockResolvedValue({
    secureContext: true,
    hasPublicKeyCredential: true,
    platformAuthenticatorAvailable: true,
    supported: true,
  })
  mocks.cancelCeremony.mockReset().mockResolvedValue(undefined)
  mocks.qrToDataURL.mockReset().mockResolvedValue('data:image/png;base64,qr')
})

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
  vi.clearAllMocks()
})

describe('MFASetupPage (forced enrollment)', () => {
  it('runs TOTP enrollment, policy completion and the one-time recovery-code acknowledgement', async () => {
    mocks.getMFAState.mockResolvedValue(enrollState())
    renderForced()

    expect(await screen.findByText(mfaCopy.setup.chooseTitle)).toBeTruthy()
    const continueButton = () => screen.getByRole('button', { name: mfaCopy.setup.continueButton })
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true)

    await chooseTOTP()
    expect(mocks.beginTOTPEnrollment).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeTruthy()
    expect(screen.getByAltText('Authenticator setup QR code')).toBeTruthy()

    const codeInput = screen.getByLabelText(mfaCopy.setup.totpCodeLabel) as HTMLInputElement
    fireEvent.change(codeInput, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.setup.totpVerifyButton }))
    await waitFor(() => expect(mocks.finishTOTPEnrollment).toHaveBeenCalledWith('123456'))

    expect(await screen.findByText(mfaCopy.setup.reviewTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.setup.completeButton }))
    await waitFor(() => expect(mocks.completeEnrollment).toHaveBeenCalledTimes(1))

    expect(await screen.findByText(mfaCopy.setup.recoveryTitle)).toBeTruthy()
    for (const recoveryCode of RECOVERY_CODES) {
      expect(screen.getByText(recoveryCode)).toBeTruthy()
    }
    const ack = screen.getByLabelText(mfaCopy.setup.recoveryAck) as HTMLInputElement
    const finishButton = screen.getByRole('button', {
      name: mfaCopy.setup.recoveryContinue,
    }) as HTMLButtonElement
    expect(finishButton.disabled).toBe(true)
    fireEvent.click(ack)
    expect(finishButton.disabled).toBe(false)
    fireEvent.click(finishButton)

    expect(await screen.findByText('IDENTITY VERIFIED')).toBeTruthy()
    await waitFor(() => expect(mocks.navigateTo).toHaveBeenCalledWith('/dashboard'))
  })

  it('shows both factors as required when the org policy demands both', async () => {
    mocks.getMFAState.mockResolvedValue(
      enrollState({ require_methods: 'both', setup_methods: ['totp', 'passkey'] }),
    )
    renderForced()

    expect(await screen.findByText(mfaCopy.setup.requiredBoth)).toBeTruthy()
    expect(screen.getByRole('button', { name: /passkey/i }).getAttribute('aria-pressed')).toBe('true')
    expect(
      screen.getByRole('button', { name: /authenticator app/i }).getAttribute('aria-pressed'),
    ).toBe('true')
    const continueButton = screen.getByRole('button', {
      name: mfaCopy.setup.continueButton,
    }) as HTMLButtonElement
    expect(continueButton.disabled).toBe(false)
  })

  it('renders the expired card and restarts sign-in', async () => {
    mocks.getMFAState.mockRejectedValueOnce(apiError(401, { error: 'gone', code: 'mfa_no_pending' }))
    renderForced()

    expect(await screen.findByText(mfaCopy.setup.expiredTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.common.signInAgain }))
    await waitFor(() => expect(mocks.signOutAndRestart).toHaveBeenCalledTimes(1))
  })

  it('handles an already-enabled authenticator app gracefully', async () => {
    mocks.getMFAState.mockResolvedValue(enrollState())
    mocks.beginTOTPEnrollment.mockRejectedValueOnce(
      apiError(400, { error: 'An authenticator app is already enabled', code: 'mfa_already_enabled' }),
    )
    renderForced()

    await chooseTOTP()
    const alreadyEnabled = await screen.findAllByText(mfaCopy.setup.totpAlreadyEnabled)
    expect(alreadyEnabled.length).toBeGreaterThan(0)

    // Back on the chooser: completing goes straight to review.
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.setup.continueButton }))
    expect(await screen.findByText(mfaCopy.setup.reviewTitle)).toBeTruthy()
  })

  it('disables the passkey card with the server reason when passkeys are unavailable', async () => {
    mocks.getMFAState.mockResolvedValue(
      enrollState({
        passkey_available: false,
        passkey_reason: 'Passkeys require HTTPS with a domain name',
      }),
    )
    renderForced()

    const passkeyCard = (await screen.findByRole('button', { name: /passkey/i })) as HTMLButtonElement
    expect(passkeyCard.disabled).toBe(true)
    expect(screen.getByText('Passkeys require HTTPS with a domain name')).toBeTruthy()
  })

  it('runs passkey enrollment and finishes on the review step', async () => {
    mocks.getMFAState.mockResolvedValue(enrollState())
    renderForced()

    fireEvent.click(await screen.findByRole('button', { name: /passkey/i }))
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.setup.continueButton }))

    expect(await screen.findByText(mfaCopy.setup.passkeyTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.setup.passkeyCreateButton }))
    await waitFor(() =>
      expect(mocks.completePasskeyEnrollment).toHaveBeenCalledWith('enroll-1'),
    )
    expect(await screen.findByText(mfaCopy.setup.reviewTitle)).toBeTruthy()
    expect(screen.getByText(mfaCopy.setup.reviewAdded)).toBeTruthy()
  })

  it('returns to the chooser with a policy-violation message when completion is rejected', async () => {
    mocks.getMFAState.mockResolvedValue(enrollState())
    mocks.completeEnrollment.mockRejectedValueOnce(
      apiError(409, {
        error: 'MFA policy requires more methods',
        code: 'mfa_policy_violation',
        missing_methods: ['passkey'],
      }),
    )
    renderForced()

    await chooseTOTP()
    await screen.findByText('JBSWY3DPEHPK3PXP')
    fireEvent.change(screen.getByLabelText(mfaCopy.setup.totpCodeLabel), {
      target: { value: '123456' },
    })
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.setup.totpVerifyButton }))
    await screen.findByText(mfaCopy.setup.reviewTitle)
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.setup.completeButton }))

    const policyMessages = await screen.findAllByText(mfaCopy.setup.policyViolation)
    expect(policyMessages.length).toBeGreaterThan(0)
    expect(screen.getByText(/Still required:/)).toBeTruthy()
    expect(screen.getByText(mfaCopy.setup.chooseTitle)).toBeTruthy()
  })

  it('reuses the pending TOTP secret when navigating back and forward', async () => {
    mocks.getMFAState.mockResolvedValue(enrollState())
    renderForced()

    await chooseTOTP()
    await screen.findByText('JBSWY3DPEHPK3PXP')
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.common.back }))
    await screen.findByText(mfaCopy.setup.chooseTitle)
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.setup.continueButton }))
    await screen.findByText('JBSWY3DPEHPK3PXP')
    expect(mocks.beginTOTPEnrollment).toHaveBeenCalledTimes(1)
  })
})

describe('MFASetupPage (authed landing)', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/mfa-setup')
  })

  it('shows the profile hand-off for a signed-in admin', async () => {
    mocks.getMFAStatus.mockResolvedValue({
      mfa_enabled: true,
      methods: ['totp'],
      passkey_available: true,
      require_methods: 'any',
      recovery_codes_remaining: 4,
      factors: [
        { id: 'f1', type: 'totp', label: 'Authenticator app', created_at: '2026-01-01', usable: true },
      ],
      totp_enabled: true,
    })
    render(<MFASetupPage successOverlayMs={20} />)

    expect(await screen.findByText(mfaCopy.setup.authedTitle)).toBeTruthy()
    const profileLink = screen.getByRole('link', { name: mfaCopy.setup.authedGoToProfile })
    expect(profileLink.getAttribute('href')).toBe('/profile')
  })

  it('offers sign-in when there is no session and no pending enrollment', async () => {
    mocks.getMFAStatus.mockRejectedValueOnce(apiError(401, { error: 'no session' }))
    render(<MFASetupPage successOverlayMs={20} />)

    expect(await screen.findByText(mfaCopy.setup.needsSignInTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.common.signInAgain }))
    expect(mocks.navigateTo).toHaveBeenCalledWith('/login')
  })
})
