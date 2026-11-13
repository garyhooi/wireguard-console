"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconFingerprint } from "@tabler/icons-react";
import { BrandMark } from "@/components/brand";
import { GithubCorner } from "@/components/demo/github-corner";
import { HoloPageBackground } from "@/components/demo/holo-page-background";
import {
  GhostButton,
  PrimaryButton,
  inputCls,
  labelCls,
} from "@/components/demo/ui";

export function LoginScreen({ onSignIn }: { onSignIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  function finish(kind: "password" | "passkey") {
    if (busy) return;
    setBusy(kind);
    timer.current = window.setTimeout(() => onSignIn(), 700);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    finish("password");
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-x-hidden bg-[#04060c] px-4 py-8">
      <HoloPageBackground />

      <div className="relative z-10 w-full max-w-md">
        <div className="relative rounded-xl border border-teal-500/25 bg-[#080d16]/80 p-8 shadow-[0_0_60px_-18px_rgba(45,212,191,0.55)] backdrop-blur-md">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-10 -top-px h-px bg-gradient-to-r from-transparent via-teal-300/70 to-transparent"
          />

          <div className="flex flex-col items-center text-center">
            <BrandMark size="lg" className="mb-4" />
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-50 [text-shadow:0_0_24px_rgba(45,212,191,0.28)]">
              WireGuard Console
            </h1>
            <p className="mt-2 text-sm text-zinc-400">Sign in to your account</p>
          </div>

          <form className="mt-8 space-y-5" onSubmit={submit}>
            <div>
              <label htmlFor="email" className={labelCls}>
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="username"
                className={inputCls}
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="password" className={labelCls}>
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className={inputCls}
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            <PrimaryButton
              type="submit"
              disabled={busy !== null}
              className="w-full py-2.5"
            >
              {busy === "password" ? "Signing in…" : "Sign in"}
            </PrimaryButton>
          </form>

          <div className="mt-6">
            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-zinc-800" />
              <span className="text-[11px] uppercase tracking-[0.2em] text-dim">
                or
              </span>
              <span className="h-px flex-1 bg-zinc-800" />
            </div>
            <GhostButton
              type="button"
              onClick={() => finish("passkey")}
              disabled={busy !== null}
              className="mt-4 w-full py-2.5"
            >
              <IconFingerprint size={16} stroke={1.7} aria-hidden="true" />
              {busy === "passkey"
                ? "Waiting for your passkey…"
                : "Sign in with a passkey"}
            </GhostButton>
          </div>
        </div>

        <p className="mt-6 text-center text-xs tracking-wide text-dim">
          Secure remote access to your private mesh.
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-dim">
          <span>Demo access: any email and password works.</span>
          <Link
            href="/"
            className="underline decoration-zinc-700 underline-offset-2 transition-colors hover:text-zinc-300"
          >
            Back to landing
          </Link>
        </div>
      </div>

      <GithubCorner />
    </main>
  );
}