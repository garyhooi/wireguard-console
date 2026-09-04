import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { IconDownload } from '@tabler/icons-react'
import { PrimaryButton, inputCls, labelCls } from '../lib/ui'

interface ClaimResponse {
  peer_id: string
  config: string
}

export const Route = createFileRoute('/claim/$token')({
  component: ClaimPage,
})

function ClaimPage() {
  const { token } = Route.useParams()
  const [step, setStep] = useState<'form' | 'success'>('form')
  const [fullName, setFullName] = useState('')
  const [response, setResponse] = useState<ClaimResponse | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')

  const claimMutation = useMutation({
    mutationFn: async (data: { token: string; full_name: string; public_key: string }) => {
      const res = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to claim account')
      return res.json() as Promise<ClaimResponse>
    },
    onSuccess: (data) => {
      setResponse(data)
      setStep('success')
      // The QR encodes the same client config the user downloads — rendered
      // in the browser (the API has no QR-image endpoint).
      void QRCode.toDataURL(data.config, { width: 320, margin: 1 }).then(setQrDataUrl)
    },
  })

  const handleClaim = () => {
    // Keys are generated server-side; the config (with the private key)
    // comes back in the response.
    claimMutation.mutate({ token, full_name: fullName, public_key: '' })
  }

  const downloadConfig = () => {
    if (!response) return
    const blob = new Blob([response.config], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'wireguard.conf'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md bg-zinc-900/60 border border-zinc-800 rounded-xl p-8 shadow-2xl">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100 mb-6">
          Claim Your VPN Account
        </h1>

        {step === 'form' && (
          <div className="space-y-6">
            <div>
              <label htmlFor="fullName" className={labelCls}>
                Your Name
              </label>
              <input
                id="fullName"
                type="text"
                className={inputCls}
                placeholder="John Doe"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>

            <div>
              <label className={labelCls}>Invite token (from your email link)</label>
              <p className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-zinc-100 font-mono text-sm break-all">
                {token.slice(0, 24)}…
              </p>
            </div>

            {claimMutation.error && <div className="text-red-400 text-sm">{claimMutation.error.message}</div>}

            <PrimaryButton
              onClick={handleClaim}
              disabled={claimMutation.isPending || !fullName}
              className="w-full"
            >
              {claimMutation.isPending ? 'Creating…' : 'Claim Account'}
            </PrimaryButton>
          </div>
        )}

        {step === 'success' && response && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-lg font-semibold text-teal-400 mb-2">Account Claimed!</h2>
              <p className="text-zinc-400 text-sm">Your VPN profile has been created successfully.</p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-zinc-400 mb-2">Configuration</h3>
              <div className="bg-zinc-800 rounded-md p-4 mb-3">
                <pre className="text-xs text-zinc-300 font-mono overflow-auto max-h-48">{response.config}</pre>
              </div>
              <PrimaryButton onClick={downloadConfig} className="w-full">
                <IconDownload size={16} stroke={1.6} aria-hidden="true" />
                Download .conf
              </PrimaryButton>
            </div>

            <div>
              <h3 className="text-sm font-medium text-zinc-400 mb-2">Scan QR Code</h3>
              <div className="bg-white p-4 rounded-lg inline-block mx-auto block">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="WireGuard config QR code" className="w-48 h-48" />
                ) : (
                  <div className="w-48 h-48 flex items-center justify-center text-zinc-400 text-sm">
                    Generating…
                  </div>
                )}
              </div>
              <p className="text-zinc-400 text-sm mt-2 text-center">
                Scan with WireGuard app on iOS or Android
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
