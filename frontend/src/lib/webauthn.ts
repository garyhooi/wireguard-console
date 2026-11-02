/**
 * Browser WebAuthn / passkey integration for the MFA flows.
 *
 * Design notes:
 *  - @simplewebauthn/browser is imported DYNAMICALLY (only when a ceremony
 *    actually starts) so the login bundle stays small and a broken/blocked
 *    chunk cannot break the password screen.
 *  - Feature detection never throws: an IP-only deployment (plain HTTP on an
 *    IP, no secure context) simply reports passkeys as unavailable and the
 *    pages fall back to TOTP / recovery codes.
 *  - Every error the browser or the library can raise is mapped to a stable
 *    copy key in mfaCopy.webauthnErrors, so UI code never string-matches
 *    browser messages.
 *  - cancelCeremony() aborts an in-flight ceremony when the page unmounts.
 */

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser'
import { mfaCopy } from './mfaCopy'

/** Stable copy keys for passkey failures (see mfaCopy.webauthnErrors). */
export type WebAuthnErrorKey = keyof typeof mfaCopy.webauthnErrors

/** Result of probing this browser/deployment for WebAuthn support. */
export interface WebAuthnSupport {
  /** window.isSecureContext (HTTPS or localhost). */
  secureContext: boolean
  /** window.PublicKeyCredential exists. */
  hasPublicKeyCredential: boolean
  /** isUserVerifyingPlatformAuthenticatorAvailable(), or null when unknown. */
  platformAuthenticatorAvailable: boolean | null
  /** Secure context + PublicKeyCredential: a ceremony could start at all. */
  supported: boolean
}

/** Raised when a ceremony is attempted in an environment without WebAuthn. */
export class WebAuthnUnsupportedError extends Error {
  readonly code = 'ERROR_UNSUPPORTED'

  constructor(message: string = mfaCopy.webauthnErrors.unsupported) {
    super(message)
    this.name = 'WebAuthnUnsupportedError'
  }
}

let cachedSupport: WebAuthnSupport | null = null

/**
 * Detect whether this browser can run a WebAuthn ceremony. Results are cached
 * for the page load (the platform-authenticator probe is async and not free).
 * Pass force=true to re-probe.
 */
export async function detectWebAuthnSupport(force = false): Promise<WebAuthnSupport> {
  if (cachedSupport && !force) return cachedSupport

  const secureContext =
    typeof window !== 'undefined' && (window as { isSecureContext?: boolean }).isSecureContext !== false
  const hasPublicKeyCredential =
    typeof window !== 'undefined' &&
    typeof (window as { PublicKeyCredential?: unknown }).PublicKeyCredential !== 'undefined'
  const supported = secureContext && hasPublicKeyCredential

  let platformAuthenticatorAvailable: boolean | null = null
  if (supported) {
    try {
      const lib = await import('@simplewebauthn/browser')
      platformAuthenticatorAvailable = await lib.platformAuthenticatorIsAvailable()
    } catch {
      // Capability probe failed — passkeys may still work via a security key
      // or the hybrid transport, so leave it "unknown" rather than "no".
      platformAuthenticatorAvailable = null
    }
  }

  cachedSupport = { secureContext, hasPublicKeyCredential, platformAuthenticatorAvailable, supported }
  return cachedSupport
}

/** @internal test helper: forget the cached feature-detection result. */
export function _resetWebAuthnSupportForTests(): void {
  cachedSupport = null
}

/**
 * Copy explaining why passkeys cannot be used here, or undefined when they
 * are supported.
 */
export function webAuthnUnavailableMessage(support: WebAuthnSupport): string | undefined {
  if (support.supported) return undefined
  return support.secureContext
    ? mfaCopy.webauthnErrors.unsupported
    : mfaCopy.webauthnErrors.insecure_context
}

/**
 * The API returns the INNER options object (go-webauthn's creation.Response /
 * assertion.Response). Older/alternative servers may wrap it as
 * { publicKey: {...}, mediation? }; unwrap defensively so both shapes work.
 */
export function unwrapPublicKey<T>(options: T | { publicKey?: T }): T {
  if (options && typeof options === 'object' && 'publicKey' in (options as Record<string, unknown>)) {
    const inner = (options as { publicKey?: T }).publicKey
    if (inner && typeof inner === 'object') return inner
  }
  return options as T
}

/** Run a WebAuthn registration ceremony (create a passkey). */
export async function registerPasskey(
  options: PublicKeyCredentialCreationOptionsJSON | { publicKey?: PublicKeyCredentialCreationOptionsJSON },
): Promise<RegistrationResponseJSON> {
  const support = await detectWebAuthnSupport()
  if (!support.supported) throw new WebAuthnUnsupportedError()

  const optionsJSON = unwrapPublicKey(options)
  const lib = await import('@simplewebauthn/browser')
  return lib.startRegistration({ optionsJSON })
}

