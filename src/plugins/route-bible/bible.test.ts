import { describe, expect, test } from 'bun:test'
import { bibleRefsToMarkdownLinks, resolveBibleRef } from './bible'

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
