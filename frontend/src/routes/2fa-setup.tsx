import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

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
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-neutral-900 border border-neutral-800 rounded-lg p-8">
        <h1 className="text-2xl font-bold text-white mb-6">Enable Two-Factor Authentication</h1>

        {step === 'setup' && (
          <div>
            <p className="text-neutral-400 mb-6">
              Add an extra layer of security to your account. You'll need an authenticator app like Google Authenticator, Authy, or 1Password.
            </p>
            <button
              onClick={handleSetup}
              disabled={setupMutation.isPending}
              className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md disabled:opacity-50"
            >
              {setupMutation.isPending ? 'Generating...' : 'Setup 2FA'}
            </button>
          </div>
        )}

        {step === 'verify' && totpData && (
          <div>
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-white mb-4">Scan QR Code</h2>
              <div className="bg-white p-4 rounded-lg inline-block">
                <img src={totpData.qr_code_url} alt="QR Code" className="w-48 h-48" />
              </div>
              <p className="text-neutral-400 text-sm mt-4">
                Or enter this key manually in your authenticator app: <br />
                <code className="bg-neutral-800 px-2 py-1 rounded text-teal-400">{totpData.secret}</code>
              </p>
            </div>

            <div className="mb-6">
              <label htmlFor="code" className="block text-sm font-medium text-neutral-400 mb-2">
                Enter 6-digit code
              </label>
              <input
                id="code"
                type="text"
                maxLength={6}
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </div>

            {enableMutation.error && (
              <div className="text-red-500 text-sm mb-4">
                Invalid code. Please try again.
              </div>
            )}

            <button
              onClick={handleVerify}
              disabled={enableMutation.isPending || code.length !== 6}
              className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md disabled:opacity-50"
            >
              {enableMutation.isPending ? 'Enabling...' : 'Enable 2FA'}
            </button>
          </div>
        )}

        {step === 'complete' && (
          <div>
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-green-500 mb-2">2FA Enabled!</h2>
              <p className="text-neutral-400 text-sm">
                {backupCodes.length > 0 && enableMutation.variables && (
                  <span>Save these backup codes. They can only be shown once and will be needed if you lose access to your authenticator app.</span>
                )}
              </p>
            </div>

            <div className="mb-6">
              <h3 className="text-sm font-medium text-neutral-400 mb-2">Backup Codes</h3>
              <div className="bg-neutral-800 rounded-md p-4">
                <div className="grid grid-cols-2 gap-2">
                  {backupCodes.map((code, index) => (
                    <code key={index} className="text-sm text-neutral-300 font-mono">{code}</code>
                  ))}
                </div>
              </div>
            </div>

            <button
              onClick={() => window.location.href = '/dashboard'}
              className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md"
            >
              Continue to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
