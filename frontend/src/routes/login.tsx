import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { IconShieldLock } from '@tabler/icons-react'
import { PrimaryButton, inputCls, labelCls } from '../lib/ui'
import { apiFetch, setCsrfToken } from '../lib/api'
import { HoloPageBackground } from '../components/HoloPageBackground'

interface LoginResponse {
  csrf_token?: string
  pending_2fa?: boolean
  admin?: {
    id: string
    email: string
    role: string
    totp_enabled: boolean
    status: string
    created_at: string
  }
}

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const loginMutation = useMutation({
    mutationFn: async (credentials: { email: string; password: string }) => {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: credentials,
        skipCsrf: true,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        throw new Error((err as { error?: string } | null)?.error || 'Login failed')
      }
      return res.json() as Promise<LoginResponse>
    },
    onSuccess: (data) => {
      if (data.pending_2fa) {
        // The pending-2FA token rides in the wgc_pending2fa HttpOnly cookie
        // set by the server — nothing to store client-side.
        window.location.href = '/2fa-verify'
      } else {
        setCsrfToken(data.csrf_token)
        window.location.href = '/dashboard'
      }
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    loginMutation.mutate({ email, password })
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-[#04060c] px-4">
      {/* Animated cyberpunk/hologram backdrop (canvas, no dependencies). */}
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

            <PrimaryButton type="submit" disabled={loginMutation.isPending} className="w-full py-2.5">
              {loginMutation.isPending ? 'Signing in…' : 'Sign in'}
            </PrimaryButton>
          </form>
        </div>

        <p className="mt-6 text-center text-xs tracking-wide text-zinc-500">
          Secure remote access to your private mesh.
        </p>
      </div>
    </div>
  )
}
