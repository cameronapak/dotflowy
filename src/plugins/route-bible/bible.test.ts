import { describe, expect, test } from 'bun:test'
import { resolveBibleRef } from './bible'

describe('resolveBibleRef', () => {
  test('resolves real references to a route.bible url with attribution', () => {
    for (const ref of ['John 3:16', '1 John 2:1', 'Genesis 1']) {
      const out = resolveBibleRef(ref)
      expect(out).not.toBeNull()
      expect(out?.url.startsWith('https://route.bible')).toBe(true)
      expect(out?.url).toContain('src=dotflowy')
    }
  })

  test('rejects candidates grab-bcv will not parse (liberal regex, strict parser)', () => {
    // not a book; out of range; plain prose; empty
    expect(resolveBibleRef('Hello 3')).toBeNull()
    expect(resolveBibleRef('Revelation 99:99')).toBeNull()
    expect(resolveBibleRef('just some plain text')).toBeNull()
    expect(resolveBibleRef('')).toBeNull()
  })
})
