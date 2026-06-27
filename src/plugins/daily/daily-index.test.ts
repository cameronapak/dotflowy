import { describe, expect, test } from 'bun:test'
import {
  formatDayBadge,
  formatDayRelative,
  formatDayText,
  localDateKey,
} from './daily-index'

describe('localDateKey', () => {
  test('formats LOCAL Y-M-D, zero-padded (never toISOString/UTC)', () => {
    // local constructor -> getFullYear/Month/Date read local fields regardless of TZ
    expect(localDateKey(new Date(2026, 5, 23))).toBe('2026-06-23')
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    // late-evening local time still reports the local day, not a UTC-rolled one
    expect(localDateKey(new Date(2026, 5, 23, 23, 30))).toBe('2026-06-23')
  })
})

describe('formatDayRelative', () => {
  const today = '2026-06-23'

  test('labels the near days, null beyond +/-1', () => {
    expect(formatDayRelative('2026-06-23', today)).toBe('Today')
    expect(formatDayRelative('2026-06-22', today)).toBe('Yesterday')
    expect(formatDayRelative('2026-06-24', today)).toBe('Tomorrow')
    expect(formatDayRelative('2026-06-20', today)).toBeNull()
  })

  test('null on a malformed key', () => {
    expect(formatDayRelative('not-a-date', today)).toBeNull()
  })
})

describe('formatDayBadge', () => {
  test('prefers the relative label when there is one', () => {
    expect(formatDayBadge('2026-06-23', '2026-06-23')).toBe('Today')
    expect(formatDayBadge('2026-06-22', '2026-06-23')).toBe('Yesterday')
  })

  test('falls back to a short date for far days (not a relative word)', () => {
    const badge = formatDayBadge('2026-01-15', '2026-06-23')
    expect(badge).not.toBe('Today')
    expect(badge.length).toBeGreaterThan(0)
  })
})

describe('formatDayText', () => {
  test('includes the year for a valid key', () => {
    expect(formatDayText('2026-06-23')).toContain('2026')
  })

  test('returns the raw key unchanged when malformed', () => {
    expect(formatDayText('garbage')).toBe('garbage')
  })
})
