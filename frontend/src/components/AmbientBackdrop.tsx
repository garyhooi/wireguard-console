// Ambient backdrop for the signed-in console: a live but non-distracting
// layer behind the content column. A drifting grid, two slow glow fields, a
// sweeping hologram band, diagonal light beams and floating data motes —
// all pure CSS transforms/opacity (compositor-only, no JS loop, no canvas).
//
// Contrast: panels/cards stay opaque, so text on them is unaffected. The
// shared page background only receives a low-alpha tint; the animation is
// disabled for prefers-reduced-motion and prefers-contrast: more.

const KEYFRAMES = `
@keyframes wgc-amb-drift-a { 0% { transform: translate3d(-6%, -4%, 0) scale(1) } 50% { transform: translate3d(6%, 6%, 0) scale(1.12) } 100% { transform: translate3d(-6%, -4%, 0) scale(1) } }
@keyframes wgc-amb-drift-b { 0% { transform: translate3d(5%, 4%, 0) scale(1.06) } 50% { transform: translate3d(-6%, -5%, 0) scale(.96) } 100% { transform: translate3d(5%, 4%, 0) scale(1.06) } }
@keyframes wgc-amb-grid { 0% { transform: translate3d(0, 0, 0) } 100% { transform: translate3d(0, 56px, 0) } }
@keyframes wgc-amb-scan { 0% { transform: translate3d(0, -65vh, 0); opacity: 0 } 6% { opacity: 1 } 94% { opacity: 1 } 100% { transform: translate3d(0, 125vh, 0); opacity: 0 } }
@keyframes wgc-amb-beam { 0% { transform: translate3d(-75%, 0, 0) rotate(-16deg); opacity: 0 } 10% { opacity: .9 } 90% { opacity: .9 } 100% { transform: translate3d(75%, 0, 0) rotate(-16deg); opacity: 0 } }
@keyframes wgc-amb-float { 0% { transform: translate3d(0, 0, 0) } 100% { transform: translate3d(14px, -140px, 0) } }
@keyframes wgc-amb-twinkle { 0%, 100% { opacity: .25 } 45% { opacity: .95 } 70% { opacity: .4 } }
@media (prefers-reduced-motion: reduce), (prefers-contrast: more) {
  .wgc-amb-anim, .wgc-amb-anim * { animation: none !important; }
}
`

// Deterministic positions so the composition is stable across renders.
const MOTES: Array<{ left: string; top: string; size: number; dur: number; delay: number }> = [
  { left: '6%', top: '78%', size: 2, dur: 21, delay: 0 },
  { left: '14%', top: '62%', size: 3, dur: 17, delay: 3 },
  { left: '22%', top: '88%', size: 2, dur: 24, delay: 1.5 },
  { left: '31%', top: '70%', size: 2, dur: 19, delay: 5 },
  { left: '40%', top: '92%', size: 3, dur: 16, delay: 2 },
  { left: '48%', top: '58%', size: 2, dur: 23, delay: 6 },
  { left: '57%', top: '84%', size: 2, dur: 18, delay: 1 },
  { left: '66%', top: '66%', size: 3, dur: 20, delay: 4 },
  { left: '74%', top: '90%', size: 2, dur: 22, delay: 2.5 },
  { left: '83%', top: '72%', size: 2, dur: 17, delay: 6.5 },
  { left: '91%', top: '86%', size: 3, dur: 25, delay: 3.5 },
  { left: '96%', top: '64%', size: 2, dur: 19, delay: 7 },
]

export function AmbientBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="wgc-amb-anim pointer-events-none absolute inset-0 select-none overflow-hidden"
    >
      <style>{KEYFRAMES}</style>

      {/* Drifting grid (notable but still faint). */}
      <div
        className="absolute inset-x-0 -top-14 bottom-0 opacity-[0.055]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(148,163,184,.45) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,.45) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          animation: 'wgc-amb-grid 26s linear infinite',
        }}
      />

      {/* Two slow glow fields drifting across the content column. */}
      <div
        className="absolute -right-[12%] -top-[20%] h-[80vmax] w-[80vmax] opacity-[0.16]"
        style={{
          background:
            'radial-gradient(circle, rgba(45,212,191,.34) 0%, rgba(45,212,191,.10) 36%, transparent 68%)',
          animation: 'wgc-amb-drift-a 32s ease-in-out infinite',
        }}
      />
      <div
        className="absolute -left-[18%] bottom-[-26%] h-[72vmax] w-[72vmax] opacity-[0.12]"
        style={{
          background:
            'radial-gradient(circle, rgba(56,189,248,.30) 0%, rgba(56,189,248,.08) 40%, transparent 70%)',
          animation: 'wgc-amb-drift-b 40s ease-in-out infinite',
        }}
      />

      {/* Diagonal light beams crossing the column. */}
      <div
        className="absolute top-[30%] left-[-30%] h-px w-[160%]"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(94,234,212,.22), transparent)',
          animation: 'wgc-amb-beam 17s linear infinite',
        }}
      />
      <div
        className="absolute top-[70%] left-[-30%] h-px w-[160%]"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(125,211,252,.18), transparent)',
          animation: 'wgc-amb-beam 23s linear 7s infinite',
        }}
      />

      {/* Slow hologram scan band. */}
      <div
        className="absolute inset-x-0 h-[30vh] opacity-[0.75]"
        style={{
          background:
            'linear-gradient(180deg, transparent 0%, rgba(45,212,191,.085) 50%, transparent 100%)',
          animation: 'wgc-amb-scan 14s linear infinite',
        }}
      />

      {/* Floating data motes. */}
      {MOTES.map((mote, index) => (
        <span
          key={index}
          className="absolute rounded-full"
          style={{
            left: mote.left,
            top: mote.top,
            width: mote.size,
            height: mote.size,
            backgroundColor: index % 4 === 3 ? 'rgba(125,211,252,.9)' : 'rgba(94,234,212,.9)',
            boxShadow:
              index % 4 === 3
                ? '0 0 12px rgba(56,189,248,.7)'
                : '0 0 12px rgba(45,212,191,.7)',
            animation:
              'wgc-amb-float ' + mote.dur + 's linear ' + mote.delay + 's infinite, ' +
              'wgc-amb-twinkle ' + (4 + (index % 5)) + 's ease-in-out infinite',
          }}
        />
      ))}
    </div>
  )
}