/** Run a WebAuthn authentication ceremony (use a passkey). */
export async function authenticatePasskey(
  options: PublicKeyCredentialRequestOptionsJSON | { publicKey?: PublicKeyCredentialRequestOptionsJSON },
): Promise<AuthenticationResponseJSON> {
  const support = await detectWebAuthnSupport()
  if (!support.supported) throw new WebAuthnUnsupportedError()

  const optionsJSON = unwrapPublicKey(options)
  const lib = await import('@simplewebauthn/browser')
  return lib.startAuthentication({ optionsJSON })
}

/**
 * Abort any in-flight ceremony (call on unmount so a pending browser prompt
 * is dismissed instead of resolving into a dead component).
 */
export async function cancelCeremony(): Promise<void> {
  try {
    const lib = await import('@simplewebauthn/browser')
    lib.WebAuthnAbortService.cancelCeremony()
  } catch {
    // Not supported in this environment — nothing to cancel.
  }
}

/**
 * Map an error thrown by the browser/library to a stable copy key.
 *
 * SimpleWebAuthn v13+ surfaces the underlying DOMException as `cause` for
 * NotAllowedError (cancel/timeout) and marks aborts with ERROR_CEREMONY_ABORTED,
 * so both shapes are handled alongside raw DOMExceptions.
 */
export function webAuthnErrorKey(err: unknown): WebAuthnErrorKey | undefined {
  if (!err || typeof err !== 'object') return undefined

  const e = err as { code?: unknown; name?: unknown; cause?: unknown }
  const code = typeof e.code === 'string' ? e.code : undefined
  const name = typeof e.name === 'string' ? e.name : undefined
  const cause = e.cause && typeof e.cause === 'object' ? (e.cause as { name?: unknown }) : undefined
  const causeName = typeof cause?.name === 'string' ? cause.name : undefined

  if (code === 'ERROR_UNSUPPORTED') return 'unsupported'

  // Our own cancel / an unmount abort.
  if (name === 'AbortError' || causeName === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED') {
    return 'ceremony_aborted'
  }

  // User dismissed the browser sheet or the platform timed out.
  if (
    name === 'NotAllowedError' ||
    causeName === 'NotAllowedError' ||
    code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY'
  ) {
    return 'cancelled_or_timeout'
  }

  switch (code) {
    case 'ERROR_INVALID_RP_ID':
      return 'rp_id_mismatch'
    case 'ERROR_INVALID_DOMAIN':
      return 'invalid_domain'
    case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
      return 'already_registered'
    case 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG':
      return 'unsupported_algorithm'
    case 'ERROR_MALFORMED_PUBKEYCREDPARAMS':
      return 'malformed_options'
    case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT':
    case 'ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE':
      return 'missing_user_verification'
    case 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT':
      return 'missing_discoverable_credential'
    case 'ERROR_AUTHENTICATOR_GENERAL_ERROR':
      return 'general_error'
    case 'ERROR_INVALID_USER_ID_LENGTH':
      return 'invalid_user_id'
    default:
      break
  }

  // Raw DOMExceptions (library falls through for some cases).
  switch (name) {
    case 'SecurityError':
      return 'invalid_domain'
    case 'InvalidStateError':
      return 'already_registered'
    case 'NotSupportedError':
      return 'unsupported_algorithm'
    case 'UnknownError':
      return 'general_error'
    default:
      return undefined
  }
}

/** True when the user dismissed/timed out a prompt or we aborted the ceremony. */
export function isWebAuthnCancel(err: unknown): boolean {
  const key = webAuthnErrorKey(err)
  return key === 'cancelled_or_timeout' || key === 'ceremony_aborted'
}

/**
 * Human copy for a passkey error. Returns '' for silent aborts (route change /
 * unmount) so callers can skip rendering a message.
 */
export function webAuthnErrorMessage(err: unknown): string {
  const key = webAuthnErrorKey(err)
  if (!key) return ''
  return mfaCopy.webauthnErrors[key] ?? mfaCopy.webauthnErrors.general_error
}

/**
 * Short copy for a failed PASSWORDLESS sign-in attempt on the login page.
 *
 * The password form always stays usable, so a cancelled/timed-out prompt gets
 * a gentle hint ("no passkey was used") while any other failure collapses to
 * "use your password instead" — no RP-ID/origin details on a public page.
 * Returns '' for silent aborts (route change/unmount).
 */
export function passwordlessPasskeyErrorMessage(err: unknown): string {
  const key = webAuthnErrorKey(err)
  if (key === 'ceremony_aborted') return ''
  if (key === 'cancelled_or_timeout') return mfaCopy.login.passkeyCancelled
  return mfaCopy.login.passkeyFailed
}
