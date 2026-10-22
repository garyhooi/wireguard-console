import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { IconDownload, IconShieldCheck } from '@tabler/icons-react'
import { PrimaryButton } from '../lib/ui'
import { configFileName } from '../lib/filename'
import { HoloPageBackground } from '../components/HoloPageBackground'
import { LinkInvalidOverlay } from '../components/LinkInvalidOverlay'
import { ConfigClaimOverlay } from '../components/ConfigClaimOverlay'

interface PeerConfigResponse {
  peer_name: string
  config: string
}

type Phase = 'claim' | 'claiming' | 'ready' | 'invalid'

export const Route = createFileRoute('/peer/$token')({
  component: PeerConfigPage,
})

// The email link opens on a deliberate claim screen: the config is NOT
// fetched until the holder claims the link. The request then runs behind a
// full-screen hologram for at least `minClaimMs` (unless it is slower, in
// which case the reveal waits for it) so the animation never flashes past.
const REVEAL_KEYFRAMES = `
@keyframes wgc-peer-reveal { 0% { opacity: 0; transform: translateY(10px) scale(.985) } 100% { opacity: 1; transform: translateY(0) scale(1) } }
@media (prefers-reduced-motion: reduce) {
  .wgc-peer-reveal { animation: none !important; }
}
`

interface PeerConfigPageProps {
  /** Minimum time the claim hologram stays up before the config may appear. */
  minClaimMs?: number
  /** Route token; defaults to the matched /peer/$token param (tests pass a stub). */
  token?: string
}

export function PeerConfigPage({ minClaimMs = 2400, token: tokenProp }: PeerConfigPageProps) {
  const params = Route.useParams()
  const token = tokenProp ?? params.token

  const [phase, setPhase] = useState<Phase>('claim')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const claimStartedAt = useRef(0)

  const { data, isError, isPending } = useQuery<PeerConfigResponse>({
    queryKey: ['peer-config', token],
    // Deliberate gate: no API call until the link is claimed.
    enabled: phase !== 'claim',
    retry: false,
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

  // Advance only after BOTH the request settled AND the minimum animation
  // time elapsed. A slow request is never cut short by the animation; a fast
  // one still plays the full hologram.
  useEffect(() => {
    if (phase !== 'claiming' || isPending) return
    if (!isError && !data) return
    const remaining = Math.max(0, minClaimMs - (Date.now() - claimStartedAt.current))
    if (remaining === 0) {
      setPhase(isError ? 'invalid' : 'ready')
      return
    }
    const timer = window.setTimeout(() => setPhase(isError ? 'invalid' : 'ready'), remaining)
    return () => window.clearTimeout(timer)
  }, [phase, isPending, isError, data, minClaimMs])

  const config = data?.config

  const startClaim = () => {
    if (phase !== 'claim') return
    claimStartedAt.current = Date.now()
    setPhase('claiming')
  }

  // Invalid / expired / revoked link: persistent full-screen red status.
  if (phase === 'invalid') {
    return (
      <LinkInvalidOverlay
        title="LINK EXPIRED OR INVALID"
        detail="This configuration link is no longer valid. Ask the administrator who set up your device to send a fresh link."
      />
    )
  }

  // Full-screen hologram while the claim request runs behind it.
  if (phase === 'claiming') {
    return <ConfigClaimOverlay />
  }

  const downloadConfig = () => {
    if (!config) return
    const blob = new Blob([config], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = configFileName(data?.peer_name)
    a.click()
    URL.revokeObjectURL(url)
  }

  const cardCls =
    'relative z-10 w-full max-w-md bg-[#080d16]/80 backdrop-blur-md border border-teal-500/25 rounded-xl p-8 shadow-[0_0_60px_-18px_rgba(45,212,191,0.55)]'

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#04060c] flex items-center justify-center px-4 py-10">
      <style>{REVEAL_KEYFRAMES}</style>
      <HoloPageBackground />

      {phase === 'claim' ? (
        // Deliberate claim gate: headline, one line of copy, one action.
        <div className={cardCls} data-testid="peer-config-claim">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
            Your VPN Configuration
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-zinc-400">
            This link is ready. Claim it to generate your WireGuard configuration.
          </p>
          <PrimaryButton onClick={startClaim} className="w-full mt-6">
            <IconShieldCheck size={16} stroke={1.6} aria-hidden="true" />
            Claim Configuration
          </PrimaryButton>
          <p className="mt-5 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-600">
            Only claim on this device
          </p>
        </div>
      ) : (
        // Ready: the existing config card, revealed with a subtle fade-slide.
        <div
          className={cardCls + ' wgc-peer-reveal'}
          data-testid="peer-config-ready"
          style={{ animation: 'wgc-peer-reveal 460ms cubic-bezier(.22,1,.36,1) both' }}
        >
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100 mb-6">
            Your VPN Configuration
          </h1>

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
      )}
    </div>
  )
}
