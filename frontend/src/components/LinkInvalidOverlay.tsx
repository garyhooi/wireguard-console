import { IconLinkOff } from '@tabler/icons-react'

// Persistent full-screen red hologram shown when a public link (VPN invite or
// peer config) is expired, already used or invalid. Unlike the transient
// success/failure overlays this never auto-dismisses: the holder cannot do
// anything on this page, so the status stays on screen until the tab closes.

const KEYFRAMES = `
@keyframes wgc-linkfade { 0% { opacity: 0 } 8% { opacity: 1 } 100% { opacity: 1 } }
@keyframes wgc-linkgrid { 0% { background-position: 0 0, 0 0 } 100% { background-position: 0 44px, 44px 0 } }
@keyframes wgc-linkglow { 0%, 100% { opacity: .30; transform: scale(1) } 50% { opacity: .62; transform: scale(1.08) } }
@keyframes wgc-linkring { 0% { transform: scale(.85); opacity: .75 } 100% { transform: scale(1.65); opacity: 0 } }
@keyframes wgc-linkscan { 0% { transform: translateY(-52vh); opacity: 0 } 12% { opacity: 1 } 88% { opacity: 1 } 100% { transform: translateY(52vh); opacity: 0 } }
@keyframes wgc-linkicon { 0%, 100% { opacity: .72; transform: translateY(0) } 50% { opacity: 1; transform: translateY(-2px) } }
@media (prefers-reduced-motion: reduce) {
  .wgc-link-anim, .wgc-link-anim * { animation: none !important; }
}
`

interface LinkInvalidOverlayProps {
  /** Headline, e.g. "LINK EXPIRED" / "LINK INVALID". */
  title: string
  /** One-line explanation shown under the headline. */
  detail: string
}

export function LinkInvalidOverlay({ title, detail }: LinkInvalidOverlayProps) {
  return (
    <div
      data-testid="link-invalid-overlay"
      role="alert"
      className="wgc-link-anim fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-[#070408]"
      style={{ animation: 'wgc-linkfade .8s ease-out both' }}
    >
      <style>{KEYFRAMES}</style>

      {/* drifting red grid */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(248,113,113,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(248,113,113,.35) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          animation: 'wgc-linkgrid 12s linear infinite',
        }}
      />
      {/* central glow */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-[42rem] w-[42rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-600/20 blur-[120px]"
        style={{ animation: 'wgc-linkglow 6s ease-in-out infinite' }}
      />
      {/* scanning band */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-red-600/25 to-transparent"
        style={{ animation: 'wgc-linkscan 7s ease-in-out infinite' }}
      />

      <div className="relative z-10 w-full max-w-lg px-6 text-center">
        <div className="relative mx-auto mb-9 flex h-28 w-28 items-center justify-center">
          <span
            className="absolute inset-0 rounded-full border border-red-500/50"
            style={{ animation: 'wgc-linkring 2.4s ease-out infinite' }}
          />
          <span
            className="absolute inset-0 rounded-full border border-red-500/40"
            style={{ animation: 'wgc-linkring 2.4s ease-out infinite', animationDelay: '1.2s' }}
          />
          <span className="absolute inset-3 rounded-full bg-red-500/10 blur-md" />
          <IconLinkOff
            size={52}
            stroke={1.4}
            className="relative z-10 text-red-400"
            style={{ animation: 'wgc-linkicon 2.8s ease-in-out infinite' }}
            aria-hidden="true"
          />
        </div>

        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.5em] text-red-400/80">
          Access denied
        </p>
        <h1 className="mb-5 text-3xl font-semibold tracking-tight text-red-100 drop-shadow-[0_0_18px_rgba(248,113,113,0.45)] sm:text-4xl">
          {title}
        </h1>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-zinc-400">{detail}</p>
        <p className="mt-10 font-mono text-[10px] uppercase tracking-[0.35em] text-zinc-600">
          Ask your administrator for a new link
        </p>
      </div>
    </div>
  )
}
