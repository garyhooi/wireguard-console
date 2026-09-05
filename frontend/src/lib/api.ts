/**
 * Central API client.
 *
 * Session transport: HttpOnly cookies (wgc_session / wgc_pending2fa) — the
 * token is NEVER in localStorage or any other JS-visible storage. The browser
 * attaches the cookie automatically on same-origin requests; we only keep an
 * in-memory CSRF token (per session, returned by the server on login and
 * /admins/me) to stamp state-changing requests. In-memory only: it vanishes
 * on refresh and is re-fetched from /admins/me on boot.
 */

// In-memory CSRF token holder (module scope). Not persisted anywhere.
let csrfToken = ''
let sessionChecked = false
// Cached /admins/me result for the current page load (see fetchSession).
let sessionResult: { id: string; email: string; role: string } | null = null

/** Call after login / 2FA verify / a successful /admins/me probe. */
export function setCsrfToken(token: string | undefined | null) {
  csrfToken = token || ''
}

export function getCsrfToken(): string {
  return csrfToken
}

/** True once the app has probed the session at least once this page load. */
export function sessionCheckedOnce(): boolean {
  return sessionChecked
}

export function markSessionChecked() {
  sessionChecked = true
}

// Redirect guard so a burst of 401s (e.g. parallel queries) only redirects
// once.
let redirecting = false

function redirectToLogin() {
  if (redirecting) return
  redirecting = true
  // Replace (not push) so Back does not return to the authed page.
  window.location.replace('/login')
}

export interface ApiError extends Error {
  status: number
  body: unknown
}

function toApiError(res: Response, bodyText: string): ApiError {
  let body: unknown = undefined
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined
  } catch {
    body = bodyText
  }
  const msg =
    (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : undefined) || `Request failed (${res.status})`
  const err = new Error(msg) as ApiError
  err.status = res.status
  err.body = body
  return err
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  /** JSON body, or a FormData (multipart) — FormData is sent as-is. */
  body?: unknown
  /** Do not auto-attach X-CSRF-Token (login/2FA endpoints are pre-session). */
  skipCsrf?: boolean
}

/**
 * Fetch helper for same-origin API calls. Sends credentials, attaches the
 * CSRF token to non-GET calls, and routes 401s to the login page.
 */
export async function apiFetch(path: string, options: ApiFetchOptions = {}): Promise<Response> {
  const { body, skipCsrf, headers, ...rest } = options

  const h = new Headers(headers)
  const isForm = body instanceof FormData
  if (body !== undefined && !isForm && !h.has('Content-Type')) {
    h.set('Content-Type', 'application/json')
  }

  const method = (rest.method || 'GET').toUpperCase()
  const isStateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  // State-changing requests need the CSRF token — except the endpoints that
  // run *before* a session exists (login, 2FA verify). Those are CSRF-
  // protected by SameSite=Strict alone; there is no cookie-mounted authed
  // action to protect yet.
  if (isStateChanging && !skipCsrf && csrfToken) {
    h.set('X-CSRF-Token', csrfToken)
  }

  const res = await fetch(path, {
    ...rest,
    method,
    headers: h,
    credentials: 'same-origin',
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  })

  if (res.status === 401) {
    // Session expired/revoked — clear in-memory state and send to login.
    csrfToken = ''
    sessionChecked = false
    redirectToLogin()
  }

  return res
}

/** Parse the response as JSON; throw ApiError on !ok. */
export async function apiJson<T>(path: string, options?: ApiFetchOptions): Promise<T> {
  const res = await apiFetch(path, options)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw toApiError(res, text)
  }
  // res.json() rather than text-then-parse: test mocks and streaming
  // responses both provide json() directly.
  const data = await res.json().catch(() => undefined)
  return data as T
}

/**
 * Probe the current session (GET /admins/me). Returns the admin profile +
 * CSRF token when logged in, null when not. Cached per page load: the first
 * call confirms the session and every later route navigation reuses the
 * result (the cookie is HttpOnly and unchanged within a page load).
 */
export async function fetchSession(): Promise<{ id: string; email: string; role: string } | null> {
  if (sessionResult !== null) return sessionResult
  markSessionChecked()
  const res = await fetch('/api/admins/me', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (res.status === 401) {
    csrfToken = ''
    sessionResult = null
    return null
  }
  if (!res.ok) {
    // Network/5xx — do not cache so a later navigation can retry, but do not
    // bounce the user either.
    return null
  }
  const data = await res.json()
  csrfToken = typeof data.csrf_token === 'string' ? data.csrf_token : ''
  sessionResult = data
  return data
}

/** Invalidate the cached session (after logout or a 401 redirect). */
export function clearSessionCache() {
  sessionResult = null
  csrfToken = ''
  sessionChecked = false
}
