import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { IconShieldLock } from '@tabler/icons-react'
import { PrimaryButton, inputCls, labelCls } from '../lib/ui'

interface LoginResponse {
  token?: string
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

function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const loginMutation = useMutation({
    mutationFn: async (credentials: { email: string; password: string }) => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      })
      if (!res.ok) {
        throw new Error('Login failed')
      }
      return res.json() as Promise<LoginResponse>
    },
    onSuccess: (data) => {
      if (data.pending_2fa && data.token) {
        localStorage.setItem('pending2fa_token', data.token)
        window.location.href = '/2fa-verify'
      } else if (data.token) {
        localStorage.setItem('token', data.token)
        window.location.href = '/dashboard'
      }
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    loginMutation.mutate({ email, password })
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-md">
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-8 shadow-2xl">
          <div className="flex flex-col items-center text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-teal-500/10 ring-1 ring-teal-500/20 mb-4">
              <IconShieldLock size={24} stroke={1.6} className="text-teal-400" aria-hidden="true" />
            </span>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">WireGuard Console</h1>
            <p className="mt-2 text-sm text-zinc-500">Sign in to your account</p>
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

        <p className="mt-6 text-center text-xs text-zinc-600">
          Secure remote access to your private mesh.
        </p>
      </div>
    </div>
  )
}
