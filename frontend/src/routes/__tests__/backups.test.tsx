// @vitest-environment jsdom
// The Backups page derives its "Created" column from the backup *filename*.
// Backups are named by the API container's wall clock in UTC, so the label
// must parse that instant and render it in the configured console timezone —
// or, when none is set, the viewer's browser zone (the pre-timezone
// behaviour was to print the UTC components verbatim).
import { describe, expect, it, beforeEach } from 'vitest'
import { _resetTimezoneForTests, setTimezone } from '../../lib/timezone'
import { backupCreatedAt, backupLabel } from '../_authenticated/backups'

// 12:04 UTC on 2026-09-03, encoded in the server-side filename.
const NAME = 'wgconsole_backup_20260903_120405.sql.gz'

function zoneLabel(zone: string | undefined, instant: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, // undefined → the runtime's own zone
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(new Date(instant))
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

describe('backup filename → Created label', () => {
  beforeEach(() => {
    _resetTimezoneForTests()
  })

  it('parses the embedded UTC instant from the filename', () => {
    expect(backupCreatedAt(NAME)).toBe('2026-09-03T12:04:00Z')
    expect(backupCreatedAt('some_random_file.sql.gz')).toBeNull()
    expect(backupCreatedAt('wgconsole_backup_20260903.sql.gz')).toBeNull()
  })

  it('renders in the console timezone once set', () => {
    setTimezone('Asia/Kuala_Lumpur') // UTC+8
    // 12:04 UTC is 20:04 in UTC+8 — must not render the UTC wall clock.
    expect(backupLabel(NAME)).toBe(zoneLabel('Asia/Kuala_Lumpur', '2026-09-03T12:04:00Z'))
    expect(backupLabel(NAME)).not.toContain('12:04')
  })

  it('renders in the viewer browser zone when no console zone is set', () => {
    expect(backupLabel(NAME)).toBe(zoneLabel(undefined, '2026-09-03T12:04:00Z'))
  })

  it('crosses into the next local day for zones east of UTC', () => {
    setTimezone('Pacific/Kiritimati') // UTC+14
    expect(backupLabel('wgconsole_backup_20260903_233000.sql.gz')).toBe('2026-09-04 13:30')
  })

  it('falls back to the raw name when the filename is not a backup', () => {
    expect(backupLabel('custom_export.sql.gz')).toBe('custom_export.sql.gz')
  })
})
