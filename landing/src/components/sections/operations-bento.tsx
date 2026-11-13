import Link from "next/link";
import { ArrowRight, ArrowUpRight, Certificate } from "@phosphor-icons/react/dist/ssr";
import { siteConfig } from "@/lib/site";

const ruleGroups = ["ads-and-trackers", "social", "streaming", "malware"];

export function OperationsBento() {
  return (
    <section aria-labelledby="operations-title" className="relative py-20 lg:py-28">
      <div className="mx-auto w-full max-w-[1320px] px-5 sm:px-8">
        <div className="max-w-3xl">
          <h2
            id="operations-title"
            className="text-balance text-3xl font-semibold tracking-[-0.035em] text-text sm:text-4xl lg:text-[2.85rem] lg:leading-[1.05]"
          >
            Built for the boring parts.
          </h2>
          <p className="mt-5 max-w-[62ch] text-[15px] leading-relaxed text-muted">
            Filtering, blocking, reconnects and backups. The work between a
            handshake and a clean audit trail.
          </p>
        </div>

        <div className="mt-12 grid gap-4 md:grid-cols-6">
          <article className="relative overflow-hidden rounded-[14px] border border-line bg-panel p-6 md:col-span-3 lg:p-7">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-24 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(closest-side,rgba(45,212,191,0.1),transparent)]"
            />
            <h3 className="text-lg font-medium tracking-[-0.02em] text-text">
              Filter where the tunnel ends
            </h3>
            <p className="mt-2 max-w-[46ch] text-[13.5px] leading-relaxed text-muted">
              AdGuard rules run on the console exit. Reusable domain groups,
              department scope and a branded block page for denied requests.
            </p>
            <div className="mt-7 space-y-0 border-t border-line/80">
              {ruleGroups.map((group) => (
                <div
                  key={group}
                  className="flex items-center justify-between border-b border-line/60 py-2 font-mono text-[10.5px] text-dim last:border-b-0"
                >
                  <span>domain-group / {group}</span>
                  <span className="text-accent/80">block</span>
                </div>
              ))}
            </div>
          </article>

          <article className="relative overflow-hidden rounded-[14px] border border-line bg-[#060a0a] p-6 md:col-span-3 lg:p-7">
            <h3 className="text-lg font-medium tracking-[-0.02em] text-text">
              Drop ranges before NAT
            </h3>
            <p className="mt-2 max-w-[46ch] text-[13.5px] leading-relaxed text-muted">
              IPv4 and IPv6 rules are enforced server-side before forwarding.
              Block an address for everyone or for one peer.
            </p>
            <div className="mt-7 rounded-[8px] border border-line bg-black/20 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-[#b8c8c3]">
              <div className="flex justify-between gap-4">
                <span>198.51.100.0/24</span>
                <span className="text-rose/80">drop</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>203.0.113.42</span>
                <span className="text-rose/80">drop</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>2001:db8::/32</span>
                <span className="text-rose/80">drop</span>
              </div>
            </div>
            <p className="mt-4 font-mono text-[9.5px] uppercase tracking-[0.12em] text-dim">
              Documentation ranges shown
            </p>
          </article>

          <article className="dot-field relative overflow-hidden rounded-[14px] border border-line bg-panel p-6 md:col-span-2">
            <h3 className="text-[15px] font-medium text-text">Agents that reapply</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              After a reboot, the node agent reapplies its interfaces on the
              next poll.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-2 font-mono text-[10px] text-dim">
              <span className="rounded-[6px] border border-line bg-ink px-2 py-1">reboot</span>
              <ArrowRight size={11} aria-hidden="true" />
              <span className="rounded-[6px] border border-line bg-ink px-2 py-1">poll 15s</span>
              <ArrowRight size={11} aria-hidden="true" />
              <span className="rounded-[6px] border border-accent/30 bg-accent/5 px-2 py-1 text-accent">wg apply</span>
            </div>
          </article>

          <article className="relative overflow-hidden rounded-[14px] border border-line bg-panel p-6 md:col-span-2">
            <h3 className="text-[15px] font-medium text-text">Backups gated by MFA</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Create, download and restore from the console. Destructive
              restores ask for a fresh factor.
            </p>
            <div className="mt-6 space-y-1.5 font-mono text-[10px] text-dim">
              <div>backup.tar.zst</div>
              <div className="text-muted">restore: mfa_required</div>
            </div>
          </article>

          <article className="relative overflow-hidden rounded-[14px] border border-accent/20 bg-[#081110] p-6 md:col-span-2">
            <Certificate size={22} className="text-accent" weight="regular" aria-hidden="true" />
            <h3 className="mt-4 text-[15px] font-medium text-text">Apache 2.0, no seats</h3>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Self-host the whole stack. No hosted control plane and no
              per-admin licence.
            </p>
            <Link
              href={siteConfig.license}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-accent/90 transition-colors hover:text-accent"
            >
              Read the license
              <ArrowUpRight size={12} weight="bold" aria-hidden="true" />
            </Link>
          </article>
        </div>
      </div>
    </section>
  );
}