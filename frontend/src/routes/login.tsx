import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'

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
    <div className="min-h-screen flex items-center justify-center bg-neutral-950">
      <div className="max-w-md w-full space-y-8 p-8 bg-neutral-900 rounded-lg border border-neutral-800">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-white">
            WireGuard Console
          </h2>
          <p className="mt-2 text-center text-sm text-neutral-400">
            Sign in to your account
          </p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="rounded-md shadow-sm -space-y-px">
            <div>
              <label htmlFor="email" className="sr-only">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                className="appearance-none rounded-none relative block w-full px-3 py-2 border border-neutral-700 placeholder-neutral-500 text-white bg-neutral-800 rounded-t-md focus:outline-none focus:ring-teal-500 focus:border-teal-500 focus:z-10 sm:text-sm"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="password" className="sr-only">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                className="appearance-none rounded-none relative block w-full px-3 py-2 border border-neutral-700 placeholder-neutral-500 text-white bg-neutral-800 rounded-b-md focus:outline-none focus:ring-teal-500 focus:border-teal-500 focus:z-10 sm:text-sm"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          {loginMutation.error && (
            <div className="text-red-500 text-sm text-center">
              {loginMutation.error.message}
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={loginMutation.isPending}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-teal-600 hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-teal-500 disabled:opacity-50"
            >
              {loginMutation.isPending ? 'Signing in...' : 'Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
