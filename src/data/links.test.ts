import { describe, expect, test } from 'bun:test'
import {
  bareHttpUrl,
  encodeUrlForMarkdown,
  hasLink,
  isHttpUrl,
  stripLinks,
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
