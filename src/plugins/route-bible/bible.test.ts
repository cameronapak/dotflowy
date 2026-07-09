import { describe, expect, test } from 'bun:test'
import {
  bibleRefsToMarkdownLinks,
  bibleRefUrlAtOffset,
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

  test('normalizes a trailing-colon draft as the chapter', () => {
    // Mid-type "Luke 8:" must still commit / open the BSB reader.
    expect(normalizeBibleRef('Luke 8:')).toEqual({
      label: 'Luke 8',
      url: 'https://route.bible/luk.8?src=dotflowy',
    })
  })

  test('suggests books for partial input, but not verse numbers once a chapter is known', () => {
    expect(suggestBibleRefs('rom').map((s) => s.label)).toContain('Romans')
    // Chapter-resolved (including trailing ":") → empty; the mini-reader owns verse pick.
    expect(suggestBibleRefs('rom 8')).toEqual([])
    expect(suggestBibleRefs('Luke 8:')).toEqual([])
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

describe('bibleRefUrlAtOffset', () => {
  const text = 'Read John 3:16 today'

  test('returns the route.bible URL when the caret touches the reference', () => {
    expect(bibleRefUrlAtOffset(text, 'Read '.length)).toBe(
      'https://route.bible/jhn.3.16?src=dotflowy',
    )
    expect(bibleRefUrlAtOffset(text, 'Read John 3:16'.length)).toBe(
      'https://route.bible/jhn.3.16?src=dotflowy',
    )
  })

  test('returns null outside a valid reference', () => {
    expect(bibleRefUrlAtOffset(text, 0)).toBeNull()
    expect(bibleRefUrlAtOffset('Hello 3', 'Hello 3'.length)).toBeNull()
  })

  test('ignores refs inside link and code tokens, matching what chips', () => {
    const code = '`see John 3:16` after'
    expect(bibleRefUrlAtOffset(code, '`see John'.length)).toBeNull()
    const link = 'read [John 3:16](https://example.com) now'
    expect(bibleRefUrlAtOffset(link, 'read [John'.length)).toBeNull()
  })
})

describe('bibleRefsToMarkdownLinks', () => {
  test('converts valid references to route.bible markdown links', () => {
    expect(bibleRefsToMarkdownLinks('Read John 3:16 today')).toBe(
      'Read [John 3:16](https://route.bible/jhn.3.16?src=dotflowy) today',
    )
  })

  test('leaves invalid candidates and existing markdown/code alone', () => {
    expect(
      bibleRefsToMarkdownLinks(
        'Hello 3 [John 3:16](https://example.com) `Romans 8:28`',
      ),
    ).toBe('Hello 3 [John 3:16](https://example.com) `Romans 8:28`')
  })
})
