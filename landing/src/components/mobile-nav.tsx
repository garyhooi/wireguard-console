"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { List, X } from "@phosphor-icons/react";
import { navItems, siteConfig } from "@/lib/site";

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? "Close menu" : "Open menu"}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-line text-muted transition-colors hover:text-text"
      >
        {open ? <X size={17} /> : <List size={17} />}
      </button>

      {open && (
        <div
          id="mobile-nav"
          ref={panelRef}
          className="fixed inset-x-0 top-16 z-50 border-b border-line bg-ink px-5 py-5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)]"
        >
          <nav aria-label="Mobile" className="grid gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-3 text-[15px] text-text transition-colors hover:bg-panel"
              >
                {item.label}
              </Link>
            ))}
            <a
              href={siteConfig.repo}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg px-3 py-3 text-[15px] text-muted transition-colors hover:bg-panel hover:text-text"
            >
              GitHub
            </a>
          </nav>
        </div>
      )}
    </div>
  );
}
