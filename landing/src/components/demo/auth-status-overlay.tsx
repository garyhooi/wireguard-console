"use client";

import { useEffect } from "react";

const KEYFRAMES = `
@keyframes demo-auth-overlay { 0% { opacity: 0 } 7% { opacity: 1 } 84% { opacity: 1 } 100% { opacity: 0 } }
@keyframes demo-auth-glow { 0% { opacity: 0; transform: scale(.9) } 14% { opacity: 1 } 30% { opacity: .62 } 44% { opacity: 1 } 100% { opacity: 0; transform: scale(1.04) } }
@keyframes demo-auth-ring { 0% { transform: scale(.55); opacity: .9 } 76% { opacity: .16 } 100% { transform: scale(1.6); opacity: 0 } }
@keyframes demo-auth-spin { to { transform: rotate(360deg) } }
@keyframes demo-auth-spin-rev { to { transform: rotate(-360deg) } }
@keyframes demo-auth-scan { 0% { transform: translateY(-44vh); opacity: 0 } 12% { opacity: 1 } 88% { opacity: 1 } 100% { transform: translateY(44vh); opacity: 0 } }
@keyframes demo-auth-draw { to { stroke-dashoffset: 0 } }
@keyframes demo-auth-pop { 0% { transform: scale(.62); opacity: 0 } 55% { transform: scale(1.06); opacity: 1 } 100% { transform: scale(1); opacity: 1 } }
@keyframes demo-auth-grid { 0% { background-position: 0 0 } 100% { background-position: 0 46px } }
@media (prefers-reduced-motion: reduce) {
  .demo-auth-anim, .demo-auth-anim * { animation-duration: 1ms !important; animation-iteration-count: 1 !important; }
}
`;

export function AuthStatusOverlay({
  onDone,
  durationMs = 1400,
}: {
  onDone: () => void;
  durationMs?: number;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, onDone]);

  const accent = "#34d399";
  const accentSoft = "rgba(52,211,153,";

  return (
    <div
      role="status"
      aria-live="polite"
      className="demo-auth-anim fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
      style={{ animation: "demo-auth-overlay " + durationMs + "ms ease-in-out forwards" }}
    >
      <style>{KEYFRAMES}</style>

      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[#04060c]/88 backdrop-blur-[3px]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 46%, " +
            accentSoft +
            "0.38) 0%, " +
            accentSoft +
            "0.10) 38%, rgba(4,6,12,0) 68%)",
          animation: "demo-auth-glow " + durationMs + "ms ease-out forwards",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(52,211,153,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(52,211,153,.35) 1px, transparent 1px)",
          backgroundSize: "46px 46px",
          animation: "demo-auth-grid 8s linear infinite",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 h-40"
        style={{
          background:
            "linear-gradient(180deg, " +
            accentSoft +
            "0) 0%, " +
            accentSoft +
            "0.18) 50%, " +
            accentSoft +
            "0) 100%)",
          animation: "demo-auth-scan 1.15s ease-in-out infinite",
        }}
      />

      <div className="relative flex flex-col items-center px-6 text-center">
        <div className="relative flex h-44 w-44 items-center justify-center">
          {[0, 0.18, 0.36].map((delay) => (
            <span
              key={delay}
              aria-hidden="true"
              className="absolute inset-0 rounded-full border border-emerald-400/55"
              style={{
                animation: "demo-auth-ring 1.5s ease-out " + delay + "s infinite",
              }}
            />
          ))}
          <span
            aria-hidden="true"
            className="absolute inset-1 rounded-full border border-dashed border-emerald-400/55"
            style={{ animation: "demo-auth-spin 6s linear infinite" }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-5 rounded-full border border-dotted border-emerald-400/25"
            style={{ animation: "demo-auth-spin-rev 9s linear infinite" }}
          />
          <span
            className="relative flex h-24 w-24 items-center justify-center rounded-full border border-emerald-300"
            style={{
              backgroundColor: "rgba(6,24,18,.85)",
              boxShadow:
                "0 0 42px " + accentSoft + "0.55), inset 0 0 24px " + accentSoft + "0.18)",
              color: accent,
              animation: "demo-auth-pop .5s cubic-bezier(.22,1,.36,1) both",
            }}
          >
            <svg viewBox="0 0 52 52" className="h-14 w-14" fill="none" aria-hidden="true">
              <path
                d="M13 27.5 L22 36.5 L40 15.5"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  strokeDasharray: 60,
                  strokeDashoffset: 60,
                  animation: "demo-auth-draw .5s .15s ease-out forwards",
                }}
              />
            </svg>
          </span>
        </div>

        <p
          className="mt-8 text-[11px] font-semibold uppercase tracking-[0.42em] text-emerald-300/85"
        >
          Auth handshake complete
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[0.08em] text-zinc-50 [text-shadow:0_0_26px_rgba(52,211,153,0.55)] sm:text-3xl">
          IDENTITY VERIFIED
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          Access granted · opening console…
        </p>
      </div>
    </div>
  );
}
