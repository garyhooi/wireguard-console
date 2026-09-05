import { IconBrandGithub } from '@tabler/icons-react'

// Floating link to the public source repo, rendered on every page via the
// root route. Kept subtle so it never fights with page chrome: bordered,
// translucent zinc surface, teal accent on hover/focus.
const GITHUB_URL = 'https://github.com/garyhooi/wireguard-console'

export function GitHubCornerButton() {
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="View source on GitHub"
      aria-label="View source on GitHub"
      className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 backdrop-blur px-3.5 py-2 text-xs text-zinc-400 shadow-lg shadow-black/40 transition-colors hover:text-zinc-100 hover:border-zinc-700 hover:bg-zinc-800/90 active:scale-95"
    >
      <IconBrandGithub size={16} stroke={1.8} aria-hidden="true" />
      <span className="hidden sm:inline">GitHub</span>
    </a>
  )
}
