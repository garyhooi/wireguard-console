import Link from "next/link";
import { IconArrowUpRight, IconBrandGithub } from "@tabler/icons-react";
import { navItems, siteConfig } from "@/lib/site";
import { BrandMark } from "@/components/brand";
import { MobileNav } from "@/components/mobile-nav";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 h-16 border-b border-line/70 bg-ink/80 backdrop-blur-xl">
      <div className="mx-auto flex h-full w-full max-w-[1320px] items-center justify-between gap-6 px-5 sm:px-8">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 rounded-sm"
          aria-label="WireGuard Console home"
        >
          <BrandMark />
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-white sm:text-[15px]">
            WireGuard Console
          </span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-full px-3 py-1.5 text-[13.5px] text-muted transition-colors hover:text-text"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <a
            href={siteConfig.repo}
            target="_blank"
            rel="noreferrer"
            className="hidden h-9 items-center gap-1.5 rounded-full px-3 text-[13.5px] text-muted transition-colors hover:text-text sm:inline-flex"
            aria-label="WireGuard Console on GitHub"
          >
            <IconBrandGithub size={16} stroke={1.8} aria-hidden="true" />
            <span>GitHub</span>
          </a>
          <Link
            href="/demo"
            className="group inline-flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[13.5px] font-semibold text-[#04100d] transition-all hover:bg-teal-300 active:scale-[0.98] max-[359px]:hidden"
          >
            <span className="sm:hidden">Demo</span>
            <span className="hidden sm:inline">Launch demo</span>
            <IconArrowUpRight
              size={15}
              stroke={2}
              aria-hidden="true"
              className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            />
          </Link>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}