// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  navigateTo: vi.fn(),
  signOutAndRestart: vi.fn(async () => {}),
  getMFAState: vi.fn(),
  verifyTOTP: vi.fn(async () => {}),
  verifyRecoveryCode: vi.fn(async () => {}),
  beginPasskeyLogin: vi.fn(),
  completePasskeyLogin: vi.fn(async () => {}),
  detectWebAuthnSupport: vi.fn(async (): Promise<{
    secureContext: boolean
    hasPublicKeyCredential: boolean
    platformAuthenticatorAvailable: boolean | null
    supported: boolean
  }> => ({
    secureContext: true,
    hasPublicKeyCredential: true,
    platformAuthenticatorAvailable: true,
    supported: true,
  })),
  cancelCeremony: vi.fn(async () => {}),
}))

vi.mock('../../lib/mfaClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/mfaClient')>()
  return {
    ...actual,
    getMFAState: mocks.getMFAState,
    verifyTOTP: mocks.verifyTOTP,
    verifyRecoveryCode: mocks.verifyRecoveryCode,
    beginPasskeyLogin: mocks.beginPasskeyLogin,
    completePasskeyLogin: mocks.completePasskeyLogin,
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

import { MFAVerifyPage } from '../mfa-verify'
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

function verifyState(overrides: Record<string, unknown> = {}) {
  return {
    pending_kind: 'verify',
    mfa_methods: ['passkey', 'totp', 'recovery_code'],
    passkey_available: true,
    passkey_count: 1,
    recovery_codes_remaining: 8,
    expires_in_seconds: 300,
    require_methods: 'any',
    mfa_required: true,
    ...overrides,
  }
}

function renderPage() {
  return render(<MFAVerifyPage successOverlayMs={20} />)
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext
  mocks.navigateTo.mockReset()
  mocks.signOutAndRestart.mockReset().mockResolvedValue(undefined)
  mocks.getMFAState.mockReset()
  mocks.verifyTOTP.mockReset().mockResolvedValue(undefined)
  mocks.verifyRecoveryCode.mockReset().mockResolvedValue(undefined)
  mocks.beginPasskeyLogin.mockReset()
  mocks.completePasskeyLogin.mockReset().mockResolvedValue(undefined)
  mocks.detectWebAuthnSupport.mockReset().mockResolvedValue({
    secureContext: true,
    hasPublicKeyCredential: true,
    platformAuthenticatorAvailable: true,
    supported: true,
  })
  mocks.cancelCeremony.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MFAVerifyPage', () => {
  it('probes the pending state and renders passkey, TOTP and recovery options', async () => {
    mocks.getMFAState.mockResolvedValue(verifyState())
    renderPage()

    expect(await screen.findByRole('button', { name: 'Use a passkey' })).toBeTruthy()
    expect(screen.getByLabelText(mfaCopy.verify.totpLabel)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Use a recovery code' })).toBeTruthy()
    expect(mocks.getMFAState).toHaveBeenCalledTimes(1)
  })

  it('verifies a TOTP code, shows the success overlay and hard-navigates to the dashboard', async () => {
    mocks.getMFAState.mockResolvedValue(verifyState())
    renderPage()

    const input = await screen.findByLabelText(mfaCopy.verify.totpLabel)
    fireEvent.change(input, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.verify.verifyButton }))

    await waitFor(() => expect(mocks.verifyTOTP).toHaveBeenCalledWith('123456', { navigate: false }))
    expect(await screen.findByText('IDENTITY VERIFIED')).toBeTruthy()
    await waitFor(() => expect(mocks.navigateTo).toHaveBeenCalledWith('/dashboard'))
  })

  it('shows an inline error and clears the input for an invalid code', async () => {
    mocks.getMFAState.mockResolvedValue(verifyState())
    mocks.verifyTOTP.mockRejectedValueOnce(apiError(400, { error: 'That code is not valid', code: 'mfa_invalid' }))
    renderPage()

    const input = (await screen.findByLabelText(mfaCopy.verify.totpLabel)) as HTMLInputElement
    fireEvent.change(input, { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.verify.verifyButton }))

    expect(await screen.findByText(mfaCopy.verify.invalidCode)).toBeTruthy()
    expect(input.value).toBe('')
    expect(mocks.navigateTo).not.toHaveBeenCalled()
  })

  it('shows the lockout countdown on 429', async () => {
    mocks.getMFAState.mockResolvedValue(verifyState())
    mocks.verifyTOTP.mockRejectedValueOnce(
      apiError(429, { error: 'Too many attempts', code: 'mfa_locked', retry_after_seconds: 3 }),
    )
    renderPage()

    const input = await screen.findByLabelText(mfaCopy.verify.totpLabel)
    fireEvent.change(input, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.verify.verifyButton }))

    expect(await screen.findByText('TOO MANY ATTEMPTS')).toBeTruthy()
    expect(screen.getByTestId('lockout-remaining').textContent).toBe('0:03')
  })

  it('renders the expired card when the pending challenge is gone and restarts sign-in', async () => {
    mocks.getMFAState.mockRejectedValueOnce(apiError(401, { error: 'gone', code: 'mfa_no_pending' }))
    renderPage()

    expect(await screen.findByText(mfaCopy.verify.expiredTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.common.signInAgain }))
    await waitFor(() => expect(mocks.signOutAndRestart).toHaveBeenCalledTimes(1))
  })

  it('renders the disabled-account card on 403', async () => {
    mocks.getMFAState.mockRejectedValueOnce(apiError(403, { error: 'Account is disabled' }))
    renderPage()

    expect(await screen.findByText(mfaCopy.verify.disabledTitle)).toBeTruthy()
    expect(screen.getByText('Account is disabled')).toBeTruthy()
  })

  it('keeps TOTP available after the passkey prompt is dismissed', async () => {
    mocks.getMFAState.mockResolvedValue(verifyState())
    mocks.beginPasskeyLogin.mockResolvedValueOnce({
      challengeId: 'c1',
      options: {},
      rpId: 'example.com',
      expiresInSeconds: 300,
    })
    const cancelled = new Error('The operation was cancelled') as Error & { name: string }
    cancelled.name = 'NotAllowedError'
    mocks.completePasskeyLogin.mockRejectedValueOnce(cancelled)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: mfaCopy.verify.passkeyButton }))
    expect(await screen.findByText(mfaCopy.verify.passkeyCancelled)).toBeTruthy()
    expect(screen.getByLabelText(mfaCopy.verify.totpLabel)).toBeTruthy()
  })

  it('completes a passkey login and navigates after the success overlay', async () => {
    mocks.getMFAState.mockResolvedValue(verifyState())
    mocks.beginPasskeyLogin.mockResolvedValueOnce({
      challengeId: 'c1',
      options: {},
      rpId: 'example.com',
      expiresInSeconds: 300,
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: mfaCopy.verify.passkeyButton }))
    await waitFor(() =>
      expect(mocks.completePasskeyLogin).toHaveBeenCalledWith('c1', { navigate: false }),
    )
    expect(await screen.findByText('IDENTITY VERIFIED')).toBeTruthy()
    await waitFor(() => expect(mocks.navigateTo).toHaveBeenCalledWith('/dashboard'))
  })

  it('disables the passkey button with a reason when this browser has no WebAuthn', async () => {
    mocks.getMFAState.mockResolvedValue(verifyState())
    mocks.detectWebAuthnSupport.mockResolvedValueOnce({
      secureContext: false,
      hasPublicKeyCredential: false,
      platformAuthenticatorAvailable: null,
      supported: false,
    })
    renderPage()

    const passkeyButton = (await screen.findByRole('button', {
      name: mfaCopy.verify.passkeyButton,
    })) as HTMLButtonElement
    expect(passkeyButton.disabled).toBe(true)
    expect(screen.getByText(mfaCopy.webauthnErrors.insecure_context)).toBeTruthy()
    expect(screen.getByLabelText(mfaCopy.verify.totpLabel)).toBeTruthy()
  })

  it('blocks a passkey-only account in an unsupported browser', async () => {
    mocks.getMFAState.mockResolvedValue(
      verifyState({ mfa_methods: ['passkey'], recovery_codes_remaining: 0 }),
    )
    mocks.detectWebAuthnSupport.mockResolvedValueOnce({
      secureContext: true,
      hasPublicKeyCredential: false,
      platformAuthenticatorAvailable: null,
      supported: false,
    })
    renderPage()

    expect(await screen.findByText(mfaCopy.verify.passkeyBlocked)).toBeTruthy()
    expect(screen.queryByLabelText(mfaCopy.verify.totpLabel)).toBeNull()
  })

  it('accepts a recovery code with dashes and lower case', async () => {
    mocks.getMFAState.mockResolvedValue(verifyState())
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: mfaCopy.verify.useRecovery }))
    const input = screen.getByLabelText(mfaCopy.verify.recoveryLabel)
    fireEvent.change(input, { target: { value: 'abcd-efgh-ijkl' } })
    fireEvent.click(screen.getByRole('button', { name: mfaCopy.verify.recoverySubmit }))

    await waitFor(() =>
      expect(mocks.verifyRecoveryCode).toHaveBeenCalledWith('ABCDEFGHIJKL', { navigate: false }),
    )
    expect(await screen.findByText('IDENTITY VERIFIED')).toBeTruthy()
  })

  it('hides the recovery-code option for accounts without recovery codes', async () => {
    mocks.getMFAState.mockResolvedValue(
      verifyState({ mfa_methods: ['totp'], recovery_codes_remaining: 0 }),
    )
    renderPage()

    await screen.findByLabelText(mfaCopy.verify.totpLabel)
    expect(screen.queryByRole('button', { name: mfaCopy.verify.useRecovery })).toBeNull()
    expect(screen.queryByRole('button', { name: mfaCopy.verify.passkeyButton })).toBeNull()
  })
})
