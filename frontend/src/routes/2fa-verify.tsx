import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'

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
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-neutral-900 border border-neutral-800 rounded-lg p-8">
        <h1 className="text-2xl font-bold text-white mb-6">Enter Authentication Code</h1>

        <p className="text-neutral-400 mb-6">
          Enter the 6-digit code from your authenticator app to complete sign in.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="mb-6">
            <label htmlFor="code" className="block text-sm font-medium text-neutral-400 mb-2">
              Authentication Code
            </label>
            <input
              id="code"
              type="text"
              maxLength={6}
              autoFocus
              className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white text-center text-2xl tracking-widest focus:outline-none focus:ring-2 focus:ring-teal-500"
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </div>

          {verifyMutation.error && (
            <div className="text-red-500 text-sm mb-4">
              {verifyMutation.error.message}
            </div>
          )}

          <button
            type="submit"
            disabled={verifyMutation.isPending || code.length !== 6}
            className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md disabled:opacity-50"
          >
            {verifyMutation.isPending ? 'Verifying...' : 'Verify'}
          </button>
        </form>
      </div>
    </div>
  )
}
