/**
 * Typed client for the MFA / passkey API (contract §2 and §4).
 *
 * Two groups of calls:
 *  - Pending-cookie login routes (/api/auth/mfa/*): the HttpOnly wgc_mfa_pending
 *    cookie authorizes them; there is no session yet, so they are sent with
 *    skipCsrf + noAuthRedirect (a 401 means "pending attempt gone", not
 *    "session expired" — redirecting would hide the error states).
 *  - Authed routes (/api/admins/me/mfa/*): normal CSRF + 401 handling.
 *
 * Successful login/enrollment completions capture the freshly minted session
 * CSRF token and (by default) hard-navigate to /dashboard. The /mfa-verify
 * and /mfa-setup pages pass { navigate: false } so they can show the
 * AuthStatusOverlay / recovery codes first.
 *
 * frontend-manage imports the exported surface below; keep names/types stable.
 */

import { apiFetch, apiJson, setCsrfToken } from './api'
import { navigateTo } from './mfaCopy'
import {
  authenticatePasskey,
  registerPasskey,
  unwrapPublicKey,
} from './webauthn'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser'

export type MFAMethod = 'passkey' | 'totp' | 'recovery_code'
export type MFAPolicy = 'any' | 'totp' | 'passkey' | 'both'
export type MFAEnrollmentMethod = 'totp' | 'passkey'

/** GET /api/auth/mfa/state (pending-cookie state for the login challenge). */
export interface MFAState {
  pending_kind: 'verify' | 'enroll'
  mfa_methods?: MFAMethod[]
  setup_methods?: MFAEnrollmentMethod[]
  passkey_available: boolean
  passkey_reason?: string
  rp_id?: string
  passkey_count: number
  recovery_codes_remaining: number
  expires_in_seconds: number
  require_methods: MFAPolicy
  mfa_required: boolean
}

/** One enrolled factor (authed management view). */
export interface MFAFactor {
  id: string
  type: 'totp' | 'passkey'
  label: string
  created_at: string
  last_used_at?: string
  attachment?: string
  backup_eligible?: boolean
  usable: boolean
}

/** GET /api/admins/me/mfa (authed factor list). */
export interface MFAStatus {
  mfa_enabled: boolean
  methods: MFAMethod[]
  passkey_available: boolean
  passkey_reason?: string
  rp_id?: string
  require_methods: MFAPolicy
  recovery_codes_remaining: number
  factors: MFAFactor[]
  totp_enabled: boolean
}

/** GET /api/auth/passkey/status — public passwordless capability probe. */
export interface PasskeyStatus {
  passkey_available: boolean
  passkey_reason?: string
}

/** Normalized passkey ceremony start (begin response). */
export interface PasskeyBegin {
  challengeId: string
  /** Inner PublicKeyCredential*OptionsJSON (already unwrapped). */
  options: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON
  rpId?: string
  expiresInSeconds: number
}

/** Result of POST /api/auth/mfa/enroll/complete. */
export interface EnrollmentComplete {
  csrf_token?: string
  recovery_codes?: string[]
  admin?: { id: string; email: string; role: string }
}

/** Result of the authed TOTP begin call. */
export interface TOTPEnrollment {
  secret: string
  otpauth_url: string
}

/** Redirect behaviour for the session-minting calls. */
export interface RedirectOption {
  /**
   * Hard-navigate to /dashboard on success. Default true; the challenge pages
   * pass false so they can play the success overlay / show recovery codes.
   */
  navigate?: boolean
}

interface LoginFinishResponse {
  csrf_token?: string
  admin?: { id: string; email: string; role: string }
}

interface PasskeyBeginResponse {
  challenge_id: string
  options?: unknown
  rp_id?: string
  expires_in_seconds?: number
}

/** TOTP-enrollment begin response; also used by the authed add-TOTP flow. */
interface TOTPBeginResponse {
  secret: string
  otpauth_url: string
}

// --- error helpers --------------------------------------------------------

/**
 * Machine-readable server error code (mfa_invalid, mfa_locked, ...), from
 * either ApiError.code (frontend-manage adds the typed field) or the raw
 * parsed body. Never throws.
 */
