"use client";

import Link from "next/link";
import { useEffect, type ComponentProps, type MouseEvent } from "react";

/**
 * Hash links need a same-document fallback. Next's Link updates the URL when
 * the hash changes, but clicking "/#deploy" while already at "#deploy" is a
 * no-op in the browser and does not scroll back to the section. These helpers
 * keep that behaviour deterministic and account for the sticky header.
 */

function scrollToSection(id: string, behavior: ScrollBehavior = "smooth") {
  const target = document.getElementById(id);
  if (!target) return;
  const header = document.querySelector("header");
  const offset = (header?.getBoundingClientRect().height ?? 64) + 20;
  const top = target.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, top), behavior });
}

function decodeHash(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function preferredBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

export function HashLink({
  href,
  onClick,
  ...props
}: ComponentProps<typeof Link>) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || typeof href !== "string") return;

    const hashIndex = href.indexOf("#");
    if (hashIndex < 0) return;

    const targetPath = href.slice(0, hashIndex) || window.location.pathname;
    if (window.location.pathname !== targetPath) return;

    const id = decodeHash(href.slice(hashIndex + 1));
    if (!id || !document.getElementById(id)) return;

    event.preventDefault();
    const hash = `#${id}`;
    if (window.location.hash !== hash) {
      window.history.pushState(null, "", hash);
    }
    scrollToSection(id, preferredBehavior());
  }

  return <Link href={href} onClick={handleClick} {...props} />;
}

/**
 * Handles a deep link that is already present on first load, and browser
 * back/forward between hashes. The browser's native jump can land under the
 * sticky header, so this applies the same offset as HashLink.
 */
export function HashScroll() {
  useEffect(() => {
    const scroll = (behavior: ScrollBehavior) => {
      const id = decodeHash(window.location.hash.slice(1));
      if (id) scrollToSection(id, behavior);
    };

    const onHashChange = () => scroll(preferredBehavior());
    const onPopState = () => scroll(preferredBehavior());

    // Run after hydration/layout so the section has a stable position.
    const frame = window.requestAnimationFrame(() => scroll("auto"));
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  return null;
}