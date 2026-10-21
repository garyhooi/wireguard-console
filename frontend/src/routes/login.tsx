import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { IconShieldLock } from '@tabler/icons-react'
import { PrimaryButton, inputCls, labelCls } from '../lib/ui'
import { apiFetch, setCsrfToken } from '../lib/api'
import { HoloPageBackground } from '../components/HoloPageBackground'
import { AuthStatusOverlay } from '../components/AuthStatusOverlay'
import { LoginLockoutOverlay } from '../components/LoginLockoutOverlay'

interface LoginResponse {
  csrf_token?: string
  pending_2fa?: boolean
  pending_2fa_setup?: boolean
  admin?: {
    id: string
    email: string
    role: string
    totp_enabled: boolean
    status: string
    created_at: string
  }
}

// Remember the last email we attempted so a refreshed page can ask the
// server about that ACCOUNT's lock too (the IP may have changed).
const LOCKOUT_EMAIL_KEY = 'wgc-lockout-email'
function storedLockoutEmail(): string {
  try {
    return sessionStorage.getItem(LOCKOUT_EMAIL_KEY) || ''
  } catch {
    return ''
  }
}
function rememberLockoutEmail(email: string) {
  try {
    sessionStorage.setItem(LOCKOUT_EMAIL_KEY, email)
  } catch {
    // storage disabled: fall back to IP-only countdowns
  }
}
function forgetLockoutEmail() {
  try {
    sessionStorage.removeItem(LOCKOUT_EMAIL_KEY)
  } catch {
    // ignore
  }
}