export function mfaErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as { code?: unknown; body?: unknown }
  if (typeof e.code === 'string' && e.code !== '') return e.code
  const body = e.body
  if (body && typeof body === 'object') {
    const code = (body as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return undefined
}

/** HTTP status of an ApiError (or undefined for non-HTTP failures). */
export function mfaErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/** retry_after_seconds for a 429 lockout, from ApiError or its body. */
export function mfaRetryAfterSeconds(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const direct = (err as { retryAfterSeconds?: unknown }).retryAfterSeconds
  if (typeof direct === 'number' && direct > 0) return Math.ceil(direct)
  const body = (err as { body?: unknown }).body
  if (body && typeof body === 'object') {
    const raw = (body as { retry_after_seconds?: unknown }).retry_after_seconds
    if (typeof raw === 'number' && raw > 0) return Math.ceil(raw)
  }
  return undefined
}

// --- passwordless passkey login (public, /login page) --------------------

/**
 * GET /api/auth/passkey/status — capability-only probe used to decide whether
 * /login shows the "Sign in with a passkey" button. Public and cheap; callers
 * treat any failure as "hide the button".
 */
export async function getPasskeyStatus(): Promise<PasskeyStatus> {
  return apiJson<PasskeyStatus>('/api/auth/passkey/status', { noAuthRedirect: true })
}

/**
 * POST /api/auth/passkey/options — begin a discoverable-credential login.
 * The server sets the short-lived wgc_passkey_login HttpOnly cookie; the
 * returned options carry no allowCredentials (usernameless).
 */
export async function beginPasswordlessPasskey(): Promise<PasskeyBegin> {
  const data = await apiJson<PasskeyBeginResponse>('/api/auth/passkey/options', {
    method: 'POST',
    skipCsrf: true,
    noAuthRedirect: true,
  })
  const options = unwrapPublicKey(data.options) as PublicKeyCredentialRequestOptionsJSON
  pendingCeremonyOptions.set(data.challenge_id, options)
  pendingPasswordlessChallenge = data.challenge_id
  return {
    challengeId: data.challenge_id,
    options,
    rpId: data.rp_id,
    expiresInSeconds: data.expires_in_seconds ?? 0,
  }
}

/**
 * Complete a passwordless passkey login: runs the browser assertion ceremony
 * for the challenge captured by beginPasswordlessPasskey, posts it to
 * /api/auth/passkey/finish, captures the session CSRF token and (by default)
 * hard-navigates to /dashboard. The login page passes { navigate: false } so
 * the success overlay can play first.
 */
export async function completePasswordlessPasskey(redirect: RedirectOption = {}): Promise<void> {
  const challengeId = pendingPasswordlessChallenge
  const options = challengeId ? pendingCeremonyOptions.get(challengeId) : undefined
  if (!challengeId || !options) {
    throw new Error('Passkey sign-in could not be started. Try again.')
  }
  try {
    const credential: AuthenticationResponseJSON = await authenticatePasskey(options)
    const data = await apiJson<LoginFinishResponse>('/api/auth/passkey/finish', {
      method: 'POST',
      body: { challenge_id: challengeId, credential },
      skipCsrf: true,
      noAuthRedirect: true,
    })
    setCsrfToken(data.csrf_token)
    if (redirect.navigate !== false) navigateTo('/dashboard')
  } finally {
    pendingCeremonyOptions.delete(challengeId)
    pendingPasswordlessChallenge = null
  }
}

// --- pending-cookie login routes -----------------------------------------

/** GET /api/auth/mfa/state — refresh-safe state for /mfa-verify and /mfa-setup. */
export async function getMFAState(): Promise<MFAState> {
  return apiJson<MFAState>('/api/auth/mfa/state', { noAuthRedirect: true })
}

/** Verify an authenticator-app code and mint the session. */
export async function verifyTOTP(code: string, redirect: RedirectOption = {}): Promise<void> {
  const data = await apiJson<LoginFinishResponse>('/api/auth/mfa/totp', {
    method: 'POST',
    body: { code },
    skipCsrf: true,
    noAuthRedirect: true,
  })
  setCsrfToken(data.csrf_token)
  if (redirect.navigate !== false) navigateTo('/dashboard')
}

/** Verify a recovery code and mint the session. */
export async function verifyRecoveryCode(code: string, redirect: RedirectOption = {}): Promise<void> {
  const data = await apiJson<LoginFinishResponse>('/api/auth/mfa/recovery-code', {
    method: 'POST',
    body: { code: normalizeRecoveryCode(code) },
    skipCsrf: true,
    noAuthRedirect: true,
  })
  setCsrfToken(data.csrf_token)
  if (redirect.navigate !== false) navigateTo('/dashboard')
}

/** Start a passkey login ceremony: stores the options for completePasskeyLogin. */
export async function beginPasskeyLogin(): Promise<PasskeyBegin> {
  const data = await apiJson<PasskeyBeginResponse>('/api/auth/mfa/passkey/begin', {
    method: 'POST',
    skipCsrf: true,
    noAuthRedirect: true,
  })
  const options = unwrapPublicKey(data.options) as PublicKeyCredentialRequestOptionsJSON
  pendingCeremonyOptions.set(data.challenge_id, options)
  return {
    challengeId: data.challenge_id,
    options,
    rpId: data.rp_id,
    expiresInSeconds: data.expires_in_seconds ?? 0,
  }
}

/**
 * Complete a passkey login: runs the browser authentication ceremony for the
 * options captured by beginPasskeyLogin, posts the assertion, mints the
 * session and (by default) hard-navigates to /dashboard.
 */
export async function completePasskeyLogin(
  challengeId: string,
  redirect: RedirectOption = {},
): Promise<void> {
  const options = pendingCeremonyOptions.get(challengeId)
  if (!options) {
    throw new Error('Passkey sign-in could not be started. Try again.')
  }
  try {
    const credential: AuthenticationResponseJSON = await authenticatePasskey(options)
    const data = await apiJson<LoginFinishResponse>('/api/auth/mfa/passkey/finish', {
      method: 'POST',
      body: { challenge_id: challengeId, credential },
      skipCsrf: true,
      noAuthRedirect: true,
    })
    setCsrfToken(data.csrf_token)
    if (redirect.navigate !== false) navigateTo('/dashboard')
  } finally {
    pendingCeremonyOptions.delete(challengeId)
  }
}

/**
 * POST /api/auth/logout, then go back to /login. Used by the "sign in again"
 * cards on the challenge pages (the pending cookie is cleared server-side).
 */
export async function signOutAndRestart(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', {
      method: 'POST',
      skipCsrf: true,
      noAuthRedirect: true,
    })
  } catch {
    // Logout is best-effort: still send the user to the sign-in page.
  }
  navigateTo('/login')
}

