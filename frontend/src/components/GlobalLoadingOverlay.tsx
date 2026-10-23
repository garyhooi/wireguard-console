import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getLoadingCount, subscribeLoading } from '../lib/loading'

// Global full-screen "operation in progress" hologram. The root route mounts
// it once; apiFetch feeds the busy counter for state-changing requests only
// (POST/PUT/PATCH/DELETE). Fast calls never flash it: the overlay waits 150 ms
// of continuous work before appearing, then drives a fake asymptotic progress
// bar to 90%. When the last request settles it snaps to 100%, stays long
// enough to be read (~500 ms minimum visible) and fades out. New work during
// that completion window cancels the hide and resumes.
//
// Same design language as AuthStatusOverlay / SignOutOverlay / ConfigClaim:
// CSS keyframes inlined with the component (no external stylesheet), fixed
// full-screen layer, teal hologram layers, aria-hidden decorative layers, and
// a reduced-motion block that kills decorative animation (the progress bar
// itself keeps working).

const KEYFRAMES = `
@keyframes wgc-global-in { 0% { opacity: 0 } 100% { opacity: 1 } }
@keyframes wgc-global-grid { 0% { background-position: 0 0, 0 0 } 100% { background-position: 0 44px, 44px 0 } }
@keyframes wgc-global-glow { 0%, 100% { opacity: .32; transform: scale(1) } 50% { opacity: .66; transform: scale(1.06) } }
@keyframes wgc-global-ring { 0% { transform: scale(.66); opacity: .8 } 80% { opacity: .16 } 100% { transform: scale(1.62); opacity: 0 } }
@keyframes wgc-global-spin { to { transform: rotate(360deg) } }
@keyframes wgc-global-spin-rev { to { transform: rotate(-360deg) } }
@keyframes wgc-global-scan { 0% { transform: translateY(-46vh); opacity: 0 } 12% { opacity: 1 } 88% { opacity: 1 } 100% { transform: translateY(46vh); opacity: 0 } }
@keyframes wgc-global-label { 0%, 100% { opacity: .55 } 50% { opacity: 1 } }
@keyframes wgc-global-sheen { 0% { transform: translateX(-140%) } 100% { transform: translateX(420%) } }
@media (prefers-reduced-motion: reduce) {
  .wgc-global-anim, .wgc-global-anim * { animation: none !important; }
}
`

// --- timing ---------------------------------------------------------------
/** Wait this long before showing anything: fast calls never flash the UI. */
const SHOW_DELAY_MS = 150
/** Progress tick. */
const TICK_MS = 40
/** Fake progress never passes this while work is still running. */
const MAX_PCT = 90
/** Starting value when the overlay appears / a new burst begins. */
const START_PCT = 8
/** The overlay is guaranteed to stay visible at least this long. */
const MIN_VISIBLE_MS = 500
/** Minimum pause at 100% before the fade starts. */
const MIN_FINISH_MS = 350
/** Fade-out duration; the overlay unmounts after it. */
const FADE_MS = 250

type Phase = 'idle' | 'waiting' | 'active' | 'finishing' | 'fading'

interface TimerIds {
  show: number | null
  tick: number | null
  hide: number | null
  unmount: number | null
}

