/**
 * One consistent label for a VPN user across the console.
 *
 * Formats (whitespace-trimmed, missing parts dropped):
 *   "Name <EMAIL> (DEPT)" · "Name <EMAIL>" · "<EMAIL> (DEPT)" ·
 *   "Name (DEPT)" · "—"
 *
 * An absent/blank department keeps the legacy name/email-only rendering, so
 * older backends that don't send departments yet look exactly as before.
 */
export function userLabel(
  name?: string | null,
  email?: string | null,
  department?: string | null,
): string {
  const n = (name ?? '').trim()
  const e = (email ?? '').trim()
  const d = (department ?? '').trim()
  const identity = n && e ? `${n} <${e}>` : n || e
  if (!identity) return '—'
  return d ? `${identity} (${d})` : identity
}
