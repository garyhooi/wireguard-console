// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lib = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  platformAuthenticatorIsAvailable: vi.fn(),
  cancelCeremony: vi.fn(),
}))

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: lib.startRegistration,
  startAuthentication: lib.startAuthentication,
  platformAuthenticatorIsAvailable: lib.platformAuthenticatorIsAvailable,
  WebAuthnAbortService: {
    cancelCeremony: lib.cancelCeremony,
    createNewAbortSignal: () => new AbortController().signal,
  },
}))

import {
  _resetWebAuthnSupportForTests,
  authenticatePasskey,
  passwordlessPasskeyErrorMessage,
  cancelCeremony,
  detectWebAuthnSupport,
  isWebAuthnCancel,
  registerPasskey,
  unwrapPublicKey,
  webAuthnErrorKey,
  webAuthnErrorMessage,
  webAuthnUnavailableMessage,
  WebAuthnUnsupportedError,
} from '../webauthn'
import { mfaCopy } from '../mfaCopy'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser'

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value })
}

function setPublicKeyCredential(value: unknown) {
  Object.defineProperty(window, 'PublicKeyCredential', {
    configurable: true,
    writable: true,
    value,
  })
}

function fakeCredential() {
  return { id: 'cred-1', type: 'public-key' }
}

describe('detectWebAuthnSupport', () => {
  beforeEach(() => {
    _resetWebAuthnSupportForTests()
    lib.platformAuthenticatorIsAvailable.mockResolvedValue(true)
  })

  afterEach(() => {
    _resetWebAuthnSupportForTests()
    delete (window as unknown as Record<string, unknown>).PublicKeyCredential
    delete (window as unknown as Record<string, unknown>).isSecureContext
    vi.clearAllMocks()
  })

  it('reports supported on a secure context with PublicKeyCredential', async () => {
    setSecureContext(true)
    setPublicKeyCredential(function FakePublicKeyCredential() {})
    const support = await detectWebAuthnSupport()
    expect(support).toEqual({
      secureContext: true,
      hasPublicKeyCredential: true,
      platformAuthenticatorAvailable: true,
      supported: true,
    })
    expect(lib.platformAuthenticatorIsAvailable).toHaveBeenCalledTimes(1)
  })

  it('reports unsupported without PublicKeyCredential', async () => {
    setSecureContext(true)
    const support = await detectWebAuthnSupport()
    expect(support.supported).toBe(false)
    expect(support.hasPublicKeyCredential).toBe(false)
    expect(lib.platformAuthenticatorIsAvailable).not.toHaveBeenCalled()
    expect(webAuthnUnavailableMessage(support)).toBe(mfaCopy.webauthnErrors.unsupported)
  })

  it('reports an insecure context (IP-only deployment) without probing', async () => {
    setSecureContext(false)
    setPublicKeyCredential(function FakePublicKeyCredential() {})
    const support = await detectWebAuthnSupport()
    expect(support.supported).toBe(false)
    expect(support.secureContext).toBe(false)
    expect(webAuthnUnavailableMessage(support)).toBe(mfaCopy.webauthnErrors.insecure_context)
  })

  it('caches the result until forced', async () => {
    setSecureContext(true)
    setPublicKeyCredential(function FakePublicKeyCredential() {})
    await detectWebAuthnSupport()
    await detectWebAuthnSupport()
    expect(lib.platformAuthenticatorIsAvailable).toHaveBeenCalledTimes(1)
    await detectWebAuthnSupport(true)
    expect(lib.platformAuthenticatorIsAvailable).toHaveBeenCalledTimes(2)
  })

  it('leaves platform availability unknown when the probe rejects', async () => {
    setSecureContext(true)
    setPublicKeyCredential(function FakePublicKeyCredential() {})
    lib.platformAuthenticatorIsAvailable.mockRejectedValueOnce(new Error('nope'))
    const support = await detectWebAuthnSupport()
    expect(support.supported).toBe(true)
    expect(support.platformAuthenticatorAvailable).toBeNull()
    expect(webAuthnUnavailableMessage(support)).toBeUndefined()
  })
})

describe('unwrapPublicKey', () => {
  it('returns the inner options object unchanged when unwrapped', () => {
    const options = { challenge: 'abc', rpId: 'example.com' }
    expect(unwrapPublicKey(options)).toBe(options)
  })

  it('unwraps the legacy { publicKey } wrapper', () => {
    const inner = { challenge: 'abc', rp: { id: 'example.com' } }
    expect(unwrapPublicKey({ publicKey: inner })).toBe(inner)
  })

  it('does not unwrap unrelated shapes', () => {
    const value = { challenge: 'abc', publicKey: 'not-an-object' }
    expect(unwrapPublicKey(value)).toBe(value)
  })
})

