import Link from "next/link";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr";
import { firewallPorts } from "@/lib/content";
import { siteConfig } from "@/lib/site";

type PortRule = {
  port: string;
  direction: string;
  label: string;
  detail: string;
};

function PortList({ rules }: { rules: readonly PortRule[] }) {
  return (
    <ul className="divide-y divide-line/80">
      {rules.map((rule) => {
        const inbound = rule.direction === "IN";
        const internal = rule.direction === "INTERNAL";
        return (
          <li key={rule.port} className="grid grid-cols-[minmax(88px,auto)_1fr] gap-3 px-4 py-3.5">
            <div className="flex flex-col items-start gap-1.5">
              <span
                className={`rounded-md border px-2 py-1 font-mono text-[10.5px] tracking-tight ${
                  internal
                    ? "border-amber/25 bg-amber/5 text-amber"
                    : inbound
                      ? "border-accent/25 bg-accent/5 text-accent"
                      : "border-line-strong bg-panel-2 text-muted"
                }`}
              >
                {rule.port}
              </span>
              <span className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-dim">
                {rule.direction}
              </span>
            </div>
            <div className="min-w-0 pt-0.5">
              <p className="text-[12.5px] font-medium text-text">{rule.label}</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{rule.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PortCard({
  title,
  subtitle,
  count,
  rules,
}: {
  title: string;
  subtitle: string;
  count: string;
  rules: readonly PortRule[];
}) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-panel/55">
      <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3.5">
        <div>
          <h3 className="text-[13.5px] font-medium text-text">{title}</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-dim">{subtitle}</p>
        </div>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-dim">
          {count}
        </span>
      </div>
      <PortList rules={rules} />
    </div>
  );
}

export function FirewallSection() {
  return (
    <section id="firewall" className="relative border-t border-line bg-ink py-20 lg:py-28">
      <div className="mx-auto w-full max-w-[1320px] px-5 sm:px-8">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-14">
          <div className="min-w-0 lg:col-span-4">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-accent">
              Firewall
            </p>
            <h2 className="mt-3 text-balance text-3xl font-semibold tracking-[-0.035em] text-text sm:text-4xl lg:text-[2.85rem] lg:leading-[1.05]">
              Open the tunnel. Close everything else.
            </h2>
            <p className="mt-5 max-w-[48ch] text-[15px] leading-relaxed text-muted">
              The installer configures the host firewall on the console. Cloud
              firewalls are separate, and an exit node needs far less than the
              console host — one inbound WireGuard port, not a management plane.
            </p>

            <ul className="mt-7 space-y-3.5">
              <li className="flex gap-3 text-[12.5px] leading-relaxed text-muted">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                <span>
                  <span className="text-text">3000 stays private.</span> AdGuard&apos;s
                  API is reachable only on Docker bridge networks.
                </span>
              </li>
              <li className="flex gap-3 text-[12.5px] leading-relaxed text-muted">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                <span>
                  <span className="text-text">Nodes dial out.</span> After the one-time
                  SSH install, the agent only needs outbound 443/tcp.
                </span>
              </li>
              <li className="flex gap-3 text-[12.5px] leading-relaxed text-muted">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                <span>
                  <span className="text-text">Mirror the inbound rules.</span> OCI, AWS,
                  GCP and Azure firewalls sit in front of the host firewall; also allow
                  node egress on 443/tcp.
                </span>
              </li>
            </ul>

            <Link
              href={`${siteConfig.repo}#firewall--which-ports-to-open`}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted transition-colors hover:text-accent"
            >
              See the full port matrix
              <ArrowUpRight size={13} weight="bold" aria-hidden="true" />
            </Link>
          </div>

          <div className="min-w-0 lg:col-span-8">
            <div className="grid gap-3 md:grid-cols-2">
              <PortCard
                title="Console host"
                subtitle="Control plane + optional exit"
                count="5 rules"
                rules={firewallPorts.console}
              />
              <PortCard
                title="Exit node"
                subtitle="WireGuard endpoint only"
                count="4 rules"
                rules={firewallPorts.node}
              />
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-dim">
              Console ports are inbound unless marked internal; node 443/tcp and
              53/tcp+udp are outbound. SSH is for installation only — restrict it
              to your admin address and close it when you are done.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
