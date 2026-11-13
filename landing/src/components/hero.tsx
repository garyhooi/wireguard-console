import Link from "next/link";
import { ArrowRight, Play, TerminalWindow } from "@phosphor-icons/react/dist/ssr";
import { NetworkStage } from "@/components/topology/network-stage";
import { HashLink } from "@/components/hash-link";

export function Hero() {
  return (
    <section className="relative overflow-hidden pb-12 pt-10 sm:pt-14 lg:pb-16 lg:pt-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-40 -top-56 h-[560px] w-[760px] rounded-full bg-[radial-gradient(closest-side,rgba(45,212,191,0.075),transparent)]"
      />
      <div className="relative mx-auto grid w-full max-w-[1320px] items-center gap-12 px-5 sm:px-8 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-6">
          <p className="hero-rise hero-rise-1 font-mono text-[10.5px] uppercase tracking-[0.2em] text-muted">
            Self-hosted WireGuard access control
          </p>
          <h1 className="hero-rise hero-rise-2 mt-5 text-[clamp(1.8rem,8.7vw,3.2rem)] font-semibold leading-[1.03] tracking-[-0.045em] text-text sm:text-[3.25rem] lg:text-[3.1rem] xl:text-[3.55rem]">
            <span className="block">One console.</span>{" "}
            <span className="block text-accent">Every WireGuard exit.</span>
          </h1>
          <p className="hero-rise hero-rise-3 mt-6 max-w-[42ch] text-[15.5px] leading-relaxed text-muted sm:text-base">
            Issue peers, watch handshakes and manage exits across regions.
            Self-hosted, MFA-gated and reachable without inbound management
            ports.
          </p>
          <div className="hero-rise hero-rise-4 mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/demo"
              className="group inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-[#04100d] transition-all hover:bg-[#5eead4] active:scale-[0.985]"
            >
              <Play size={15} weight="fill" aria-hidden="true" />
              Launch demo
              <ArrowRight
                size={15}
                weight="bold"
                aria-hidden="true"
                className="transition-transform group-hover:translate-x-0.5"
              />
            </Link>
            <HashLink
              href="/#deploy"
              className="inline-flex h-11 items-center gap-2 rounded-full border border-line-strong bg-panel/60 px-5 text-sm font-medium text-text transition-colors hover:border-muted/50 hover:bg-panel active:scale-[0.985]"
            >
              <TerminalWindow size={16} aria-hidden="true" />
              Deploy it
            </HashLink>
          </div>
        </div>

        <div className="hero-rise hero-rise-5 min-w-0 lg:col-span-6">
          <div className="rounded-[16px] border border-line bg-[#080c0d] p-2 shadow-[0_40px_90px_-60px_rgba(0,0,0,0.9)]">
            <div className="flex items-center justify-between gap-4 px-2 pb-2 pt-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-dim">
                  Topology preview
                </span>
                <span className="hidden rounded-full border border-line px-2 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.08em] text-dim sm:inline">
                  mesh
                </span>
              </div>
              <div className="flex items-center gap-3 font-mono text-[9px] text-dim">
                <span>4 exits</span>
                <span className="hidden sm:inline">7 peers</span>
              </div>
            </div>
            <NetworkStage
              mode="hero"
              variant="compact"
              className="h-[378px] rounded-[10px] sm:h-[432px]"
            />
          </div>
          <p className="mt-3 px-1 font-mono text-[10px] leading-relaxed text-dim">
            Illustrative topology. Peer traffic stays on the exit you assign.
          </p>
        </div>
      </div>
    </section>
  );
}