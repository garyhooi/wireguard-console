import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { IconDownload } from '@tabler/icons-react'
import { PrimaryButton } from '../lib/ui'
import { HoloPageBackground } from '../components/HoloPageBackground'
import { LinkInvalidOverlay } from '../components/LinkInvalidOverlay'

interface PeerConfigResponse {
  peer_name: string
  config: string
}

export const Route = createFileRoute('/peer/$token')({
  component: PeerConfigPage,
})

function PeerConfigPage() {
  const { token } = Route.useParams()
  const [qrDataUrl, setQrDataUrl] = useState('')

  const { data, isError, isLoading } = useQuery<PeerConfigResponse>({
    queryKey: ['peer-config', token],
    queryFn: async () => {
      const res = await fetch(`/api/peer-config/${token}`)
      if (!res.ok) throw new Error('Link is invalid or has expired')
      return res.json()
    },
  })

  // Render the QR once the config arrives.
  useEffect(() => {
    if (data?.config) {
      void QRCode.toDataURL(data.config, { width: 320, margin: 1 }).then(setQrDataUrl)
    }
  }, [data])

  const config = data?.config

  // Invalid / expired / revoked link: persistent full-screen red status.
  if (isError) {
    return (
      <LinkInvalidOverlay
        title="LINK EXPIRED OR INVALID"
        detail="This configuration link is no longer valid. Ask the administrator who set up your device to send a fresh link."
      />
    )
  }

  const downloadConfig = () => {
    if (!config) return
    const blob = new Blob([config], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${data?.peer_name || 'wireguard'}.conf`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#04060c] flex items-center justify-center px-4 py-10">
      <HoloPageBackground />
      <div className="relative z-10 w-full max-w-md bg-[#080d16]/80 backdrop-blur-md border border-teal-500/25 rounded-xl p-8 shadow-[0_0_60px_-18px_rgba(45,212,191,0.55)]">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100 mb-6">
          Your VPN Configuration
        </h1>

        {isLoading && (
          <p className="text-zinc-400 text-sm">Loading your configuration…</p>
        )}

        {data && config && (
          <div className="space-y-6">
            <p className="text-zinc-400 text-sm">
              {data.peer_name ? (
                <>
                  Your device <strong className="text-zinc-200">{data.peer_name}</strong> is
                  ready. Download the config or scan the QR code to import it into the
                  WireGuard app.
                </>
              ) : (
                <>Your device is ready. Download the config or scan the QR code to import it into the WireGuard app.</>
              )}
            </p>

            <div>
              <h3 className="text-sm font-medium text-zinc-400 mb-2">Download</h3>
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
                Scan with the WireGuard app on iOS or Android
              </p>
            </div>

            <div>
              <h3 className="text-sm font-medium text-zinc-400 mb-2">Configuration</h3>
              <div className="bg-zinc-800 rounded-md p-4">
                <pre className="text-xs text-zinc-300 font-mono overflow-auto max-h-48 whitespace-pre-wrap break-all">
                  {config}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
