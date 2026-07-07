import { describe, expect, test } from 'bun:test'
import {
  bibleRefsToMarkdownLinks,
  bibleRefUrlAtOffset,
  resolveBibleRef,
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