export function GlobalLoadingOverlay() {
  const count = useSyncExternalStore(subscribeLoading, getLoadingCount, () => 0)
  const busy = count > 0

  const [phase, setPhase] = useState<Phase>('idle')
  const [pct, setPct] = useState(START_PCT)

  // Authoritative copies for timer callbacks (React state is async).
  const phaseRef = useRef<Phase>('idle')
  const pctRef = useRef(START_PCT)
  const timersRef = useRef<TimerIds>({ show: null, tick: null, hide: null, unmount: null })
  // Approximate time the overlay has been visible, advanced by the ticker so
  // the minimum-visible guarantee does not depend on wall-clock Date mocking.
  const visibleElapsedRef = useRef(0)

  useEffect(() => {
    const timers = timersRef.current

    const stopTicker = () => {
      if (timers.tick !== null) {
        window.clearInterval(timers.tick)
        timers.tick = null
      }
    }
    const cancelTimeout = (key: 'show' | 'hide' | 'unmount') => {
      const id = timers[key]
      if (id !== null) {
        window.clearTimeout(id)
        timers[key] = null
      }
    }
    const startTicker = () => {
      stopTicker()
      timers.tick = window.setInterval(() => {
        visibleElapsedRef.current += TICK_MS
        // Asymptotic ease toward 90%: fast at first, always creeping forward
        // (~70% after 1 s, ~85% after 2 s, capped at 90% for long operations).
        const next = Math.min(MAX_PCT, pctRef.current + Math.max(0.3, (MAX_PCT - pctRef.current) * 0.06))
        pctRef.current = next
        setPct(next)
      }, TICK_MS)
    }

    if (busy) {
      if (phaseRef.current === 'idle') {
        // Start the no-flash delay.
        phaseRef.current = 'waiting'
        setPhase('waiting')
        timers.show = window.setTimeout(() => {
          timers.show = null
          // Safety: work may have drained just before this fired.
          if (getLoadingCount() === 0) {
            phaseRef.current = 'idle'
            setPhase('idle')
            return
          }
          visibleElapsedRef.current = 0
          pctRef.current = START_PCT
          setPct(START_PCT)
          phaseRef.current = 'active'
          setPhase('active')
          startTicker()
        }, SHOW_DELAY_MS)
      } else if (phaseRef.current === 'finishing' || phaseRef.current === 'fading') {
        // New work arrived during the completion window: cancel the hide and
        // resume climbing from the start of the bar.
        cancelTimeout('hide')
        cancelTimeout('unmount')
        visibleElapsedRef.current = 0
        pctRef.current = START_PCT
        setPct(START_PCT)
        phaseRef.current = 'active'
        setPhase('active')
        startTicker()
      }
    } else if (phaseRef.current === 'waiting') {
      // Finished inside the 150 ms delay — never show anything.
      cancelTimeout('show')
      phaseRef.current = 'idle'
      setPhase('idle')
    } else if (phaseRef.current === 'active') {
      // Last request settled: snap to 100% and schedule the fade-out.
      stopTicker()
      pctRef.current = 100
      setPct(100)
      const wait = Math.max(MIN_FINISH_MS, MIN_VISIBLE_MS - visibleElapsedRef.current)
      phaseRef.current = 'finishing'
      setPhase('finishing')
      timers.hide = window.setTimeout(() => {
        timers.hide = null
        if (getLoadingCount() > 0) return
        phaseRef.current = 'fading'
        setPhase('fading')
        timers.unmount = window.setTimeout(() => {
          timers.unmount = null
          phaseRef.current = 'idle'
          setPhase('idle')
          pctRef.current = START_PCT
          setPct(START_PCT)
        }, FADE_MS)
      }, wait)
    }
  }, [busy])

  // Unmount-only cleanup. (Deliberately not tied to [busy]: a busy flip must
  // not cancel the pending hide/unmount timers.)
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      if (timers.show !== null) window.clearTimeout(timers.show)
      if (timers.hide !== null) window.clearTimeout(timers.hide)
      if (timers.unmount !== null) window.clearTimeout(timers.unmount)
      if (timers.tick !== null) window.clearInterval(timers.tick)
      timers.show = null
      timers.hide = null
      timers.unmount = null
      timers.tick = null
      phaseRef.current = 'idle'
    }
  }, [])

  if (phase === 'idle' || phase === 'waiting') return null

  const accent = '#2dd4bf'
  const accentSoft = 'rgba(45,212,191,'
  const shown = Math.round(pct)
  const barWidth = Math.round(pct * 10) / 10

  return (
    <div
      data-testid="global-loading-overlay"
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="wgc-global-anim fixed inset-0 z-[200] flex items-center justify-center overflow-hidden"
      style={{
        opacity: phase === 'fading' ? 0 : 1,
        transition: 'opacity ' + FADE_MS + 'ms ease',
        // Fade in on appear. No fill-mode: the inline opacity above must stay
        // authoritative once the animation has finished (fade-out).
        animation: 'wgc-global-in 300ms ease-out',
        cursor: 'progress',
        // Blocks every click while work is in flight (no double-submits).
        pointerEvents: 'auto',
      }}
    >
      <style>{KEYFRAMES}</style>

      {/* Announced once; the live percentage below is aria-hidden so screen
          readers are not spammed 25 times a second. */}
      <span className="sr-only">Operation in progress</span>

      {/* Dim + blur the console behind the operation. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[#04060c]/85 backdrop-blur-[3px]" />

      {/* Drifting teal holo-grid. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(45,212,191,.4) 1px, transparent 1px), linear-gradient(90deg, rgba(45,212,191,.4) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          animation: 'wgc-global-grid 8s linear infinite',
        }}
      />

      {/* Central radial glow behind the HUD. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[46rem] w-[46rem] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[120px]"
        style={{
          background:
            'radial-gradient(circle, ' + accentSoft + '0.28) 0%, ' + accentSoft + '0.09) 44%, rgba(4,6,12,0) 72%)',
          animation: 'wgc-global-glow 4.5s ease-in-out infinite',
        }}
      />

      {/* Scanning band sweeping down the viewport. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-40"
        style={{
          background:
            'linear-gradient(180deg, ' + accentSoft + '0) 0%, ' + accentSoft + '0.16) 50%, ' + accentSoft + '0) 100%)',
          animation: 'wgc-global-scan 2.6s ease-in-out infinite',
        }}
      />

      {/* Corner brackets: HUD framing. */}
      {[
        'left-5 top-5 border-l border-t',
        'right-5 top-5 border-r border-t',
        'left-5 bottom-5 border-l border-b',
        'right-5 bottom-5 border-r border-b',
      ].map((pos) => (
        <span
          key={pos}
          aria-hidden="true"
          className={'pointer-events-none absolute h-8 w-8 opacity-40 ' + pos}
          style={{ borderColor: 'rgba(45,212,191,.55)' }}
        />
      ))}

      {/* Center stage: rotating HUD rings + big mono percentage. */}
      <div className="relative z-10 flex flex-col items-center px-6 text-center">
        <div className="relative flex h-44 w-44 items-center justify-center">
          {/* Expanding rings. */}
          {[0, 0.55, 1.1].map((delay) => (
            <span
              key={delay}
              aria-hidden="true"
              className="absolute inset-0 rounded-full border"
              style={{
                borderColor: 'rgba(45,212,191,.45)',
                animation: 'wgc-global-ring 2.2s ease-out ' + delay + 's infinite',
              }}
            />
          ))}
          {/* Rotating dashed + counter-rotating dotted HUD rings. */}
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full border border-dashed"
            style={{ borderColor: 'rgba(45,212,191,.42)', animation: 'wgc-global-spin 6s linear infinite' }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-4 rounded-full border"
            style={{
              borderColor: 'rgba(45,212,191,.22)',
              borderStyle: 'dotted',
              animation: 'wgc-global-spin-rev 9s linear infinite',
            }}
          />

          {/* Big mono percentage, centered in the HUD. */}
          <span
            data-testid="global-loading-percent"
            aria-hidden="true"
            className="relative font-mono text-[46px] font-semibold leading-none tracking-tight text-zinc-100"
            style={{ textShadow: '0 0 30px ' + accentSoft + '0.55)' }}
          >
            {shown}
            <span className="ml-0.5 align-top text-lg" style={{ color: accent }}>
              %
            </span>
          </span>
        </div>

        {/* 260px progress bar. Width is driven by pct. */}
        <div aria-hidden="true" className="mt-7 w-[260px]">
          <div
            className="relative h-[4px] w-full overflow-hidden rounded-full"
            style={{ backgroundColor: 'rgba(45,212,191,.14)', boxShadow: 'inset 0 0 10px rgba(45,212,191,.12)' }}
          >
            <div
              data-testid="global-loading-bar"
              className="relative h-full rounded-full"
              style={{
                width: barWidth + '%',
                background: 'linear-gradient(90deg, rgba(45,212,191,.35) 0%, #2dd4bf 55%, #a7f3d0 100%)',
                boxShadow: '0 0 16px rgba(45,212,191,.7)',
                transition: 'width 120ms linear',
              }}
            >
              {/* Light sweep across the filled part. */}
              <span
                aria-hidden="true"
                className="absolute inset-y-0 w-8"
                style={{
                  background: 'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.55) 50%, rgba(255,255,255,0) 100%)',
                  animation: 'wgc-global-sheen 1.5s ease-in-out infinite',
                }}
              />
            </div>
          </div>
        </div>

        <p
          className="mt-4 font-mono text-[10px] font-semibold uppercase tracking-[0.42em]"
          style={{ color: accent, animation: 'wgc-global-label 1.8s ease-in-out infinite' }}
        >
          WORKING
        </p>
      </div>
    </div>
  )
}
