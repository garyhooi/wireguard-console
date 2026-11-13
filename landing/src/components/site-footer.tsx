import Link from "next/link";
import { IconBrandGithub } from "@tabler/icons-react";
import { siteConfig } from "@/lib/site";
import { BrandMark } from "@/components/brand";
import { HashLink } from "@/components/hash-link";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Console", href: "/#console" },
      { label: "Topology", href: "/#topology" },
      { label: "Security", href: "/#security" },
      { label: "Interactive demo", href: "/demo" },
    ],
  },
  {
    title: "Deploy",
    links: [
      { label: "Firewall", href: "/#firewall" },
      { label: "Install", href: "/#deploy" },
      { label: "Node setup", href: `${siteConfig.docs}` },
      { label: "Requirements", href: "/#faq" },
      { label: "Upgrade", href: "/#faq" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: siteConfig.repo },
      { label: "Documentation", href: siteConfig.docs },
      { label: "Apache 2.0 license", href: siteConfig.license },
      { label: "Releases", href: `${siteConfig.repo}/releases` },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="relative z-10 border-t border-line bg-ink">
      <div className="mx-auto grid w-full max-w-[1320px] gap-12 px-5 py-14 sm:px-8 lg:grid-cols-[1.35fr_2fr] lg:py-16">
        <div>
          <Link href="/" className="inline-flex items-center gap-2.5" aria-label="WireGuard Console home">
            <BrandMark />
            <span className="text-[15px] font-semibold tracking-tight text-white">
              WireGuard Console
            </span>
          </Link>
          <p className="mt-4 max-w-[34ch] text-sm leading-relaxed text-muted">
            Self-hosted access control for the WireGuard exits you already run.
            One console, every region, no inbound management ports.
          </p>
          <a
            href={siteConfig.repo}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-text"
          >
            <IconBrandGithub size={16} stroke={1.8} aria-hidden="true" />
            garyhooi/wireguard-console
          </a>
        </div>

        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-dim">
                {column.title}
              </p>
              <ul className="mt-4 space-y-3">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <HashLink
                      href={link.href}
                      {...(link.href.startsWith("http")
                        ? { target: "_blank", rel: "noreferrer" }
                        : {})}
                      className="text-sm text-muted transition-colors hover:text-text"
                    >
                      {link.label}
                    </HashLink>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>
      <div className="border-t border-line/70">
        <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-3 px-5 py-6 text-xs text-dim sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>
            Apache 2.0. Built for teams that run their own network.
          </p>
          <p>
            WireGuard is a registered trademark of Jason A. Donenfeld. This
            project is not affiliated with the WireGuard project.
          </p>
        </div>
      </div>
    </footer>
  );
}