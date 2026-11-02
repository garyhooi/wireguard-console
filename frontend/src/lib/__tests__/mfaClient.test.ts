// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ navigateTo: vi.fn() }))

const wa = vi.hoisted(() => ({
  authenticatePasskey: vi.fn(),
  registerPasskey: vi.fn(),
  unwrapPublicKey: vi.fn((value: unknown) => {
    if (value && typeof value === 'object' && 'publicKey' in (value as Record<string, unknown>)) {
      return (value as { publicKey?: unknown }).publicKey
    }
    return value
  }),
}))

vi.mock('../mfaCopy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mfaCopy')>()
  return { ...actual, navigateTo: nav.navigateTo }
})

vi.mock('../webauthn', () => ({
  authenticatePasskey: wa.authenticatePasskey,
  registerPasskey: wa.registerPasskey,
  unwrapPublicKey: wa.unwrapPublicKey,
}))

import {
  addPasskey,
  addTOTP,
  beginPasskeyEnrollment,
  beginPasskeyLogin,
  beginPasswordlessPasskey,
  beginTOTPEnrollment,
  completeEnrollment,
  completePasskeyEnrollment,
  completePasskeyLogin,
  completePasswordlessPasskey,
  finishTOTP,
  finishTOTPEnrollment,
  getMFAState,
  getMFAStatus,
  getPasskeyStatus,
  mfaErrorCode,
  mfaErrorStatus,
  mfaRetryAfterSeconds,
  regenerateRecoveryCodes,
  removePasskey,
  removeTOTP,
  renamePasskey,
  signOutAndRestart,
  startPasskeyStepUp,
  verifyRecoveryCode,
  verifyTOTP,
} from '../mfaClient'
import { getCsrfToken, setCsrfToken } from '../api'

function jsonRes(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response
}

let fetchMock: ReturnType<typeof vi.fn>

function fetchCall(index = 0) {
  const call = fetchMock.mock.calls[index] as [string, RequestInit]
  return {
    url: call[0],
    init: call[1],
    method: call[1]?.method,
    headers: new Headers(call[1]?.headers),
    body: call[1]?.body === undefined ? undefined : JSON.parse(String(call[1]?.body)),
  }
}

function pendingState() {
  return {
    pending_kind: 'verify',
    mfa_methods: ['passkey', 'totp', 'recovery_code'],
    passkey_available: true,
    passkey_count: 1,
    recovery_codes_remaining: 8,
    expires_in_seconds: 300,
    require_methods: 'any',
    mfa_required: true,
  }
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  setCsrfToken('')
  nav.navigateTo.mockReset()
  wa.authenticatePasskey.mockReset()
  wa.registerPasskey.mockReset()
  wa.unwrapPublicKey.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken('')
})

