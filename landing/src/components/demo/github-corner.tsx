import { IconBrandGithub } from "@tabler/icons-react";
import { siteConfig } from "@/lib/site";

export function GithubCorner() {
  return (
    <a
      href={siteConfig.repo}
      target="_blank"
      rel="noopener noreferrer"
      title="View source on GitHub"
      aria-label="View source on GitHub"
      className="fixed bottom-5 right-5 z-40 hidden items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-3.5 py-2 text-xs text-zinc-400 shadow-lg shadow-black/40 backdrop-blur transition-colors hover:border-zinc-700 hover:bg-zinc-800/90 hover:text-zinc-100 active:scale-95 sm:inline-flex"
    >
      <IconBrandGithub size={16} stroke={1.8} aria-hidden="true" />
      <span className="hidden sm:inline">GitHub</span>
    </a>
  );
}