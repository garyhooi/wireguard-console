import Link from "next/link";
import { ArrowUpRight, Plus } from "@phosphor-icons/react/dist/ssr";
import { faqs } from "@/lib/content";
import { siteConfig } from "@/lib/site";

export function FaqSection() {
  return (
    <section id="faq" className="relative py-20 lg:py-28">
      <div className="mx-auto w-full max-w-[1320px] px-5 sm:px-8">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-4">
            <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-text sm:text-4xl lg:text-[2.85rem] lg:leading-[1.05]">
              Questions, answered.
            </h2>
            <p className="mt-5 max-w-[38ch] text-[15px] leading-relaxed text-muted">
              What runs where, what a node reports and what you need before the
              first install.
            </p>
            <Link
              href={siteConfig.docs}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted transition-colors hover:text-accent"
            >
              Read the full README
              <ArrowUpRight size={13} weight="bold" aria-hidden="true" />
            </Link>
          </div>

          <div className="divide-y divide-line/80 border-y border-line/70 lg:col-span-8">
            {faqs.map((faq) => (
              <details key={faq.q} className="group py-5">
                <summary className="flex items-start justify-between gap-6 text-[14.5px] font-medium leading-relaxed text-text">
                  <span>{faq.q}</span>
                  <Plus
                    size={16}
                    className="faq-plus mt-0.5 shrink-0 text-dim transition-transform group-open:text-accent"
                    aria-hidden="true"
                  />
                </summary>
                <p className="mt-3 max-w-[72ch] text-[13px] leading-relaxed text-muted">
                  {faq.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
