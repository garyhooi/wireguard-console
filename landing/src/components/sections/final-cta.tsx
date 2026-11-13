import Link from "next/link";
import { ArrowRight, ArrowUpRight, Play } from "@phosphor-icons/react/dist/ssr";
import { siteConfig } from "@/lib/site";

export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-line">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 h-[320px] w-[720px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(45,212,191,0.07),transparent)]"
      />
      <div className="relative mx-auto w-full max-w-[1320px] px-5 py-20 sm:px-8 lg:py-24">
        <div className="grid gap-10 lg:grid-cols-12 lg:items-end">
          <div className="lg:col-span-8">
            <h2 className="max-w-[18ch] text-balance text-3xl font-semibold leading-[1.05] tracking-[-0.035em] text-text sm:text-4xl lg:text-[3.1rem]">
              Run it where your keys live.
            </h2>
            <p className="mt-5 max-w-[52ch] text-[15px] leading-relaxed text-muted">
              Self-host the console, put an exit in the region your team works
              in and keep the admin surface behind a second factor.
            </p>
          </div>
          <div className="flex flex-col gap-3 lg:col-span-4 lg:items-end">
            <Link
              href="/demo"
              className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent px-6 text-sm font-semibold text-[#04100d] transition-colors hover:bg-[#5eead4] active:scale-[0.985] sm:w-auto"
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
            <Link
              href="/#deploy"
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border border-line-strong px-6 text-sm font-medium text-text transition-colors hover:border-muted/50 hover:bg-panel active:scale-[0.985] sm:w-auto"
            >
              Deploy it
            </Link>
            <Link
              href={siteConfig.license}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center justify-center gap-1.5 text-[11px] text-dim transition-colors hover:text-accent lg:justify-end"
            >
              Apache 2.0 license
              <ArrowUpRight size={11} weight="bold" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}