describe('registerPasskey / authenticatePasskey', () => {
  beforeEach(() => {
    _resetWebAuthnSupportForTests()
    lib.platformAuthenticatorIsAvailable.mockResolvedValue(true)
    setSecureContext(true)
    setPublicKeyCredential(function FakePublicKeyCredential() {})
  })

  afterEach(() => {
    _resetWebAuthnSupportForTests()
    delete (window as unknown as Record<string, unknown>).PublicKeyCredential
    delete (window as unknown as Record<string, unknown>).isSecureContext
    vi.clearAllMocks()
  })

  it('dynamically imports the library and passes the inner optionsJSON', async () => {
    const options = {
      challenge: 'creation-challenge',
      rp: { id: 'example.com', name: 'wgc' },
    } as unknown as PublicKeyCredentialCreationOptionsJSON
    lib.startRegistration.mockResolvedValue(fakeCredential())
    await expect(registerPasskey({ publicKey: options })).resolves.toEqual(fakeCredential())
    expect(lib.startRegistration).toHaveBeenCalledWith({ optionsJSON: options })
  })

  it('runs the authentication ceremony with request options', async () => {
    const options = { challenge: 'request-challenge', rpId: 'example.com' }
    lib.startAuthentication.mockResolvedValue(fakeCredential())
    await expect(authenticatePasskey(options)).resolves.toEqual(fakeCredential())
    expect(lib.startAuthentication).toHaveBeenCalledWith({ optionsJSON: options })
  })

  it('throws WebAuthnUnsupportedError instead of starting a ceremony when unsupported', async () => {
    setSecureContext(false)
    await expect(registerPasskey({})).rejects.toBeInstanceOf(WebAuthnUnsupportedError)
    await expect(authenticatePasskey({})).rejects.toBeInstanceOf(WebAuthnUnsupportedError)
    expect(lib.startRegistration).not.toHaveBeenCalled()
    expect(lib.startAuthentication).not.toHaveBeenCalled()
  })

  it('cancelCeremony forwards to the library abort service', async () => {
    await cancelCeremony()
    expect(lib.cancelCeremony).toHaveBeenCalledTimes(1)
  })
})

describe('webAuthnErrorKey / webauthnErrorMessage', () => {
  it.each([
    [{ code: 'ERROR_INVALID_RP_ID' }, 'rp_id_mismatch'],
    [{ code: 'ERROR_INVALID_DOMAIN' }, 'invalid_domain'],
    [{ code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' }, 'already_registered'],
    [{ code: 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG' }, 'unsupported_algorithm'],
    [{ code: 'ERROR_MALFORMED_PUBKEYCREDPARAMS' }, 'malformed_options'],
    [{ code: 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT' }, 'missing_user_verification'],
    [{ code: 'ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE' }, 'missing_user_verification'],
    [
      { code: 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT' },
      'missing_discoverable_credential',
    ],
    [{ code: 'ERROR_AUTHENTICATOR_GENERAL_ERROR' }, 'general_error'],
    [{ code: 'ERROR_INVALID_USER_ID_LENGTH' }, 'invalid_user_id'],
    [{ code: 'ERROR_CEREMONY_ABORTED' }, 'ceremony_aborted'],
    [{ name: 'AbortError' }, 'ceremony_aborted'],
    [{ name: 'NotAllowedError' }, 'cancelled_or_timeout'],
    [
      { code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', cause: { name: 'NotAllowedError' } },
      'cancelled_or_timeout',
    ],
    [{ name: 'SecurityError' }, 'invalid_domain'],
    [{ name: 'InvalidStateError' }, 'already_registered'],
    [{ name: 'NotSupportedError' }, 'unsupported_algorithm'],
    [{ name: 'UnknownError' }, 'general_error'],
  ])('maps %j to %s', (err, key) => {
    expect(webAuthnErrorKey(err)).toBe(key)
    expect(webAuthnErrorMessage(err)).toBe(
      (mfaCopy.webauthnErrors as Record<string, string>)[key],
    )
  })

  it('maps our own unsupported error', () => {
    expect(webAuthnErrorKey(new WebAuthnUnsupportedError())).toBe('unsupported')
    expect(webAuthnErrorMessage(new WebAuthnUnsupportedError())).toBe(
      mfaCopy.webauthnErrors.unsupported,
    )
  })

  it('returns undefined/empty copy for an unknown error', () => {
    expect(webAuthnErrorKey(new Error('boom'))).toBeUndefined()
    expect(webAuthnErrorMessage(new Error('boom'))).toBe('')
    expect(webAuthnErrorKey(null)).toBeUndefined()
  })

  it('treats cancels and aborts as user non-errors', () => {
    expect(isWebAuthnCancel({ name: 'NotAllowedError' })).toBe(true)
    expect(isWebAuthnCancel({ code: 'ERROR_CEREMONY_ABORTED' })).toBe(true)
    expect(isWebAuthnCancel({ code: 'ERROR_INVALID_RP_ID' })).toBe(false)
    expect(isWebAuthnCancel(new Error('boom'))).toBe(false)
  })
})

describe('passwordlessPasskeyErrorMessage', () => {
  it('uses the gentle hint for a dismissed or timed-out prompt', () => {
    expect(passwordlessPasskeyErrorMessage({ name: 'NotAllowedError' })).toBe(
      mfaCopy.login.passkeyCancelled,
    )
    expect(
      passwordlessPasskeyErrorMessage({
        code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
        cause: { name: 'NotAllowedError' },
      }),
    ).toBe(mfaCopy.login.passkeyCancelled)
  })

  it('collapses other failures to the short password fallback', () => {
    expect(passwordlessPasskeyErrorMessage({ code: 'ERROR_INVALID_RP_ID' })).toBe(
      mfaCopy.login.passkeyFailed,
    )
    expect(passwordlessPasskeyErrorMessage(new WebAuthnUnsupportedError())).toBe(
      mfaCopy.login.passkeyFailed,
    )
    expect(passwordlessPasskeyErrorMessage(new Error('boom'))).toBe(mfaCopy.login.passkeyFailed)
  })

  it('stays silent for aborted ceremonies (route change / unmount)', () => {
    expect(passwordlessPasskeyErrorMessage({ code: 'ERROR_CEREMONY_ABORTED' })).toBe('')
    expect(passwordlessPasskeyErrorMessage({ name: 'AbortError' })).toBe('')
  })
})
