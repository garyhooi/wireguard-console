import { useEffect } from 'react'

// Full-page "hologram power-down" shown when an admin signs out: the console
// dims, the HUD rings collapse inward, scanlines sweep up, a power symbol
// strokes out and the session label fades — then the caller redirects to
// /login. ~1.8s, CSS-only, reduced-motion friendly.

const KEYFRAMES = `
@keyframes wgc-out-fade { 0% { opacity: 0 } 8% { opacity: 1 } 78% { opacity: 1 } 100% { opacity: 0 } }
@keyframes wgc-out-dim { 0% { opacity: 0 } 30% { opacity: .88 } 100% { opacity: .96 } }
@keyframes wgc-out-ring { 0% { transform: scale(1.55); opacity: 0 } 20% { opacity: .8 } 100% { transform: scale(.35); opacity: 0 } }
@keyframes wgc-out-spin { to { transform: rotate(360deg) } }
@keyframes wgc-out-spin-rev { to { transform: rotate(-360deg) } }
@keyframes wgc-out-scan { 0% { transform: translateY(60vh); opacity: 0 } 20% { opacity: 1 } 100% { transform: translateY(-90vh); opacity: 0 } }
@keyframes wgc-out-draw { to { stroke-dashoffset: 0 } }
@keyframes wgc-out-pop { 0% { transform: scale(.7); opacity: 0 } 50% { transform: scale(1.05); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
@keyframes wgc-out-flicker { 0%, 100% { opacity: 1 } 12% { opacity: .35 } 22% { opacity: 1 } 30% { opacity: .6 } 38% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) {
  .wgc-out-anim, .wgc-out-anim * { animation-duration: 1ms !important; animation-iteration-count: 1 !important; }
}
`

interface SignOutOverlayProps {
  /** How long the effect runs before onDone fires. Default 1800 ms. */
  durationMs?: number
  onDone: () => void
}

export function SignOutOverlay({ durationMs = 1800, onDone }: SignOutOverlayProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, durationMs)
    return () => window.clearTimeout(timer)
  }, [durationMs, onDone])

  const accent = '#2dd4bf'
  const accentSoft = 'rgba(45,212,191,'
  const ringColor = 'rgba(45,212,191,.5)'

  return (
    <div
      role="status"
      aria-live="polite"
      className="wgc-out-anim fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
      style={{ animation: 'wgc-out-fade ' + durationMs + 'ms ease-in-out forwards' }}
    >
      <style>{KEYFRAMES}</style>

      {/* Page dims toward black as the tunnel shuts down. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[#04060c]"
        style={{ animation: 'wgc-out-dim ' + durationMs + 'ms ease-out forwards' }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 50%, ' + accentSoft + '0.22) 0%, ' + accentSoft + '0.06) 40%, rgba(4,6,12,0) 70%)',
        }}
      />

      {/* Rising scanlines (reverse of the sign-in sweep). */}
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.14]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(255,255,255,.45) 0px, rgba(255,255,255,.45) 1px, transparent 1px, transparent 3px)',
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 h-44"
        style={{
          background: 'linear-gradient(180deg, ' + accentSoft + '0) 0%, ' + accentSoft + '0.20) 50%, ' + accentSoft + '0) 100%)',
          animation: 'wgc-out-scan 1.35s ease-in-out infinite',
        }}
      />

      {/* Center: collapsing HUD rings + power symbol. */}
      <div className="relative flex flex-col items-center px-6 text-center">
        <div className="relative flex h-44 w-44 items-center justify-center">
          {[0, 0.16, 0.32].map((delay) => (
            <span
              key={delay}
              aria-hidden="true"
              className="absolute inset-0 rounded-full border"
              style={{
                borderColor: ringColor,
                animation: 'wgc-out-ring 1.35s ease-in ' + delay + 's infinite',
              }}
            />
          ))}
          <span
            aria-hidden="true"
            className="absolute inset-2 rounded-full border border-dashed"
            style={{ borderColor: 'rgba(45,212,191,.28)', animation: 'wgc-out-spin 4.5s linear infinite' }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-6 rounded-full border"
            style={{
              borderColor: 'rgba(45,212,191,.18)',
              borderStyle: 'dotted',
              animation: 'wgc-out-spin-rev 7s linear infinite',
            }}
          />
          <span
            className="relative flex h-24 w-24 items-center justify-center rounded-full"
            style={{
              border: '1px solid ' + accent,
              backgroundColor: 'rgba(6,20,20,.85)',
              boxShadow: '0 0 42px ' + accentSoft + '0.45), inset 0 0 24px ' + accentSoft + '0.16)',
              color: accent,
              animation: 'wgc-out-pop .45s cubic-bezier(.22,1,.36,1) both',
            }}
          >
            <svg viewBox="0 0 52 52" className="h-14 w-14" fill="none" aria-hidden="true">
              <circle
                cx="26" cy="26" r="15"
                stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                strokeDasharray="78 94"
                transform="rotate(-90 26 26)"
                style={{ strokeDashoffset: 78, animation: 'wgc-out-draw .55s .12s ease-out forwards' }}
              />
              <path
                d="M26 14 L26 26"
                stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                strokeDasharray="12 12"
                style={{ strokeDashoffset: 12, animation: 'wgc-out-draw .35s .45s ease-out forwards' }}
              />
            </svg>
          </span>
        </div>

        <p
          className="mt-8 text-[11px] font-semibold uppercase tracking-[0.42em]"
          style={{ color: accent, opacity: 0.85, animation: 'wgc-out-flicker .9s .15s linear 1' }}
        >
          Tunnel closing
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[0.08em] text-zinc-100 sm:text-3xl">
          SESSION TERMINATED
        </h2>
        <p className="mt-2 text-sm text-zinc-400">Signing you out securely…</p>
      </div>
    </div>
  )
}
