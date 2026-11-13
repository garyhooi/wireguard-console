import Image from "next/image";
import {
  ChartLineUp,
  DeviceMobile,
  Prohibit,
  Pulse,
  ShieldCheck,
} from "@phosphor-icons/react/dist/ssr";
import dashboardShot from "@/assets/screens/dashboard.png";
import { consoleFeatures } from "@/lib/content";

const icons = {
  devices: DeviceMobile,
  pulse: Pulse,
  shield: ShieldCheck,
  ban: Prohibit,
  chart: ChartLineUp,
} as const;

export function ConsoleShowcase() {
  return (
    <section id="console" className="relative py-20 lg:py-28">
      <div className="mx-auto w-full max-w-[1320px] px-5 sm:px-8">
        <div className="max-w-3xl">
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-text sm:text-4xl lg:text-[2.85rem] lg:leading-[1.05]">
            Everything you issue, watch and revoke.
          </h2>
          <p className="mt-5 max-w-[62ch] text-[15px] leading-relaxed text-muted">
            The admin surface is the product. Peers, users, exits, filtering and
            audit live in one place, with no separate config repo to drift.
          </p>
        </div>

        <div className="mt-12 grid items-start gap-10 lg:grid-cols-12 lg:gap-12">
          <figure className="reveal lg:col-span-7">
            <div className="overflow-hidden rounded-[14px] border border-line bg-panel">
              <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5">
                <span className="truncate font-mono text-[10px] text-dim">
                  console.example.com / dashboard
                </span>
                <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-dim">
                  sample data
                </span>
              </div>
              <Image
                src={dashboardShot}
                alt="WireGuard Console dashboard showing peers, connected devices, users and a recent peer table"
                className="h-auto w-full"
                sizes="(min-width: 1024px) 58vw, 100vw"
                placeholder="empty"
              />
            </div>
            <figcaption className="mt-3 text-[11.5px] leading-relaxed text-dim">
              The dashboard from a live install. Every peer row is a device with
              its own key and tunnel address.
            </figcaption>
          </figure>

          <ul className="lg:col-span-5">
            {consoleFeatures.map((feature) => {
              const Icon = icons[feature.icon];
              return (
                <li
                  key={feature.title}
                  className="group border-b border-line/80 py-5 first:pt-0 last:border-b-0 last:pb-0"
                >
                  <div className="flex items-start gap-3.5">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-line bg-panel text-accent">
                      <Icon size={16} weight="regular" aria-hidden="true" />
                    </span>
                    <div>
                      <h3 className="text-[14.5px] font-medium tracking-[-0.005em] text-text">
                        {feature.title}
                      </h3>
                      <p className="mt-1.5 max-w-[42ch] text-[13px] leading-relaxed text-muted">
                        {feature.body}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
