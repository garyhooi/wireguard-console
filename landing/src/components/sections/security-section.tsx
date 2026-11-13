import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "@phosphor-icons/react/dist/ssr";
import mfaShot from "@/assets/screens/mfa-enroll.png";
import { securityPoints } from "@/lib/content";
import { siteConfig } from "@/lib/site";

export function SecuritySection() {
  return (
    <section
      id="security"
      className="relative border-y border-line bg-[#080b0c] py-20 lg:py-28"
    >
      <div className="mx-auto w-full max-w-[1320px] px-5 sm:px-8">
        <div className="max-w-3xl">
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-text sm:text-4xl lg:text-[2.85rem] lg:leading-[1.05]">
            Admin access is not an afterthought.
          </h2>
          <p className="mt-5 max-w-[62ch] text-[15px] leading-relaxed text-muted">
            The console issues the keys, so the console is the thing worth
            protecting. Every session carries a second factor, and every admin
            can enroll before they touch a peer.
          </p>
        </div>

        <div className="mt-12 grid items-start gap-12 lg:grid-cols-12 lg:gap-14">
          <div className="order-2 lg:order-1 lg:col-span-7">
            <ul className="divide-y divide-line/80">
              {securityPoints.map((point) => (
                <li key={point.title} className="py-5 first:pt-0 last:pb-0">
                  <h3 className="text-[14.5px] font-medium text-text">
                    {point.title}
                  </h3>
                  <p className="mt-1.5 max-w-[52ch] text-[13px] leading-relaxed text-muted">
                    {point.body}
                  </p>
                </li>
              ))}
            </ul>
            <Link
              href={`${siteConfig.repo}#mfa--passkeys`}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted transition-colors hover:text-accent"
            >
              Read the MFA and passkey notes
              <ArrowUpRight size={13} weight="bold" aria-hidden="true" />
            </Link>
          </div>

          <figure className="reveal order-1 lg:order-2 lg:col-span-5">
            <div className="overflow-hidden rounded-[14px] border border-line bg-panel">
              <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5">
                <span className="truncate font-mono text-[10px] text-dim">
                  console.example.com / enroll
                </span>
                <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-dim">
                  required
                </span>
              </div>
              <Image
                src={mfaShot}
                alt="MFA enrollment screen with a passkey option and an authenticator app option"
                className="h-auto w-full"
                sizes="(min-width: 1024px) 40vw, 100vw"
              />
            </div>
            <figcaption className="mt-3 text-[11.5px] leading-relaxed text-dim">
              Enrollment happens before the first session. Passkeys and
              authenticator apps can both be enrolled.
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}