// --- pending forced-enrollment routes ------------------------------------

/** POST /api/auth/mfa/enroll/totp/begin — returns a new pending TOTP secret. */
export async function beginTOTPEnrollment(): Promise<TOTPEnrollment> {
  const data = await apiJson<TOTPBeginResponse>('/api/auth/mfa/enroll/totp/begin', {
    method: 'POST',
    skipCsrf: true,
    noAuthRedirect: true,
  })
  return { secret: data.secret, otpauth_url: data.otpauth_url }
}

/** POST /api/auth/mfa/enroll/totp/finish — proves the pending TOTP secret. */
export async function finishTOTPEnrollment(code: string): Promise<void> {
  await apiJson<{ status?: string }>('/api/auth/mfa/enroll/totp/finish', {
    method: 'POST',
    body: { code },
    skipCsrf: true,
    noAuthRedirect: true,
  })
}

/** POST /api/auth/mfa/enroll/passkey/begin — stores creation options. */
export async function beginPasskeyEnrollment(): Promise<PasskeyBegin> {
  const data = await apiJson<PasskeyBeginResponse>('/api/auth/mfa/enroll/passkey/begin', {
    method: 'POST',
    skipCsrf: true,
    noAuthRedirect: true,
  })
  const options = unwrapPublicKey(data.options) as PublicKeyCredentialCreationOptionsJSON
  pendingCeremonyOptions.set(data.challenge_id, options)
  return {
    challengeId: data.challenge_id,
    options,
    rpId: data.rp_id,
    expiresInSeconds: data.expires_in_seconds ?? 0,
  }
}

/** Register the browser passkey created for a beginPasskeyEnrollment call. */
export async function completePasskeyEnrollment(
  challengeId: string,
  label?: string,
): Promise<void> {
  const options = pendingCeremonyOptions.get(challengeId)
  if (!options) {
    throw new Error('Passkey setup could not be started. Try again.')
  }
  try {
    const credential: RegistrationResponseJSON = await registerPasskey(
      options as PublicKeyCredentialCreationOptionsJSON,
    )
    await apiJson<{ status?: string }>('/api/auth/mfa/enroll/passkey/finish', {
      method: 'POST',
      body: { challenge_id: challengeId, credential, ...(label ? { label } : {}) },
      skipCsrf: true,
      noAuthRedirect: true,
    })
  } finally {
    pendingCeremonyOptions.delete(challengeId)
  }
}

/** Convenience: begin + browser ceremony + finish for forced passkey enrollment. */
export async function enrollPasskey(label?: string): Promise<void> {
  const begin = await beginPasskeyEnrollment()
  await completePasskeyEnrollment(begin.challengeId, label)
}

/**
 * POST /api/auth/mfa/enroll/complete — validates the org policy, issues
 * recovery codes when needed and mints the session.
 *
 * Navigation is opt-out (default false here) because forced enrollment must
 * show the one-time recovery codes before leaving; the page navigates after
 * the acknowledgement step. Callers that don't need the codes can pass
 * { navigate: true }.
 */
export async function completeEnrollment(redirect: RedirectOption = {}): Promise<EnrollmentComplete> {
  const data = await apiJson<EnrollmentComplete>('/api/auth/mfa/enroll/complete', {
    method: 'POST',
    skipCsrf: true,
    noAuthRedirect: true,
  })
  setCsrfToken(data.csrf_token)
  if (redirect.navigate === true) navigateTo('/dashboard')
  return data
}

