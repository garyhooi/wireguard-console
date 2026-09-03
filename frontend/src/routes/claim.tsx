import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'

interface ClaimResponse {
  peer_id: string
  config: string
  qr_code_url: string
}

export const Route = createFileRoute('/claim')({
  component: ClaimPage,
})

function ClaimPage() {
  const [step, setStep] = useState<'form' | 'success'>('form')
  const [fullName, setFullName] = useState('')
  const [token, setToken] = useState('')
  const [response, setResponse] = useState<ClaimResponse | null>(null)

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
    },
  })

  const handleGenerateKey = () => {
    // Generate WireGuard keypair in browser
    const keygen = window.crypto.subtle
    keygen.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    ).then((keyPair: CryptoKeyPair) => {
      keygen.exportKey('raw', keyPair.publicKey).then((publicKeyRaw: ArrayBuffer) => {
        // Convert raw public key to base64 (WireGuard format)
        const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyRaw)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '')

        claimMutation.mutate({
          token,
          full_name: fullName,
          public_key: publicKeyBase64,
        })
      })
    })
  }

  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-neutral-900 border border-neutral-800 rounded-lg p-8">
        <h1 className="text-2xl font-bold text-white mb-6">Claim Your VPN Account</h1>

        {step === 'form' && (
          <div className="space-y-6">
            <div>
              <label htmlFor="fullName" className="block text-sm font-medium text-neutral-400 mb-2">
                Your Name
              </label>
              <input
                id="fullName"
                type="text"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                placeholder="John Doe"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="token" className="block text-sm font-medium text-neutral-400 mb-2">
                Invite Token
              </label>
              <input
                id="token"
                type="text"
                className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-3 py-2 text-white font-mono focus:outline-none focus:ring-2 focus:ring-teal-500"
                placeholder="Enter token from email"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>

            {claimMutation.error && (
              <div className="text-red-500 text-sm">
                {claimMutation.error.message}
              </div>
            )}

            <button
              onClick={handleGenerateKey}
              disabled={claimMutation.isPending || !fullName || !token}
              className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-2 px-4 rounded-md disabled:opacity-50"
            >
              {claimMutation.isPending ? 'Creating...' : 'Claim Account'}
            </button>
          </div>
        )}

        {step === 'success' && response && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-lg font-semibold text-green-500 mb-2">Account Claimed!</h2>
              <p className="text-neutral-400 text-sm">
                Your VPN profile has been created successfully.
              </p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-neutral-400 mb-2">Download Configuration</h3>
              <div className="bg-neutral-800 rounded-md p-4">
                <pre className="text-xs text-neutral-300 font-mono overflow-auto max-h-48">
                  {response.config}
                </pre>
              </div>
              <button
                onClick={() => {
                  const blob = new Blob([response.config], { type: 'text/plain' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = 'wireguard.conf'
                  a.click()
                  URL.revokeObjectURL(url)
                }}
                className="mt-2 w-full bg-neutral-700 hover:bg-neutral-600 text-white font-medium py-2 px-4 rounded-md"
              >
                Download .conf File
              </button>
            </div>

            <div>
              <h3 className="text-sm font-medium text-neutral-400 mb-2">Scan QR Code</h3>
              <div className="bg-white p-4 rounded-lg inline-block mx-auto block">
                <img src={response.qr_code_url} alt="QR Code" className="w-48 h-48" />
              </div>
              <p className="text-neutral-400 text-sm mt-2 text-center">
                Scan with WireGuard app on iOS or Android
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
