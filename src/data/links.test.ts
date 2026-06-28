import { describe, expect, test } from 'bun:test'
import {
  bareHttpUrl,
  encodeUrlForMarkdown,
  hasLink,
  isHttpUrl,
  sanitizeLinkLabel,
  stripLinks,
  swapLinkLabel,
} from './links'

describe('hasLink', () => {
  test('detects a complete link token', () => {
    expect(hasLink('[label](url)')).toBe(true)
    expect(hasLink('before [x](y) after')).toBe(true)
  })

  test('is false for plain text and incomplete tokens', () => {
    expect(hasLink('plain text')).toBe(false)
    expect(hasLink('[label]')).toBe(false)
    expect(hasLink('(url)')).toBe(false)
  })
})

describe('stripLinks', () => {
  test('flattens links to their label', () => {
    expect(stripLinks('[label](http://x)')).toBe('label')
    expect(stripLinks('a [x](y) b [z](w) c')).toBe('a x b z c')
  })

  test('an empty label collapses to nothing', () => {
    expect(stripLinks('a[](http://x)c')).toBe('ac')
  })

  test('leaves link-free text untouched', () => {
    expect(stripLinks('no links here')).toBe('no links here')
  })
})

describe('isHttpUrl', () => {
  test('accepts http(s), case-insensitive, trimmed', () => {
    expect(isHttpUrl('http://x.com')).toBe(true)
    expect(isHttpUrl('https://x.com')).toBe(true)
    expect(isHttpUrl('HTTPS://X.COM')).toBe(true)
    expect(isHttpUrl('  https://x.com  ')).toBe(true)
  })

  test('rejects other schemes and non-urls', () => {
    expect(isHttpUrl('ftp://x.com')).toBe(false)
    expect(isHttpUrl('mailto:a@b.com')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })
})

describe('bareHttpUrl', () => {
  test('returns the trimmed url when the string is exactly one url', () => {
    expect(bareHttpUrl('https://x.com')).toBe('https://x.com')
    expect(bareHttpUrl('  https://x.com  ')).toBe('https://x.com')
  })

  test('returns null when there is surrounding text or whitespace', () => {
    expect(bareHttpUrl('see https://x.com')).toBeNull()
    expect(bareHttpUrl('https://x.com extra')).toBeNull()
    expect(bareHttpUrl('not-a-url')).toBeNull()
    expect(bareHttpUrl('')).toBeNull()
  })
})

describe('encodeUrlForMarkdown', () => {
  test('encodes only the chars that break the (url) parser', () => {
    expect(encodeUrlForMarkdown('http://x.com/a b?q=(1)')).toBe(
      'http://x.com/a%20b?q=%281%29',
    )
  })

  test('leaves other characters alone', () => {
    expect(encodeUrlForMarkdown('http://x.com/path?a=1&b=2')).toBe(
      'http://x.com/path?a=1&b=2',
    )
  })
})

describe('sanitizeLinkLabel', () => {
  test('strips `]` (fatal to the label grammar)', () => {
    expect(sanitizeLinkLabel('Foo ] bar')).toBe('Foo  bar'.replace(/\s+/g, ' '))
    expect(sanitizeLinkLabel('a]b]c')).toBe('abc')
  })

  test('collapses whitespace and trims', () => {
    expect(sanitizeLinkLabel('  Hello   \n  World  ')).toBe('Hello World')
  })

  test('keeps `[` and `(` `)` (only `]` breaks a label)', () => {
    expect(sanitizeLinkLabel('Foo [bar] (baz)')).toBe('Foo [bar (baz)')
  })

  test('an all-junk title collapses to empty (caller keeps the placeholder)', () => {
    expect(sanitizeLinkLabel('   \n\t ')).toBe('')
    expect(sanitizeLinkLabel(']]]')).toBe('')
  })
})

describe('swapLinkLabel', () => {
  const url = 'https://anthropic.com'

  test('swaps the label of the verbatim placeholder, first occurrence', () => {
    const text = `see [${url}](${url}) now`
    expect(swapLinkLabel(text, url, url, 'Anthropic')).toBe(
      'see [Anthropic](https://anthropic.com) now',
    )
  })

  test('returns null when the placeholder is gone (label was edited)', () => {
    // The user already renamed the label, so the exact `[url](url)` is absent.
    const edited = `[My link](${url}) `
    expect(swapLinkLabel(edited, url, url, 'Anthropic')).toBeNull()
  })

  test('only the first placeholder is touched when the url repeats', () => {
    const text = `[${url}](${url}) and [${url}](${url})`
    expect(swapLinkLabel(text, url, url, 'A')).toBe(
      `[A](${url}) and [${url}](${url})`,
    )
  })

  test('matches against the ENCODED url half (parens case)', () => {
    const raw = 'https://en.wikipedia.org/wiki/Foo_(bar)'
    const enc = encodeUrlForMarkdown(raw)
    const text = `[${raw}](${enc}) tail`
    expect(swapLinkLabel(text, enc, raw, 'Foo (bar)')).toBe(
      `[Foo (bar)](${enc}) tail`,
    )
  })
})
