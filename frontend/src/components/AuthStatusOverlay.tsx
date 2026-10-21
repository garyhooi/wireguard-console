import { useEffect } from 'react'

// Full-page "identity verification" animation shown for ~2 seconds while a
// sign-in / 2FA check completes: a hologram ring + scan sweep with a big
// green glow (success) or red glow + glitch (failure). The parent decides
// what happens after the animation (redirect or clear the error) via onDone.
//
// Style is inlined so the animation ships with the component; canvas-free
// (CSS transforms/opacity only) and reduced-motion friendly.

const KEYFRAMES = `
@keyframes wgc-auth-overlay { 0% { opacity: 0 } 6% { opacity: 1 } 84% { opacity: 1 } 100% { opacity: 0 } }
@keyframes wgc-auth-glow { 0% { opacity: 0; transform: scale(.9) } 10% { opacity: 1 } 22% { opacity: .55 } 34% { opacity: 1 } 76% { opacity: .75 } 100% { opacity: 0; transform: scale(1.04) } }
@keyframes wgc-auth-ring { 0% { transform: scale(.55); opacity: .9 } 75% { opacity: .18 } 100% { transform: scale(1.55); opacity: 0 } }
@keyframes wgc-auth-spin { to { transform: rotate(360deg) } }
@keyframes wgc-auth-spin-rev { to { transform: rotate(-360deg) } }
@keyframes wgc-auth-scan { 0% { transform: translateY(-42vh); opacity: 0 } 12% { opacity: 1 } 88% { opacity: 1 } 100% { transform: translateY(42vh); opacity: 0 } }
@keyframes wgc-auth-draw { to { stroke-dashoffset: 0 } }
@keyframes wgc-auth-pop { 0% { transform: scale(.62); opacity: 0 } 55% { transform: scale(1.07); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
@keyframes wgc-auth-shake { 0%, 100% { transform: translateX(0) } 14% { transform: translateX(-7px) } 28% { transform: translateX(6px) } 42% { transform: translateX(-5px) } 56% { transform: translateX(4px) } 70% { transform: translateX(-2px) } 84% { transform: translateX(1px) } }
@keyframes wgc-auth-flicker { 0%, 100% { opacity: 1 } 10% { opacity: .35 } 16% { opacity: 1 } 22% { opacity: .5 } 28% { opacity: 1 } 34% { opacity: .65 } 40% { opacity: 1 } }
@keyframes wgc-auth-grid { 0% { background-position: 0 0 } 100% { background-position: 0 46px } }
@media (prefers-reduced-motion: reduce) {
  .wgc-auth-anim, .wgc-auth-anim * { animation-duration: 1ms !important; animation-iteration-count: 1 !important; }
}
`

interface AuthStatusOverlayProps {
  status: 'success' | 'failure'
  /** Optional server error shown under the headline (failure only). */
  message?: string
  /** How long the overlay stays before onDone fires. Default 2000 ms. */
  durationMs?: number
  onDone: () => void
}

