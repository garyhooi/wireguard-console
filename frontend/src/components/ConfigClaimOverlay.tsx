import { IconShieldCheck } from '@tabler/icons-react'

// Full-screen teal "claim handshake" hologram shown while a peer config is
// being generated/claimed. The parent enforces a minimum on-screen time
// (~2.4s) so the animation is always seen — this component only paints it.
//
// Same design language as SignOutOverlay / AuthStatusOverlay: CSS keyframes
// inlined with the component (no external stylesheet), fixed full-screen
// layer, decorative layers are aria-hidden + pointer-events-none, and a
// reduced-motion block disables every animation.

const KEYFRAMES = `
@keyframes wgc-claim-fade { 0% { opacity: 0 } 10% { opacity: 1 } 100% { opacity: 1 } }
@keyframes wgc-claim-grid { 0% { background-position: 0 0, 0 0 } 100% { background-position: 0 46px, 46px 0 } }
@keyframes wgc-claim-glow { 0%, 100% { opacity: .34; transform: scale(1) } 50% { opacity: .7; transform: scale(1.07) } }
@keyframes wgc-claim-ring { 0% { transform: scale(.72); opacity: .85 } 78% { opacity: .22 } 100% { transform: scale(1.72); opacity: 0 } }
@keyframes wgc-claim-scan { 0% { transform: translateY(-54vh); opacity: 0 } 12% { opacity: 1 } 88% { opacity: 1 } 100% { transform: translateY(54vh); opacity: 0 } }
@keyframes wgc-claim-spin { to { transform: rotate(360deg) } }
@keyframes wgc-claim-spin-rev { to { transform: rotate(-360deg) } }
@keyframes wgc-claim-badge { 0% { transform: scale(.72); opacity: 0 } 55% { transform: scale(1.05); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
@keyframes wgc-claim-icon { 0%, 100% { opacity: .8; transform: scale(1) } 50% { opacity: 1; transform: scale(1.06) } }
@keyframes wgc-claim-label { 0%, 100% { opacity: .5 } 50% { opacity: .95 } }
@media (prefers-reduced-motion: reduce) {
  .wgc-claim-anim, .wgc-claim-anim * { animation: none !important; }
}
`

export function ConfigClaimOverlay() {
  const accent = '#2dd4bf'
  const accentSoft = 'rgba(45,212,191,'

  return (
    <div
      data-testid="config-claim-overlay"
      role="status"
      aria-live="polite"
      className="wgc-claim-anim fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-[#04060c]"
      style={{ animation: 'wgc-claim-fade .45s ease-out both' }}
    >
      <style>{KEYFRAMES}</style>

      {/* Dim + soften whatever is behind the overlay. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[#04060c]/90 backdrop-blur-[2px]" />

      {/* Drifting teal holo-grid. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(45,212,191,.4) 1px, transparent 1px), linear-gradient(90deg, rgba(45,212,191,.4) 1px, transparent 1px)',
          backgroundSize: '46px 46px',
          animation: 'wgc-claim-grid 9s linear infinite',
        }}
      />

      {/* Central radial glow behind the badge. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[44rem] w-[44rem] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[120px]"
        style={{
          background:
            'radial-gradient(circle, ' + accentSoft + '0.30) 0%, ' + accentSoft + '0.10) 44%, rgba(4,6,12,0) 72%)',
          animation: 'wgc-claim-glow 5s ease-in-out infinite',
        }}
      />

      {/* Scanning band sweeping down the full viewport. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-44"
        style={{
          background:
            'linear-gradient(180deg, ' + accentSoft + '0) 0%, ' + accentSoft + '0.16) 50%, ' + accentSoft + '0) 100%)',
          animation: 'wgc-claim-scan 2.4s ease-in-out infinite',
        }}
      />

      {/* Center: expanding rings + rotating HUD + glowing shield. */}
      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        <div className="relative flex h-44 w-44 items-center justify-center">
          {/* Two expanding rings. */}
          {[0, 1.1].map((delay) => (
            <span
              key={delay}
              aria-hidden="true"
              className="absolute inset-0 rounded-full border"
              style={{
                borderColor: 'rgba(45,212,191,.5)',
                animation: 'wgc-claim-ring 2.2s ease-out ' + delay + 's infinite',
              }}
            />
          ))}
          {/* Rotating HUD ring (dashed) + counter-rotating dotted ring. */}
          <span
            aria-hidden="true"
            className="absolute inset-1 rounded-full border border-dashed"
            style={{ borderColor: 'rgba(45,212,191,.5)', animation: 'wgc-claim-spin 5.5s linear infinite' }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-4 rounded-full border"
            style={{
              borderColor: 'rgba(45,212,191,.24)',
              borderStyle: 'dotted',
              animation: 'wgc-claim-spin-rev 8.5s linear infinite',
            }}
          />

          {/* Core badge: glowing shield with a soft pulse. */}
          <span
            className="relative flex h-24 w-24 items-center justify-center rounded-full"
            style={{
              border: '1px solid ' + accent,
              backgroundColor: 'rgba(6,24,22,.85)',
              boxShadow: '0 0 46px ' + accentSoft + '0.5), inset 0 0 24px ' + accentSoft + '0.16)',
              color: accent,
              animation: 'wgc-claim-badge .55s cubic-bezier(.22,1,.36,1) both',
            }}
          >
            <IconShieldCheck
              size={48}
              stroke={1.4}
              aria-hidden="true"
              style={{ animation: 'wgc-claim-icon 1.6s ease-in-out infinite' }}
            />
          </span>
        </div>

        <p
          className="mt-8 font-mono text-[11px] uppercase tracking-[0.42em]"
          style={{ color: accent, animation: 'wgc-claim-label 2.4s ease-in-out infinite' }}
        >
          Secure link
        </p>
        <h2
          className="mt-2 text-2xl font-semibold tracking-[0.08em] text-zinc-100 sm:text-3xl"
          style={{ textShadow: '0 0 26px ' + accentSoft + '0.45)' }}
        >
          CLAIMING CONFIGURATION
        </h2>
        <p className="mt-2 text-sm text-zinc-400">Preparing your WireGuard profile…</p>
      </div>
    </div>
  )
}
