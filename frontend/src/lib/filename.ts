/**
 * Build a filesystem-safe filename for a downloaded WireGuard config.
 *
 * Peer names are free-form admin input ("AI Agent", "John's Device", …). Using
 * the raw name for the download's `a.download` produces filenames with spaces,
 * quotes, slashes or non-ASCII characters, which WireGuard clients — Windows in
 * particular — refuse to import. Slugs keep the download importable while the
 * UI continues to display the original, human-friendly peer name.
 *
 * Rules: trim, lowercase ASCII letters, keep ASCII a-z/0-9, collapse every run
 * of other characters to a single '-', trim leading/trailing '-', cap the base
 * at 64 chars (trimming a trailing '-' exposed by the cap), fall back to
 * "wireguard" when nothing usable remains, and append ".conf".
 *
 * NOTE: must stay in exact lock-step with the backend's equivalent slug helper
 * (backend/internal/api/filename.go). Lowercasing is deliberately ASCII-only:
 * String#toLowerCase uses Unicode full case mapping, which rounds differently
 * from Go's simple mapping (Go "İx" -> "ix.conf" vs JS "i-x.conf"), so both
 * sides fold just A-Z and treat everything else as a separator.
 */
const MAX_BASE_LENGTH = 64
const FALLBACK_BASE = 'wireguard'

export function configFileName(name?: string | null): string {
  const base = (name ?? '')
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase()) // ASCII-only fold — see NOTE
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/-+$/, '')

  return `${base || FALLBACK_BASE}.conf`
}
