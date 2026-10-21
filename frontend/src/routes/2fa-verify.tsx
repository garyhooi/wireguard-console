import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { PrimaryButton, inputCls, labelCls } from '../lib/ui'
import { HoloPageBackground } from '../components/HoloPageBackground'
import { AuthStatusOverlay } from '../components/AuthStatusOverlay'
import { apiFetch, setCsrfToken } from '../lib/api'

interface Verify2FAResponse {
  csrf_token?: string
}

export const Route = createFileRoute('/2fa-verify')({
  component: Verify2FAPage,
})

function Verify2FAPage() {
  const [code, setCode] = useState('')
  const [authOutcome, setAuthOutcome] = useState<'success' | 'failure' | null>(null)

  const verifyMutation = useMutation({
    mutationFn: async (code: string) => {
      // The pending-2FA token is in the wgc_pending2fa HttpOnly cookie (set
      // at login); the browser sends it automatically. No CSRF token exists
      // yet — this endpoint is pre-session.
      const res = await apiFetch('/api/auth/2fa/verify', {
        method: 'POST',
        body: { code },
        skipCsrf: true,
      })
      if (!res.ok) {
        const error = await res.json().catch(() => null)
        throw new Error((error as { error?: string } | null)?.error || 'Verification failed')
      }
      return res.json() as Promise<Verify2FAResponse>
    },
    onSuccess: (data) => {
      setCsrfToken(data.csrf_token)
      setAuthOutcome('success')
    },
    onError: () => {
      setAuthOutcome('failure')
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (code.length === 6) {
      verifyMutation.mutate(code)
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#04060c] flex items-center justify-center px-4">
      <HoloPageBackground />
      <div className="relative z-10 w-full max-w-md bg-[#080d16]/80 backdrop-blur-md border border-teal-500/25 rounded-xl p-8 shadow-[0_0_60px_-18px_rgba(45,212,191,0.55)]">
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

      {authOutcome && (
        <AuthStatusOverlay
          status={authOutcome}
          message={authOutcome === 'failure' ? verifyMutation.error?.message : undefined}
          onDone={() => {
            if (authOutcome === 'success') {
              window.location.href = '/dashboard'
              return
            }
            setAuthOutcome(null)
          }}
        />
      )}
    </div>
  )
}