export function AuthStatusOverlay({ status, message, durationMs = 2000, onDone }: AuthStatusOverlayProps) {
  const ok = status === 'success'
  const accent = ok ? '#34d399' : '#f87171'
  const accentSoft = ok ? 'rgba(52,211,153,' : 'rgba(248,113,113,'
  const ringColor = ok ? 'rgba(52,211,153,.55)' : 'rgba(248,113,113,.55)'

  useEffect(() => {
    const timer = window.setTimeout(onDone, durationMs)
    return () => window.clearTimeout(timer)
  }, [durationMs, onDone])

  return (
    <div
      role="status"
      aria-live="polite"
      className="wgc-auth-anim fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
      style={{ animation: 'wgc-auth-overlay ' + durationMs + 'ms ease-in-out forwards' }}
    >
      <style>{KEYFRAMES}</style>

      {/* Dim + blur the page behind the verification. */}
      <div aria-hidden="true" className="absolute inset-0 bg-[#04060c]/85 backdrop-blur-[3px]" />

      {/* Full-page glow wash: a soft green/red light over everything. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 46%, ' + accentSoft + '0.38) 0%, ' + accentSoft + '0.10) 38%, rgba(4,6,12,0) 68%)',
          animation: 'wgc-auth-glow ' + durationMs + 'ms ease-out forwards',
        }}
      />

      {/* Hologram grid + scanline sweep. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(255,255,255,.5) 0px, rgba(255,255,255,.5) 1px, transparent 1px, transparent 3px)',
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 h-40"
        style={{
          background: 'linear-gradient(180deg, ' + accentSoft + '0) 0%, ' + accentSoft + '0.18) 50%, ' + accentSoft + '0) 100%)',
          animation: 'wgc-auth-scan 1.15s ease-in-out infinite',
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-1/2 h-px"
        style={{ background: accent, boxShadow: '0 0 18px ' + accent, opacity: 0.35 }}
      />

      {/* Center verification stage. */}
      <div className="relative flex flex-col items-center px-6 text-center">
        <div className="relative flex h-44 w-44 items-center justify-center">
          {/* Expanding holo rings. */}
          {[0, 0.18, 0.36].map((delay) => (
            <span
              key={delay}
              aria-hidden="true"
              className="absolute inset-0 rounded-full border"
              style={{
                borderColor: ringColor,
                animation: 'wgc-auth-ring 1.5s ease-out ' + delay + 's infinite',
              }}
            />
          ))}
          {/* Rotating dashed + tick ring. */}
          <span
            aria-hidden="true"
            className="absolute inset-1 rounded-full border border-dashed"
            style={{ borderColor: ringColor, animation: 'wgc-auth-spin 6s linear infinite' }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-5 rounded-full border"
            style={{
              borderColor: ok ? 'rgba(52,211,153,.22)' : 'rgba(248,113,113,.22)',
              animation: 'wgc-auth-spin-rev 9s linear infinite',
              borderStyle: 'dotted',
            }}
          />
          {/* Core badge with drawn check / cross. */}
          <span
            className="relative flex h-24 w-24 items-center justify-center rounded-full"
            style={{
              border: '1px solid ' + accent,
              backgroundColor: ok ? 'rgba(6,24,18,.85)' : 'rgba(28,8,10,.85)',
              boxShadow: '0 0 42px ' + accentSoft + '0.55), inset 0 0 24px ' + accentSoft + '0.18)',
              color: accent,
              animation: 'wgc-auth-pop .5s cubic-bezier(.22,1,.36,1) both',
            }}
          >
            {ok ? (
              <svg viewBox="0 0 52 52" className="h-14 w-14" fill="none" aria-hidden="true">
                <path
                  d="M13 27.5 L22 36.5 L40 15.5"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ strokeDasharray: 60, strokeDashoffset: 60, animation: 'wgc-auth-draw .5s .15s ease-out forwards' }}
                />
              </svg>
            ) : (
              <svg viewBox="0 0 52 52" className="h-14 w-14" fill="none" aria-hidden="true">
                <path
                  d="M17 17 L35 35 M35 17 L17 35"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                  style={{ strokeDasharray: 60, strokeDashoffset: 60, animation: 'wgc-auth-draw .42s .1s ease-out forwards' }}
                />
              </svg>
            )}
          </span>
        </div>

        <p
          className="mt-8 text-[11px] font-semibold uppercase tracking-[0.42em]"
          style={{ color: accent, opacity: 0.85 }}
        >
          {ok ? 'Auth handshake complete' : 'Auth handshake rejected'}
        </p>
        <h2
          className="mt-2 text-2xl font-semibold tracking-[0.08em] sm:text-3xl"
          style={{
            color: '#f8fafc',
            textShadow: ok ? '0 0 26px ' + accentSoft + '0.55)' : '0 0 26px ' + accentSoft + '0.5)',
            animation: ok ? 'none' : 'wgc-auth-shake .55s .1s ease-in-out 2, wgc-auth-flicker 1.1s .7s linear 1',
          }}
        >
          {ok ? 'IDENTITY VERIFIED' : 'VERIFICATION FAILED'}
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          {ok ? 'Access granted · opening console…' : message || 'The credentials could not be verified.'}
        </p>
      </div>
    </div>
  )
}
