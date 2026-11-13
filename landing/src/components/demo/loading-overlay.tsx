"use client";

const KEYFRAMES = `
@keyframes demo-load-in { 0% { opacity: 0 } 100% { opacity: 1 } }
@keyframes demo-load-grid { 0% { background-position: 0 0, 0 0 } 100% { background-position: 0 44px, 44px 0 } }
@keyframes demo-load-glow { 0%, 100% { opacity: .32; transform: scale(1) } 50% { opacity: .66; transform: scale(1.06) } }
@keyframes demo-load-ring { 0% { transform: scale(.66); opacity: .8 } 80% { opacity: .16 } 100% { transform: scale(1.62); opacity: 0 } }
@keyframes demo-load-spin { to { transform: rotate(360deg) } }
@keyframes demo-load-spin-rev { to { transform: rotate(-360deg) } }
@keyframes demo-load-scan { 0% { transform: translateY(-46vh); opacity: 0 } 12% { opacity: 1 } 88% { opacity: 1 } 100% { transform: translateY(46vh); opacity: 0 } }
@keyframes demo-load-label { 0%, 100% { opacity: .55 } 50% { opacity: 1 } }
@keyframes demo-load-bar { 0% { width: 4% } 35% { width: 52% } 70% { width: 78% } 100% { width: 90% } }
@keyframes demo-load-sheen { 0% { transform: translateX(-140%) } 100% { transform: translateX(420%) } }
@media (prefers-reduced-motion: reduce) {
  .demo-load-anim, .demo-load-anim * { animation: none !important; }
}
`;

export function DemoLoadingOverlay({ label = "Working…" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="demo-load-anim fixed inset-0 z-[90] flex cursor-progress items-center justify-center overflow-hidden"
      style={{ animation: "demo-load-in 300ms ease-out" }}
    >
      <style>{KEYFRAMES}</style>
      <span className="sr-only">Operation in progress</span>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[#04060c]/85 backdrop-blur-[3px]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(45,212,191,.4) 1px, transparent 1px), linear-gradient(90deg, rgba(45,212,191,.4) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          animation: "demo-load-grid 8s linear infinite",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[42rem] w-[42rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-teal-400/10 blur-[110px]"
        style={{ animation: "demo-load-glow 2.8s ease-in-out infinite" }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 h-44"
        style={{
          background:
            "linear-gradient(180deg, rgba(45,212,191,0) 0%, rgba(45,212,191,.16) 50%, rgba(45,212,191,0) 100%)",
          animation: "demo-load-scan 3.2s ease-in-out infinite",
        }}
      />

      <div className="relative w-full max-w-sm px-6 text-center">
        <div className="relative mx-auto flex h-36 w-36 items-center justify-center">
          {[0, 0.2, 0.4].map((delay) => (
            <span
              key={delay}
              aria-hidden="true"
              className="absolute inset-0 rounded-full border border-teal-400/45"
              style={{
                animation: "demo-load-ring 1.6s ease-out " + delay + "s infinite",
              }}
            />
          ))}
          <span
            aria-hidden="true"
            className="absolute inset-2 rounded-full border border-dashed border-teal-400/30"
            style={{ animation: "demo-load-spin 6s linear infinite" }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-7 rounded-full border border-dotted border-teal-400/20"
            style={{ animation: "demo-load-spin-rev 8s linear infinite" }}
          />
          <span className="relative flex h-16 w-16 items-center justify-center rounded-full border border-teal-300/70 bg-teal-950/70 shadow-[0_0_36px_rgba(45,212,191,.4)]">
            <span className="h-2 w-2 rounded-full bg-teal-300 shadow-[0_0_16px_rgba(45,212,191,.9)]" />
          </span>
        </div>

        <p
          className="mt-1 text-[11px] font-semibold uppercase tracking-[0.38em] text-teal-300/85"
          style={{ animation: "demo-load-label 1.4s ease-in-out infinite" }}
        >
          {label}
        </p>
        <div className="mx-auto mt-5 h-1 overflow-hidden rounded-full bg-teal-950/90 ring-1 ring-inset ring-teal-400/15">
          <div
            className="h-full rounded-full bg-gradient-to-r from-teal-500 via-teal-300 to-emerald-300"
            style={{
              width: "90%",
              animation: "demo-load-bar 1.4s cubic-bezier(.16,1,.3,1) both",
            }}
          />
        </div>
        <p className="mt-3 text-xs text-zinc-400">Demo operation in progress…</p>
      </div>
    </div>
  );
}