describe('pending login routes', () => {
  it('getMFAState gets /api/auth/mfa/state without CSRF', async () => {
    setCsrfToken('should-not-be-sent')
    fetchMock.mockResolvedValueOnce(jsonRes(pendingState()))
    await expect(getMFAState()).resolves.toMatchObject({ pending_kind: 'verify' })
    const call = fetchCall()
    expect(call.url).toBe('/api/auth/mfa/state')
    expect(call.method).toBe('GET')
    expect(call.headers.get('X-CSRF-Token')).toBeNull()
    expect(call.init.credentials).toBe('same-origin')
  })

  it('verifyTOTP posts the code, stores the csrf token and navigates', async () => {
    setCsrfToken('old-token')
    fetchMock.mockResolvedValueOnce(jsonRes({ csrf_token: 'fresh-token', admin: { id: 'a1' } }))
    await verifyTOTP('123456')
    const call = fetchCall()
    expect(call.url).toBe('/api/auth/mfa/totp')
    expect(call.method).toBe('POST')
    expect(call.body).toEqual({ code: '123456' })
    expect(call.headers.get('X-CSRF-Token')).toBeNull()
    expect(getCsrfToken()).toBe('fresh-token')
    expect(nav.navigateTo).toHaveBeenCalledWith('/dashboard')
  })

  it('verifyTOTP can defer navigation for the success overlay', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ csrf_token: 'fresh-token' }))
    await verifyTOTP('123456', { navigate: false })
    expect(nav.navigateTo).not.toHaveBeenCalled()
  })

  it('verifyRecoveryCode normalizes dashes/case before posting', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ csrf_token: 'c' }))
    await verifyRecoveryCode('abcd-efgh-ijkl')
    expect(fetchCall().url).toBe('/api/auth/mfa/recovery-code')
    expect(fetchCall().body).toEqual({ code: 'ABCDEFGHIJKL' })
  })

  it('beginPasskeyLogin unwraps options and completePasskeyLogin posts the credential', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonRes({
          challenge_id: 'challenge-1',
          options: { publicKey: { challenge: 'abc', rpId: 'example.com' } },
          rp_id: 'example.com',
          expires_in_seconds: 300,
        }),
      )
      .mockResolvedValueOnce(jsonRes({ csrf_token: 'csrf-passkey' }))
    wa.authenticatePasskey.mockResolvedValueOnce({ id: 'credential-1', type: 'public-key' })

    const begin = await beginPasskeyLogin()
    expect(begin.challengeId).toBe('challenge-1')
    expect(begin.options).toEqual({ challenge: 'abc', rpId: 'example.com' })
    expect(begin.rpId).toBe('example.com')
    expect(fetchCall(0).url).toBe('/api/auth/mfa/passkey/begin')

    await completePasskeyLogin('challenge-1')
    expect(wa.authenticatePasskey).toHaveBeenCalledWith({ challenge: 'abc', rpId: 'example.com' })
    expect(fetchCall(1).url).toBe('/api/auth/mfa/passkey/finish')
    expect(fetchCall(1).body).toEqual({
      challenge_id: 'challenge-1',
      credential: { id: 'credential-1', type: 'public-key' },
    })
    expect(getCsrfToken()).toBe('csrf-passkey')
    expect(nav.navigateTo).toHaveBeenCalledWith('/dashboard')
  })

  it('completePasskeyLogin refuses an unknown ceremony instead of posting', async () => {
    await expect(completePasskeyLogin('missing')).rejects.toThrow(/could not be started/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('signOutAndRestart logs out then returns to /login', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'ok' }))
    await signOutAndRestart()
    expect(fetchCall().url).toBe('/api/auth/logout')
    expect(nav.navigateTo).toHaveBeenCalledWith('/login')
  })

  it('signOutAndRestart still navigates when logout fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    await signOutAndRestart()
    expect(nav.navigateTo).toHaveBeenCalledWith('/login')
  })

  it('surfaces the structured server error code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ error: 'That code is not valid', code: 'mfa_invalid' }, 400),
    )
    const failure = verifyTOTP('000000').then(
      () => null,
      (err: unknown) => err,
    )
    const err = await failure
    expect(err).toBeInstanceOf(Error)
    expect(mfaErrorCode(err)).toBe('mfa_invalid')
    expect(mfaErrorStatus(err)).toBe(400)
  })
})

describe('forced enrollment routes', () => {
  it('beginTOTPEnrollment returns the secret', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ secret: 'JBSWY3DPEHPK3PXP', otpauth_url: 'otpauth://totp/x' }),
    )
    await expect(beginTOTPEnrollment()).resolves.toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauth_url: 'otpauth://totp/x',
    })
    expect(fetchCall().url).toBe('/api/auth/mfa/enroll/totp/begin')
    expect(fetchCall().method).toBe('POST')
  })

  it('finishTOTPEnrollment posts only the code', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'factor_added' }))
    await finishTOTPEnrollment('123456')
    expect(fetchCall().url).toBe('/api/auth/mfa/enroll/totp/finish')
    expect(fetchCall().body).toEqual({ code: '123456' })
  })

  it('completes passkey enrollment with an optional label', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonRes({ challenge_id: 'c2', options: { challenge: 'reg' }, rp_id: 'example.com' }),
      )
      .mockResolvedValueOnce(jsonRes({ status: 'factor_added' }))
    wa.registerPasskey.mockResolvedValueOnce({ id: 'new-credential' })

    const begin = await beginPasskeyEnrollment()
    expect(begin.challengeId).toBe('c2')
    await completePasskeyEnrollment('c2', 'MacBook')
    expect(fetchCall(1).url).toBe('/api/auth/mfa/enroll/passkey/finish')
    expect(fetchCall(1).body).toEqual({
      challenge_id: 'c2',
      credential: { id: 'new-credential' },
      label: 'MacBook',
    })
  })

  it('completeEnrollment stores csrf and returns recovery codes without navigating by default', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes({ csrf_token: 'enroll-csrf', recovery_codes: ['AAAA-BBBB-CCCC'] }),
    )
    const result = await completeEnrollment()
    expect(result.recovery_codes).toEqual(['AAAA-BBBB-CCCC'])
    expect(getCsrfToken()).toBe('enroll-csrf')
    expect(nav.navigateTo).not.toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce(jsonRes({ csrf_token: 'enroll-csrf' }))
    await completeEnrollment({ navigate: true })
    expect(nav.navigateTo).toHaveBeenCalledWith('/dashboard')
  })
})

