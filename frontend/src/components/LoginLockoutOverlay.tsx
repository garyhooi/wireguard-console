import { useEffect, useRef, useState } from 'react'

// Full-page per-IP login lockout: shown after too many wrong passwords. The
// countdown mirrors the server's lockout (retry_after_seconds), so refreshing
// the page resumes the same remaining time instead of resetting it.

const KEYFRAMES = `
@keyframes wgc-lock-fade { 0% { opacity: 0 } 6% { opacity: 1 } 100% { opacity: 1 } }
@keyframes wgc-lock-pulse { 0%, 100% { opacity: .32; transform: scale(1) } 50% { opacity: .72; transform: scale(1.06) } }
@keyframes wgc-lock-ring { 0% { transform: scale(.9); opacity: .65 } 100% { transform: scale(1.45); opacity: 0 } }
@keyframes wgc-lock-tick { 0% { transform: scale(1) } 25% { transform: scale(1.09) } 100% { transform: scale(1) } }
@keyframes wgc-lock-scan { 0% { transform: translateY(-40vh); opacity: 0 } 15% { opacity: 1 } 85% { opacity: 1 } 100% { transform: translateY(40vh); opacity: 0 } }
@media (prefers-reduced-motion: reduce) {
  .wgc-lock-anim, .wgc-lock-anim * { animation: none !important; }
}
`

const RADIUS = 54
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function formatSeconds(total: number): string {
  const safe = Math.max(0, Math.floor(total))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return String(minutes) + ':' + String(seconds).padStart(2, '0')
}

interface LoginLockoutOverlayProps {
  /** Remaining lock seconds reported by the server. */
  seconds: number
  /** Called once when the countdown reaches zero. */
  onUnlock: () => void
}

export function LoginLockoutOverlay({ seconds, onUnlock }: LoginLockoutOverlayProps) {
  const total = Math.max(1, Math.ceil(seconds))
  const [remaining, setRemaining] = useState(Math.max(0, Math.ceil(seconds)))
  const fired = useRef(false)
  const onUnlockRef = useRef(onUnlock)
  onUnlockRef.current = onUnlock

  useEffect(() => {
    if (remaining <= 0) {
      if (!fired.current) {
        fired.current = true
        onUnlockRef.current()
      }
      return
    }
    const timer = window.setTimeout(() => setRemaining((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [remaining])

  const progress = Math.max(0, Math.min(1, remaining / total))
  const accent = '#f87171'
  const accentSoft = 'rgba(239,68,68,'
  const ringColor = 'rgba(248,113,113,.45)'

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label="Login temporarily locked"
      className="wgc-lock-anim fixed inset-0 z-[110] flex items-center justify-center overflow-hidden"
      style={{ animation: 'wgc-lock-fade .25s ease-out both' }}
    >
      <style>{KEYFRAMES}</style>

      <div aria-hidden="true" className="absolute inset-0 bg-[#050a12]/92 backdrop-blur-[3px]" />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 46%, ' + accentSoft + '0.30) 0%, ' + accentSoft + '0.08) 42%, rgba(5,10,18,0) 70%)',
          animation: 'wgc-lock-pulse 3s ease-in-out infinite',
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.12]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(255,255,255,.45) 0px, rgba(255,255,255,.45) 1px, transparent 1px, transparent 3px)',
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 h-40"
        style={{
          background: 'linear-gradient(180deg, ' + accentSoft + '0) 0%, ' + accentSoft + '0.16) 50%, ' + accentSoft + '0) 100%)',
          animation: 'wgc-lock-scan 2.6s ease-in-out infinite',
        }}
      />

      <div className="relative flex flex-col items-center px-6 text-center">
        <div className="relative flex h-52 w-52 items-center justify-center">
          {[0, 0.25, 0.5].map((delay) => (
            <span
              key={delay}
              aria-hidden="true"
              className="absolute inset-0 rounded-full border"
              style={{ borderColor: ringColor, animation: 'wgc-lock-ring 2.4s ease-out ' + delay + 's infinite' }}
            />
          ))}
          {/* Draining countdown ring. */}
          <svg viewBox="0 0 128 128" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
            <circle cx="64" cy="64" r={RADIUS} fill="none" stroke="rgba(248,113,113,.16)" strokeWidth="3" />
            <circle
              cx="64"
              cy="64"
              r={RADIUS}
              fill="none"
              stroke={accent}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
              style={{ transition: 'stroke-dashoffset 1s linear', filter: 'drop-shadow(0 0 8px rgba(239,68,68,.55))' }}
            />
          </svg>
          <div className="relative flex flex-col items-center">
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke={accent} strokeWidth="1.7" aria-hidden="true">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <span
              key={remaining}
              data-testid="lockout-remaining"
              className="mt-1 text-4xl font-semibold tabular-nums tracking-tight text-zinc-50"
              style={{ animation: 'wgc-lock-tick 1s ease-out', textShadow: '0 0 26px ' + accentSoft + '0.45)' }}
            >
              {formatSeconds(remaining)}
            </span>
          </div>
        </div>

        <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.42em]" style={{ color: accent }}>
          Lockout active
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[0.06em] text-zinc-100 sm:text-3xl">
          TOO MANY ATTEMPTS
        </h2>
        <p className="mt-2 text-sm text-zinc-400">Too many failed sign-in attempts.</p>
      </div>
    </div>
  )
}
