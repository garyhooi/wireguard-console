// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  _resetTimezoneForTests,
  dateKey,
  ensureTimezone,
  fmtDate,
  fmtDateTime,
  getTimezone,
  setTimezone,
  timezoneLoaded,
} from '../timezone'

const ISO = '2026-01-15T12:00:00Z' // 12:00 UTC

describe('timezone helpers', () => {
  beforeEach(() => {
    _resetTimezoneForTests()
  })

  it('defaults to unset (browser timezone)', () => {
    expect(getTimezone()).toBe('')
    expect(timezoneLoaded()).toBe(false)
    // Unset renders like the legacy toLocaleString (browser zone).
    const expected = new Date(ISO).toLocaleString()
    expect(fmtDateTime(ISO)).toBe(expected)
    expect(fmtDate(ISO)).toBe(new Date(ISO).toLocaleDateString())
  })

  it('renders in the configured zone once set', () => {
    setTimezone('Asia/Kuala_Lumpur') // UTC+8, no DST
    const expected = new Date(ISO).toLocaleString(undefined, { timeZone: 'Asia/Kuala_Lumpur' })
    expect(fmtDateTime(ISO)).toBe(expected)
    // 12:00 UTC → 20:00 in UTC+8 — the rendered string must not be the UTC one.
    expect(fmtDateTime(ISO)).not.toBe(new Date(ISO).toLocaleString(undefined, { timeZone: 'UTC' }))
  })

  it('clearing the zone returns to browser rendering', () => {
    setTimezone('Asia/Tokyo')
    setTimezone('')
    expect(getTimezone()).toBe('')
    expect(fmtDateTime(ISO)).toBe(new Date(ISO).toLocaleString())
  })

  it('fmtDate renders the date in the configured zone', () => {
    setTimezone('America/New_York') // UTC-5 in January
    // 2026-01-15T12:00Z = 07:00 on the same day in NY → date unchanged.
    expect(fmtDate(ISO)).toBe(
      new Date(ISO).toLocaleDateString(undefined, { timeZone: 'America/New_York' }),
    )
    // A late-UTC instant crosses into the next local day in a +14 zone.
    const late = '2026-01-15T23:30:00Z'
    setTimezone('Pacific/Kiritimati') // UTC+14 — 23:30Z → next day 13:30
    expect(fmtDate(late)).toBe(
      new Date(late).toLocaleDateString(undefined, { timeZone: 'Pacific/Kiritimati' }),
    )
    expect(fmtDate(late)).not.toBe(new Date(late).toLocaleDateString(undefined, { timeZone: 'UTC' }))
  })

  it('accepts extra Intl options', () => {
    setTimezone('UTC')
    const out = fmtDateTime(ISO, { dateStyle: 'medium', timeStyle: 'short' })
    expect(out).toBe(
      new Date(ISO).toLocaleString(undefined, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }),
    )
  })

  it('returns empty string for null/undefined/bad input', () => {
    expect(fmtDateTime(null)).toBe('')
    expect(fmtDateTime(undefined)).toBe('')
    expect(fmtDateTime('not-a-date')).toBe('')
    expect(fmtDate(null)).toBe('')
  })

  it('dateKey matches the configured zone date for the report pickers', () => {
    // When unset, dateKey keeps the legacy UTC behavior.
    expect(dateKey()).toBe(new Date().toISOString().slice(0, 10))

    // Force a zone east of UTC late in the day: the configured-zone date can
    // be a day ahead of the UTC date.
    const late = new Date()
    late.setUTCHours(23, 30, 0, 0)
    const realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => late.getTime())
    try {
      setTimezone('Pacific/Kiritimati') // UTC+14 → 23:30 UTC is next-day 13:30 there
      const inZone = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Pacific/Kiritimati',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(late)
        .reduce<Record<string, string>>((acc, p) => {
          if (p.type !== 'literal') acc[p.type] = p.value
          return acc
        }, {})
      const want = `${inZone.year}-${inZone.month}-${inZone.day}`
      expect(dateKey()).toBe(want)

      // Offsets keep the shape YYYY-MM-DD.
      expect(dateKey(-6)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    } finally {
      vi.restoreAllMocks()
      _resetTimezoneForTests()
    }
  })

  it('ensureTimezone resolves the module state from the server', async () => {
    let fetchCalls = 0
    const orig = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalls++
      return {
        ok: true,
        status: 200,
        json: async () => ({ timezone: 'Asia/Singapore' }),
      } as Response
    }) as typeof fetch
    try {
      const p1 = ensureTimezone()
      const p2 = ensureTimezone() // dedupes to one fetch
      expect(await p1).toBe('Asia/Singapore')
      expect(await p2).toBe('Asia/Singapore')
      expect(fetchCalls).toBe(1)
      expect(getTimezone()).toBe('Asia/Singapore')
      expect(timezoneLoaded()).toBe(true)
    } finally {
      globalThis.fetch = orig
      _resetTimezoneForTests()
    }
  })

  it('ensureTimezone falls back to unset when the fetch fails', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    try {
      await expect(ensureTimezone()).resolves.toBe('')
      expect(getTimezone()).toBe('')
      expect(fmtDateTime(ISO)).toBe(new Date(ISO).toLocaleString())
    } finally {
      globalThis.fetch = orig
      _resetTimezoneForTests()
    }
  })
})
