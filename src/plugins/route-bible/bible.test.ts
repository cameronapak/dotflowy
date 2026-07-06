import { describe, expect, test } from 'bun:test'
import {
  formatStructuredBibleRef,
  normalizeBibleRef,
  replaceBibleRefToken,
  resolveBibleRef,
  suggestBibleRefs,
} from './bible'

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

  test('normalizes display labels for rewritten references', () => {
    expect(normalizeBibleRef('rom 8:28')).toEqual({
      label: 'Romans 8:28',
      url: 'https://route.bible/rom.8.28?src=dotflowy',
    })
  })

  test('suggests passages for partial input', () => {
    expect(suggestBibleRefs('rom 8').map((s) => s.label)).toContain('Romans 8')
  })

  test('formats structured passage selections', () => {
    expect(
      formatStructuredBibleRef({
        book: 'JHN',
        chapter: 3,
        startVerse: 16,
        endVerse: 18,
      }),
    ).toBe('John 3:16-18')
    expect(
      formatStructuredBibleRef({
        book: 'PRO',
        chapter: 4,
        startVerse: null,
        endVerse: null,
      }),
    ).toBe('Proverbs 4')
  })

  test('replaces the captured token only when it is still present', () => {
    expect(replaceBibleRefToken('Read John 3:16 today', 'John 3:16', 'Romans 8:28')).toBe(
      'Read Romans 8:28 today',
    )
    expect(replaceBibleRefToken('Read Romans 8:28 today', 'John 3:16', 'Romans 8:28')).toBeNull()
  })
})
