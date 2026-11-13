import Link from "next/link";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr";
import { deploySteps } from "@/lib/content";
import { InstallTerminal } from "@/components/install-terminal";
import { siteConfig } from "@/lib/site";

export function DeploySection() {
  return (
    <section id="deploy" className="relative border-y border-line bg-[#080b0c] py-20 lg:py-28">
      <div className="mx-auto w-full max-w-[1320px] px-5 sm:px-8">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-14">
          <div className="min-w-0 lg:col-span-5">
            <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-text sm:text-4xl lg:text-[2.85rem] lg:leading-[1.05]">
              A new node in about two minutes.
            </h2>
            <p className="mt-5 max-w-[50ch] text-[15px] leading-relaxed text-muted">
              Run the installer on Ubuntu 22.04+ or Debian 12+. Add a node
              from the console, paste one join command and give it a subnet
              nobody else uses.
            </p>

            <ol className="mt-9 max-w-[46ch]">
              {deploySteps.map((step, index) => (
                <li
                  key={step.title}
                  className="relative border-l border-line pb-6 pl-6 last:pb-0"
                >
                  <span
                    className="absolute -left-[4px] top-1.5 h-[7px] w-[7px] rounded-full border border-accent/50 bg-ink"
                    aria-hidden="true"
                  />
                  <h3 className="text-[13.5px] font-medium text-text">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
                    {step.body}
                  </p>
                </li>
              ))}
            </ol>

          </div>

          <div className="flex min-w-0 flex-col justify-start lg:col-span-7 lg:pt-10">
            <InstallTerminal />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {[
                ["Host OS", "Ubuntu 22.04+ / Debian 12+"],
                ["Console host", "Docker, Postgres, Caddy, AdGuard"],
                ["Exit host", "Docker, node agent, WireGuard"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-[10px] border border-line bg-panel/50 px-3.5 py-3">
                  <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-dim">
                    {label}
                  </div>
                  <div className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
                    {value}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
              <Link
                href={siteConfig.docs}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted transition-colors hover:text-accent"
              >
                Read the setup guide
                <ArrowUpRight size={13} weight="bold" aria-hidden="true" />
              </Link>
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-dim">
                Ubuntu 22.04+ / Debian 12+ / Docker / domain or public IP
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}