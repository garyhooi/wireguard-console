import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { BrandMark } from "@/components/brand";

export default function NotFound() {
  return (
    <main
      id="main"
      className="flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center"
    >
      <BrandMark size="lg" />
      <p className="mt-8 font-mono text-xs uppercase tracking-[0.2em] text-dim">
        404
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
        This exit does not exist.
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
        The page moved or never existed. The console is still one click away.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-[#04100d] transition-colors hover:bg-[#5eead4]"
      >
        <IconArrowLeft size={16} stroke={1.8} aria-hidden="true" />
        Back to the site
      </Link>
    </main>
  );
}