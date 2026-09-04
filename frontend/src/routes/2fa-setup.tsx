import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { PrimaryButton, inputCls, labelCls } from '../lib/ui'

interface TOTPSetupResponse {
  secret: string
  otpauth_url: string
  qr_code_url: string
}

interface Enable2FAResponse {
  backup_codes: string[]
  message: string
}

export const Route = createFileRoute('/2fa-setup')({
  component: Setup2FAPage,
  beforeLoad: async () => {
    const token = localStorage.getItem('token')
    if (!token) {
      window.location.href = '/login'
    }
  },
})

function Setup2FAPage() {
  const [step, setStep] = useState<'setup' | 'verify' | 'complete'>('setup')
  const [totpData, setTotpData] = useState<TOTPSetupResponse | null>(null)
  const [code, setCode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])

  const setupMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/auth/2fa/setup', {
        method: 'POST',
        headers: { Authorization: localStorage.getItem('token')! },
      })
      if (!res.ok) throw new Error('Failed to setup 2FA')
      return res.json() as Promise<TOTPSetupResponse>
    },
    onSuccess: (data) => {
      setTotpData(data)
      setStep('verify')
    },
  })

  const enableMutation = useMutation({
    mutationFn: async (code: string) => {
      const res = await fetch('/api/auth/2fa/enable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: localStorage.getItem('token')!,
        },
        body: JSON.stringify({
          secret: totpData?.secret,
          code,
        }),
      })
      if (!res.ok) throw new Error('Invalid code')
      return res.json() as Promise<Enable2FAResponse>
    },
    onSuccess: (data) => {
      setBackupCodes(data.backup_codes)
      setStep('complete')
    },
  })

  const handleSetup = () => {
    setupMutation.mutate()
  }

  const handleVerify = () => {
    enableMutation.mutate(code)
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-zinc-900/60 border border-zinc-800 rounded-xl p-8 shadow-2xl">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100 mb-6">
          Enable Two-Factor Authentication
        </h1>

        {step === 'setup' && (
          <div>
            <p className="text-zinc-400 text-sm mb-6 leading-relaxed">
              Add an extra layer of security to your account. You'll need an authenticator app like Google Authenticator, Authy, or 1Password.
            </p>
            <PrimaryButton onClick={handleSetup} disabled={setupMutation.isPending} className="w-full">
              {setupMutation.isPending ? 'Generating…' : 'Setup 2FA'}
            </PrimaryButton>
          </div>
        )}

        {step === 'verify' && totpData && (
          <div>
            <div className="mb-6">
              <h2 className="text-base font-semibold text-zinc-100 mb-4">Scan QR Code</h2>
              <div className="bg-white p-4 rounded-lg inline-block">
                <img src={totpData.qr_code_url} alt="QR Code" className="w-48 h-48" />
              </div>
              <p className="text-zinc-400 text-sm mt-4">
                Or enter this key manually in your authenticator app: <br />
                <code className="bg-zinc-800 px-2 py-1 rounded text-teal-400">{totpData.secret}</code>
              </p>
            </div>

            <div className="mb-6">
              <label htmlFor="code" className={labelCls}>
                Enter 6-digit code
              </label>
              <input
                id="code"
                type="text"
                maxLength={6}
                className={inputCls}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </div>

            {enableMutation.error && (
              <div className="text-red-400 text-sm mb-4">Invalid code. Please try again.</div>
            )}

            <PrimaryButton
              onClick={handleVerify}
              disabled={enableMutation.isPending || code.length !== 6}
              className="w-full"
            >
              {enableMutation.isPending ? 'Enabling…' : 'Enable 2FA'}
            </PrimaryButton>
          </div>
        )}

        {step === 'complete' && (
          <div>
            <div className="mb-6">
              <h2 className="text-base font-semibold text-teal-400 mb-2">2FA Enabled!</h2>
              <p className="text-zinc-400 text-sm">
                {backupCodes.length > 0 && enableMutation.variables && (
                  <span>Save these backup codes. They can only be shown once and will be needed if you lose access to your authenticator app.</span>
                )}
              </p>
            </div>

            <div className="mb-6">
              <h3 className="text-sm font-medium text-zinc-400 mb-2">Backup Codes</h3>
              <div className="bg-zinc-800 rounded-md p-4">
                <div className="grid grid-cols-2 gap-2">
                  {backupCodes.map((code, index) => (
                    <code key={index} className="text-sm text-zinc-300 font-mono">{code}</code>
                  ))}
                </div>
              </div>
            </div>

            <PrimaryButton onClick={() => window.location.href = '/dashboard'} className="w-full">
              Continue to Dashboard
            </PrimaryButton>
          </div>
        )}
      </div>
    </div>
  )
}