describe('authed management routes', () => {
  it('getMFAStatus reads the factor list', async () => {
    const status = {
      mfa_enabled: true,
      methods: ['totp'],
      passkey_available: true,
      require_methods: 'any',
      recovery_codes_remaining: 3,
      factors: [],
      totp_enabled: true,
    }
    fetchMock.mockResolvedValueOnce(jsonRes(status))
    await expect(getMFAStatus()).resolves.toEqual(status)
    expect(fetchCall().url).toBe('/api/admins/me/mfa')
  })

  it('authed mutations attach the CSRF token', async () => {
    setCsrfToken('session-csrf')
    fetchMock.mockResolvedValueOnce(jsonRes({ secret: 's', otpauth_url: 'u' }))
    await addTOTP('123456')
    expect(fetchCall().url).toBe('/api/admins/me/mfa/totp/begin')
    expect(fetchCall().body).toEqual({ code: '123456' })
    expect(fetchCall().headers.get('X-CSRF-Token')).toBe('session-csrf')

    fetchMock.mockResolvedValueOnce(jsonRes({ status: 'factor_added' }))
    await finishTOTP('s', '123456')
    expect(fetchCall(1).body).toEqual({ code: '123456' })
  })

  it('removeTOTP / removePasskey / renamePasskey use the right verbs', async () => {
    setCsrfToken('csrf')
    fetchMock
      .mockResolvedValueOnce(jsonRes({ status: 'removed' }))
      .mockResolvedValueOnce(jsonRes({ status: 'removed' }))
      .mockResolvedValueOnce(jsonRes({ status: 'updated' }))

    await removeTOTP('111111')
    expect(fetchCall(0).url).toBe('/api/admins/me/mfa/totp/remove')
    expect(fetchCall(0).body).toEqual({ code: '111111' })

    await removePasskey('pass key/1', '222222')
    expect(fetchCall(1).url).toBe('/api/admins/me/mfa/passkeys/pass%20key%2F1')
    expect(fetchCall(1).method).toBe('DELETE')
    expect(fetchCall(1).body).toEqual({ code: '222222' })

    await renamePasskey('p1', 'Work laptop')
    expect(fetchCall(2).method).toBe('PATCH')
    expect(fetchCall(2).body).toEqual({ label: 'Work laptop' })
  })

  it('regenerateRecoveryCodes returns the new codes', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ recovery_codes: ['ONE', 'TWO'] }))
    await expect(regenerateRecoveryCodes('123456')).resolves.toEqual(['ONE', 'TWO'])
    expect(fetchCall().url).toBe('/api/admins/me/mfa/recovery-codes/regenerate')
  })

  it('addPasskey begins with the step-up code and finishes with the credential', async () => {
    setCsrfToken('csrf')
    fetchMock
      .mockResolvedValueOnce(
        jsonRes({ challenge_id: 'c3', options: { publicKey: { challenge: 'reg-2' } } }),
      )
      .mockResolvedValueOnce(jsonRes({ status: 'factor_added' }))
    wa.registerPasskey.mockResolvedValueOnce({ id: 'cred-3' })

    await addPasskey('654321', 'Phone')
    expect(fetchCall(0).url).toBe('/api/admins/me/mfa/passkeys/begin')
    expect(fetchCall(0).body).toEqual({ code: '654321' })
    expect(fetchCall(1).url).toBe('/api/admins/me/mfa/passkeys/finish')
    expect(fetchCall(1).body).toEqual({
      challenge_id: 'c3',
      credential: { id: 'cred-3' },
      label: 'Phone',
    })
  })

  it('startPasskeyStepUp runs begin + ceremony + finish', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonRes({ challenge_id: 'stepup-1', options: { challenge: 'stepup' } }),
      )
      .mockResolvedValueOnce(jsonRes({ status: 'verified', valid_for_seconds: 90 }))
    wa.authenticatePasskey.mockResolvedValueOnce({ id: 'assertion' })

    await startPasskeyStepUp()
    expect(fetchCall(0).url).toBe('/api/auth/mfa/stepup/passkey/begin')
    expect(fetchCall(1).url).toBe('/api/auth/mfa/stepup/passkey/finish')
    expect(fetchCall(1).body).toEqual({ challenge_id: 'stepup-1', credential: { id: 'assertion' } })
    expect(nav.navigateTo).not.toHaveBeenCalled()
  })
})