// --- authed management routes (frontend-manage consumers) ----------------

/** GET /api/admins/me/mfa — factor list used by the profile MFA panel. */
export async function getMFAStatus(): Promise<MFAStatus> {
  return apiJson<MFAStatus>('/api/admins/me/mfa')
}

/**
 * POST /api/admins/me/mfa/totp/begin — start authed TOTP enrollment.
 *
 * The step-up `code` is required whenever the admin already has another
 * factor: the server verifies the acting admin (or accepts the short-lived
 * passkey step-up stamp) before minting a new pending TOTP secret. It is
 * ignored by the server for the very first factor.
 */
export async function addTOTP(code: string): Promise<TOTPEnrollment> {
  const data = await apiJson<TOTPBeginResponse>('/api/admins/me/mfa/totp/begin', {
    method: 'POST',
    body: { code },
  })
  return { secret: data.secret, otpauth_url: data.otpauth_url }
}

/**
 * POST /api/admins/me/mfa/totp/finish — prove the pending secret and enable
 * TOTP. The secret is already stored server-side by addTOTP; it is accepted
 * here for call-site symmetry with the enrollment flow.
 */
export async function finishTOTP(_secret: string, code: string): Promise<void> {
  await apiJson<{ status?: string }>('/api/admins/me/mfa/totp/finish', {
    method: 'POST',
    body: { code },
  })
}

/** POST /api/admins/me/mfa/totp/remove — remove TOTP (code = step-up proof). */
export async function removeTOTP(code: string): Promise<void> {
  await apiJson<{ status?: string }>('/api/admins/me/mfa/totp/remove', {
    method: 'POST',
    body: { code },
  })
}

/** Add a passkey to the signed-in admin's account (begin + ceremony + finish). */
export async function addPasskey(code: string, label?: string): Promise<void> {
  const begin = await apiJson<PasskeyBeginResponse>('/api/admins/me/mfa/passkeys/begin', {
    method: 'POST',
    body: { code },
  })
  const options = unwrapPublicKey(begin.options) as PublicKeyCredentialCreationOptionsJSON
  const credential = await registerPasskey(options)
  await apiJson<{ status?: string }>('/api/admins/me/mfa/passkeys/finish', {
    method: 'POST',
    body: { challenge_id: begin.challenge_id, credential, ...(label ? { label } : {}) },
  })
}

/** PATCH /api/admins/me/mfa/passkeys/{id} — rename a passkey. */
export async function renamePasskey(id: string, label: string): Promise<void> {
  await apiJson<{ status?: string }>(
    `/api/admins/me/mfa/passkeys/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: { label } },
  )
}

/** DELETE /api/admins/me/mfa/passkeys/{id} — remove a passkey (code = step-up). */
export async function removePasskey(id: string, code: string): Promise<void> {
  await apiJson<{ status?: string }>(
    `/api/admins/me/mfa/passkeys/${encodeURIComponent(id)}`,
    { method: 'DELETE', body: { code } },
  )
}

/** POST /api/admins/me/mfa/recovery-codes/regenerate — returns the new codes. */
export async function regenerateRecoveryCodes(code: string): Promise<string[]> {
  const data = await apiJson<{ recovery_codes?: string[] }>(
    '/api/admins/me/mfa/recovery-codes/regenerate',
    { method: 'POST', body: { code } },
  )
  return data.recovery_codes ?? []
}

/**
 * Passkey step-up: begin + browser ceremony + finish. Resolves once the
 * server has stamped the session's short-lived passkey step-up, after which a
 * gated action is accepted with an empty code.
 */
export async function startPasskeyStepUp(): Promise<void> {
  const begin = await apiJson<PasskeyBeginResponse>('/api/auth/mfa/stepup/passkey/begin', {
    method: 'POST',
  })
  const options = unwrapPublicKey(begin.options) as PublicKeyCredentialRequestOptionsJSON
  const credential = await authenticatePasskey(options)
  await apiJson<{ status?: string }>('/api/auth/mfa/stepup/passkey/finish', {
    method: 'POST',
    body: { challenge_id: begin.challenge_id, credential },
  })
}

// --- internals ------------------------------------------------------------

/**
 * Ceremony options captured by the *begin* call, keyed by challenge_id. The
 * API returns the challenge and options in one response, so the *finish*
 * helper needs the options the UI just saw (they are base64url JSON, not
 * secrets, and are dropped as soon as the ceremony finishes).
 */
const pendingCeremonyOptions = new Map<string, unknown>()

/** Challenge captured by beginPasswordlessPasskey for the no-arg complete call. */
let pendingPasswordlessChallenge: string | null = null

/** Re-exported for the challenge pages (single redirect indirection). */
export { navigateTo }

/** Uppercase, strip dashes/spaces: "abcd-efgh" -> "ABCDEFGH". */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}