// 429 from the login endpoint: the server locked this IP/account for a while.
class LoginLockedError extends Error {
  seconds: number
  constructor(seconds: number, message: string) {
    super(message)
    this.seconds = seconds
  }
}

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // Full-page verification animation: green on success, red on failure.
  const [authOutcome, setAuthOutcome] = useState<'success' | 'failure' | null>(null)
  const redirectRef = useRef<string | null>(null)
  // Remaining seconds of a server-enforced IP lockout (null = not locked).
  const [lockoutSeconds, setLockoutSeconds] = useState<number | null>(null)

  // Refresh-safe lockout: on load, ask the server whether this IP is still
  // locked so the countdown resumes where it stopped.
  useEffect(() => {
    let cancelled = false
    const storedEmail = storedLockoutEmail()
    const statusPath =
      '/api/auth/lockout-status' + (storedEmail ? '?email=' + encodeURIComponent(storedEmail) : '')
    apiFetch(statusPath, { noAuthRedirect: true })
      .then(async (res) => {
        if (!res.ok) return
        const data = (await res.json().catch(() => null)) as
          | { locked?: boolean; retry_after_seconds?: number }
          | null
        if (!cancelled && data?.locked && (data.retry_after_seconds ?? 0) > 0) {
          setLockoutSeconds(data.retry_after_seconds as number)
        }
      })
      .catch(() => {
        // Lockout status is best-effort: a failed probe must not block login.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const loginMutation = useMutation({
    mutationFn: async (credentials: { email: string; password: string }) => {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: credentials,
        skipCsrf: true,
        // A 401 here means "wrong email/password", not an expired session;
        // without this the client would reload /login and swallow the red
        // verification animation.
        noAuthRedirect: true,
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as
          | { error?: string; retry_after_seconds?: number }
          | null
        if (res.status === 429 && (err?.retry_after_seconds ?? 0) > 0) {
          rememberLockoutEmail(credentials.email)
          throw new LoginLockedError(
            err?.retry_after_seconds as number,
            err?.error || 'Too many failed login attempts',
          )
        }
        throw new Error(err?.error || 'Login failed')
      }
      return res.json() as Promise<LoginResponse>
    },
    onSuccess: (data) => {
      if (data.pending_2fa_setup) {
        // 2FA enrolment is mandatory before a session is issued. The pending
        // cookie set by the server authorizes the setup page only.
        window.location.href = '/2fa-setup?forced=1'
        return
      }
      if (data.pending_2fa) {
        // The pending-2FA token rides in the wgc_pending2fa HttpOnly cookie
        // set by the server — nothing to store client-side. Not a completed
        // sign-in yet, so no "verified" animation: continue to the code step.
        window.location.href = '/2fa-verify'
        return
      }
      setCsrfToken(data.csrf_token)
      forgetLockoutEmail()
      redirectRef.current = '/dashboard'
      setAuthOutcome('success')
    },
    onError: (error) => {
      if (error instanceof LoginLockedError) {
        setLockoutSeconds(error.seconds)
        return
      }
      setAuthOutcome('failure')
    },
  })

  // The client timer can drift; before unlocking, ask the server. If the
  // lock is somehow still active (clock skew, another tab), keep counting the
  // server-reported remaining time instead of letting the user retry early.
  const handleLockoutUnlock = async () => {
    try {
      const storedEmail = storedLockoutEmail()
      const statusPath =
        '/api/auth/lockout-status' + (storedEmail ? '?email=' + encodeURIComponent(storedEmail) : '')
      const res = await apiFetch(statusPath, { noAuthRedirect: true })
      const data = res.ok
        ? ((await res.json().catch(() => null)) as
            | { locked?: boolean; retry_after_seconds?: number }
            | null)
        : null
      const seconds = Math.ceil(Number(data?.retry_after_seconds ?? 0))
      if (data?.locked && seconds > 0) {
        setLockoutSeconds(seconds)
        return
      }
    } catch {
      // Status probe failed: fall through and unlock optimistically.
    }
    forgetLockoutEmail()
    setLockoutSeconds(null)
    loginMutation.reset()
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    loginMutation.mutate({ email, password })
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-[#04060c] px-4">
      {/* Animated holographic backdrop (canvas, no dependencies). */}
      <HoloPageBackground />

      <div className="relative z-10 w-full max-w-md">
        <div className="relative bg-[#080d16]/80 backdrop-blur-md border border-teal-500/25 rounded-xl p-8 shadow-[0_0_60px_-18px_rgba(45,212,191,0.55)]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-10 -top-px h-px bg-gradient-to-r from-transparent via-teal-300/70 to-transparent"
          />
          <div className="flex flex-col items-center text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-teal-500/10 ring-1 ring-teal-400/30 mb-4 shadow-[0_0_24px_-6px_rgba(45,212,191,0.65)]">
              <IconShieldLock size={24} stroke={1.6} className="text-teal-300" aria-hidden="true" />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-50 [text-shadow:0_0_24px_rgba(45,212,191,0.28)]">
              WireGuard Console
            </h1>
            <p className="mt-2 text-sm text-zinc-400">Sign in to your account</p>
          </div>

          <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="email" className={labelCls}>
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                className={inputCls}
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="password" className={labelCls}>
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                className={inputCls}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {loginMutation.error && (
              <div className="text-red-400 text-sm text-center">{loginMutation.error.message}</div>
            )}

            <PrimaryButton
              type="submit"
              disabled={loginMutation.isPending || lockoutSeconds !== null}
              className="w-full py-2.5"
            >
              {loginMutation.isPending ? 'Signing in…' : 'Sign in'}
            </PrimaryButton>
          </form>
        </div>

        <p className="mt-6 text-center text-xs tracking-wide text-zinc-500">
          Secure remote access to your private mesh.
        </p>
      </div>

      {lockoutSeconds !== null && (
        <LoginLockoutOverlay
          seconds={lockoutSeconds}
          onUnlock={() => {
            void handleLockoutUnlock()
          }}
        />
      )}

      {authOutcome && (
        <AuthStatusOverlay
          status={authOutcome}
          message={authOutcome === 'failure' ? loginMutation.error?.message : undefined}
          onDone={() => {
            if (authOutcome === 'success' && redirectRef.current) {
              window.location.href = redirectRef.current
              return
            }
            setAuthOutcome(null)
          }}
        />
      )}
    </div>
  )
}
