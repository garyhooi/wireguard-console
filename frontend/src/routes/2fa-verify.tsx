import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { PrimaryButton, inputCls, labelCls } from '../lib/ui'

interface Verify2FARequest {
  code: string
}

interface Verify2FAResponse {
  token: string
}

export const Route = createFileRoute('/2fa-verify')({
  component: Verify2FAPage,
  beforeLoad: async () => {
    const token = localStorage.getItem('pending2fa_token')
    if (!token) {
      window.location.href = '/login'
    }
  },
})

function Verify2FAPage() {
  const [code, setCode] = useState('')

  const verifyMutation = useMutation({
    mutationFn: async (code: string) => {
      const pendingToken = localStorage.getItem('pending2fa_token')
      const res = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: pendingToken!,
        },
        body: JSON.stringify({ code }),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Verification failed')
      }
      return res.json() as Promise<Verify2FAResponse>
    },
    onSuccess: (data) => {
      localStorage.setItem('token', data.token)
      localStorage.removeItem('pending2fa_token')
      window.location.href = '/dashboard'
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (code.length === 6) {
      verifyMutation.mutate(code)
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-zinc-900/60 border border-zinc-800 rounded-xl p-8 shadow-2xl">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100 mb-1">
          Enter Authentication Code
        </h1>
        <p className="text-zinc-500 text-sm mb-6">
          Enter the 6-digit code from your authenticator app to complete sign in.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="mb-6">
            <label htmlFor="code" className={labelCls}>
              Authentication Code
            </label>
            <input
              id="code"
              type="text"
              maxLength={6}
              autoFocus
              className={`${inputCls} text-center text-2xl tracking-widest`}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </div>

          {verifyMutation.error && (
            <div className="text-red-400 text-sm mb-4">{verifyMutation.error.message}</div>
          )}

          <PrimaryButton type="submit" disabled={verifyMutation.isPending || code.length !== 6} className="w-full">
            {verifyMutation.isPending ? 'Verifying…' : 'Verify'}
          </PrimaryButton>
        </form>
      </div>
    </div>
  )
}