describe('passwordless passkey login', () => {
  it('refuses to complete without a begun ceremony', async () => {
    await expect(completePasswordlessPasskey()).rejects.toThrow(/could not be started/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('getPasskeyStatus probes the public capability endpoint without CSRF', async () => {
    setCsrfToken('should-not-be-sent')
    fetchMock.mockResolvedValueOnce(jsonRes({ passkey_available: true }))
    await expect(getPasskeyStatus()).resolves.toEqual({ passkey_available: true })
    const call = fetchCall()
    expect(call.url).toBe('/api/auth/passkey/status')
    expect(call.method).toBe('GET')
    expect(call.headers.get('X-CSRF-Token')).toBeNull()
  })

  it('beginPasswordlessPasskey posts options, unwraps them and keeps the challenge', async () => {
    setCsrfToken('should-not-be-sent')
    fetchMock.mockResolvedValueOnce(
      jsonRes({
        challenge_id: 'pw-1',
        options: { publicKey: { challenge: 'abc', rpId: 'example.com', allowCredentials: [] } },
        rp_id: 'example.com',
        expires_in_seconds: 300,
      }),
    )
    const begin = await beginPasswordlessPasskey()
    expect(begin.challengeId).toBe('pw-1')
    expect(begin.options).toEqual({ challenge: 'abc', rpId: 'example.com', allowCredentials: [] })
    expect(begin.rpId).toBe('example.com')
    const call = fetchCall()
    expect(call.url).toBe('/api/auth/passkey/options')
    expect(call.method).toBe('POST')
    expect(call.headers.get('X-CSRF-Token')).toBeNull()
  })

  it('completePasswordlessPasskey posts the assertion, stores csrf and navigates', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonRes({ challenge_id: 'pw-2', options: { challenge: 'def' }, rp_id: 'example.com' }),
      )
      .mockResolvedValueOnce(jsonRes({ csrf_token: 'pw-csrf' }))
    wa.authenticatePasskey.mockResolvedValueOnce({ id: 'assertion-1', type: 'public-key' })

    await beginPasswordlessPasskey()
    await completePasswordlessPasskey()

    expect(wa.authenticatePasskey).toHaveBeenCalledWith({ challenge: 'def' })
    expect(fetchCall(1).url).toBe('/api/auth/passkey/finish')
    expect(fetchCall(1).body).toEqual({
      challenge_id: 'pw-2',
      credential: { id: 'assertion-1', type: 'public-key' },
    })
    expect(getCsrfToken()).toBe('pw-csrf')
    expect(nav.navigateTo).toHaveBeenCalledWith('/dashboard')
  })

  it('completePasswordlessPasskey can defer navigation for the success overlay', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ challenge_id: 'pw-3', options: { challenge: 'ghi' } }))
      .mockResolvedValueOnce(jsonRes({ csrf_token: 'pw-csrf' }))
    wa.authenticatePasskey.mockResolvedValueOnce({ id: 'assertion-2' })

    await beginPasswordlessPasskey()
    await completePasswordlessPasskey({ navigate: false })
    expect(nav.navigateTo).not.toHaveBeenCalled()
  })

  it('propagates mfa_unavailable from the options endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(
        { error: 'Passkeys are not available on this console', code: 'mfa_unavailable' },
        409,
      ),
    )
    const err = await beginPasswordlessPasskey().then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(mfaErrorCode(err)).toBe('mfa_unavailable')
    expect(mfaErrorStatus(err)).toBe(409)
  })
})

describe('error helpers', () => {
  it('reads the code from ApiError-like objects and raw bodies', () => {
    expect(mfaErrorCode({ code: 'mfa_locked' })).toBe('mfa_locked')
    expect(mfaErrorCode({ body: { code: 'mfa_invalid' } })).toBe('mfa_invalid')
    expect(mfaErrorCode(new Error('plain'))).toBeUndefined()
    expect(mfaErrorCode(null)).toBeUndefined()
  })

  it('reads status and retry_after_seconds', () => {
    expect(mfaErrorStatus({ status: 429 })).toBe(429)
    expect(mfaErrorStatus(new Error('x'))).toBeUndefined()
    expect(mfaRetryAfterSeconds({ retryAfterSeconds: 3 })).toBe(3)
    expect(mfaRetryAfterSeconds({ body: { retry_after_seconds: 12 } })).toBe(12)
    expect(mfaRetryAfterSeconds({ body: {} })).toBeUndefined()
  })
})
