import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { PrimaryButton, inputCls, labelCls } from '../lib/ui'
import { HoloPageBackground } from '../components/HoloPageBackground'
import { apiFetch, setCsrfToken } from '../lib/api'

interface TOTPSetupResponse {
  secret: string
  otpauth_url: string
}

interface Enable2FAResponse {
  backup_codes: string[]
  message: string
  csrf_token?: string
}

export const Route = createFileRoute('/2fa-setup')({
  component: Setup2FAPage,
})

function Setup2FAPage() {
  // Forced enrollment: Login grants no session for an admin without TOTP;
  // the pending cookie only authorizes the *-pending endpoints. This mode
  // starts automatically and mints the real session after the first code.
  const forced =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('forced') === '1'
  const setupPath = forced ? '/api/auth/2fa/setup-pending' : '/api/auth/2fa/setup'
  const enablePath = forced ? '/api/auth/2fa/enable-pending' : '/api/auth/2fa/enable'

  const [step, setStep] = useState<'setup' | 'verify' | 'complete'>('setup')
  const [totpData, setTotpData] = useState<TOTPSetupResponse | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [code, setCode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])

  const setupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(setupPath, {
        method: 'POST',
        skipCsrf: true,
        noAuthRedirect: true,
      })
      if (!res.ok) throw new Error('Failed to setup 2FA')
      return res.json() as Promise<TOTPSetupResponse>
    },
    onSuccess: (data) => {
      setTotpData(data)
      setStep('verify')
      // The otpauth:// URI encodes the secret; render the QR in the browser
      // so the authenticator app can scan it.
      void QRCode.toDataURL(data.otpauth_url, { width: 320, margin: 1 }).then(setQrDataUrl)
    },
  })

  const enableMutation = useMutation({
    mutationFn: async (code: string) => {
      const res = await apiFetch(enablePath, {
        method: 'POST',
        skipCsrf: true,
        noAuthRedirect: true,
        body: {
          secret: totpData?.secret,
          code,
        },
      })
      if (!res.ok) throw new Error('Invalid code')
      return res.json() as Promise<Enable2FAResponse>
    },
    onSuccess: (data) => {
      // Forced enrollment returns a fresh session CSRF token (the pending
      // cookie was swapped for a real session cookie by the server).
      if (data.csrf_token) setCsrfToken(data.csrf_token)
      setBackupCodes(data.backup_codes)
      setStep('complete')
    },
  })

  // In forced mode the user cannot do anything else, so generate the secret
  // immediately instead of making them press an extra button.
  useEffect(() => {
    if (forced) setupMutation.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forced])

  const handleSetup = () => {
    setupMutation.mutate()
  }

  const handleVerify = () => {
    enableMutation.mutate(code)
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#04060c] flex items-center justify-center px-4">
      <HoloPageBackground />
      <div className="relative z-10 w-full max-w-md bg-[#080d16]/80 backdrop-blur-md border border-teal-500/25 rounded-xl p-8 shadow-[0_0_60px_-18px_rgba(45,212,191,0.55)]">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100 mb-6">
          Enable Two-Factor Authentication
        </h1>

        {step === 'setup' && (
          <div>
            <p className="text-zinc-400 text-sm mb-6 leading-relaxed">
              {forced ? (
                <>
                  <span className="block text-amber-400/90 mb-2">
                    Two-factor authentication is required before you can use the console.
                  </span>
                  Set it up now with an authenticator app like Google Authenticator, Authy, or
                  1Password — you will use a code on every future sign-in.
                </>
              ) : (
                'Add an extra layer of security to your account. You will need an authenticator app like Google Authenticator, Authy, or 1Password.'
              )}
            </p>
            {!forced && (
              <PrimaryButton onClick={handleSetup} disabled={setupMutation.isPending} className="w-full">
                {setupMutation.isPending ? 'Generating…' : 'Setup 2FA'}
              </PrimaryButton>
            )}
            {forced && setupMutation.isPending && (
              <p className="text-zinc-400 text-sm">Generating your setup key…</p>
            )}
            {forced && setupMutation.isError && (
              <p className="text-red-400 text-sm">
                Setup session expired. Sign in again to continue.
              </p>
            )}
          </div>
        )}

        {step === 'verify' && totpData && (
          <div>
            <div className="mb-6">
              <h2 className="text-base font-semibold text-zinc-100 mb-4">Scan QR Code</h2>
              <div className="bg-white p-4 rounded-lg inline-block">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="TOTP setup QR code" className="w-48 h-48" />
                ) : (
                  <div className="w-48 h-48 flex items-center justify-center text-zinc-400 text-sm">
                    Generating…
                  </div>
                )}
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
