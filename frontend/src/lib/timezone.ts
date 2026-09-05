/**
 * Console-wide timezone support.
 *
 * An admin can set a console timezone under Configuration → Timezone. When
 * one is set, every timestamp the SPA renders is converted to that zone
 * (fmtDateTime / fmtDate below) instead of the viewer's browser zone; the
 * hourly traffic chart also buckets samples in that zone server-side.
 *
 * "Unset" is represented by '' and means "follow the viewer's browser" —
 * the legacy behavior, where plain `new Date(iso).toLocaleString()` used the
 * browser's own zone. When we have no configured zone we fall back to that,
 * so nothing changes until an admin explicitly picks a zone.
 *
 * The configured zone is fetched once per page load (in the authenticated
 * layout's beforeLoad) and cached module-wide. Formatting helpers resolve
 * through the module state, so they work whether or not the fetch completed.
 */
import { apiJson } from './api'

interface TimezoneConfig {
  timezone: string
}

let zoneName = ''
let zoneTz: string | undefined = undefined
let zoneLoad: Promise<string> | null = null

/** The currently known configured zone ('' = unset). */
export function getTimezone(): string {
  return zoneName
}

/** True once the configured zone has been fetched this page load. */
export function timezoneLoaded(): boolean {
  return zoneLoad !== null
}

/**
 * Fetch the configured console timezone from the server. Resolves to the
 * IANA name or '' (unset). Called once per page load; safe to call from
 * multiple places (e.g. layout beforeLoad + components) — all share the
 * same in-flight promise and cached value.
 */
export function ensureTimezone(): Promise<string> {
  if (zoneLoad) return zoneLoad
  zoneLoad = apiJson<TimezoneConfig>('/api/config/timezone')
    .then((d) => {
      const v = typeof d?.timezone === 'string' ? d.timezone.trim() : ''
      zoneName = v
      zoneTz = v || undefined
      return v
    })
    .catch(() => {
      // Unset — a failed probe must not break rendering. The console falls
      // back to the viewer's browser zone.
      zoneName = ''
      zoneTz = undefined
      return ''
    })
  return zoneLoad
}

/**
 * Update the module-wide zone cache. Used by the Configuration → Timezone
 * settings after a successful save so every page in the SPA picks up the new
 * zone immediately (no reload needed). Also the test hook.
 */
export function setTimezone(name: string) {
  zoneName = name || ''
  zoneTz = zoneName || undefined
  zoneLoad = Promise.resolve(zoneName)
}

/** Test hook: reset module state (back to browser-zone fallback). */
export function _resetTimezoneForTests() {
  zoneName = ''
  zoneTz = undefined
  zoneLoad = null
}

/** The zone to format with: the configured zone, or undefined → browser. */
function resolveZone(): string | undefined {
  return zoneTz
}

/**
 * Render an ISO timestamp in the configured zone. When no zone is set (or
 * the value is not parseable) it formats with the viewer's browser locale —
 * identical to the legacy `new Date(iso).toLocaleString()` behavior.
 */
export function fmtDateTime(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const z = resolveZone()
  return z
    ? d.toLocaleString(undefined, { timeZone: z, ...opts })
    : d.toLocaleString(undefined, opts)
}

/** Date-only variant of fmtDateTime (never shows a time component). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const z = resolveZone()
  return z ? d.toLocaleDateString(undefined, { timeZone: z }) : d.toLocaleDateString()
}

/**
 * Today's YYYY-MM-DD (optionally shifted by whole days) in the configured
 * console zone — used to pre-fill the report date-range pickers. When no
 * console zone is set it keeps the legacy UTC-based key so existing behavior
 * is unchanged. Formatting via Intl in the zone keeps the date correct even
 * where the zone offset is not a whole hour.
 */
export function dateKey(daysOffset = 0): string {
  const z = resolveZone()
  const now = new Date(Date.now() + daysOffset * 86_400_000)
  if (z) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: z,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now)
    const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? ''
    return `${get('year')}-${get('month')}-${get('day')}`
  }
  return now.toISOString().slice(0, 10)
}
