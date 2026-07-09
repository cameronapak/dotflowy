import { describe, expect, test } from 'bun:test'
import {
  extractBsbVerses,
  flattenVerseContent,
  parseBsbBook,
  parseBsbChapter,
} from './bible-bsb-core'

describe('parseBsbBook', () => {
  test('accepts known OSIS codes case-insensitively', () => {
    expect(parseBsbBook('jhn')).toBe('JHN')
    expect(parseBsbBook('1CO')).toBe('1CO')
    expect(parseBsbBook(' luk ')).toBe('LUK')
  })

  test('rejects unknown or empty codes', () => {
    expect(parseBsbBook(null)).toBeNull()
    expect(parseBsbBook('')).toBeNull()
    expect(parseBsbBook('NOTABOOK')).toBeNull()
    expect(parseBsbBook('../etc')).toBeNull()
    expect(parseBsbBook('JHN/3')).toBeNull()
  })
})

describe('parseBsbChapter', () => {
  test('accepts 1..200 integers', () => {
    expect(parseBsbChapter('1')).toBe(1)
    expect(parseBsbChapter('150')).toBe(150)
  })

  test('rejects non-integers and out of range', () => {
    expect(parseBsbChapter(null)).toBeNull()
    expect(parseBsbChapter('')).toBeNull()
    expect(parseBsbChapter('0')).toBeNull()
    expect(parseBsbChapter('201')).toBeNull()
    expect(parseBsbChapter('3.5')).toBeNull()
    expect(parseBsbChapter('-1')).toBeNull()
    expect(parseBsbChapter('01a')).toBeNull()
  })
})

describe('flattenVerseContent', () => {
  test('joins strings and formatted text, drops notes and breaks', () => {
    expect(
      flattenVerseContent([
        'Hello ',
        { text: 'world' },
        { noteId: 0 },
        { lineBreak: true },
        '!',
      ]),
    ).toBe('Hello world!')
  })

  test('collapses whitespace', () => {
    expect(flattenVerseContent(['  a   b  ', ' c '])).toBe('a b c')
  })
})

describe('extractBsbVerses', () => {
  test('pulls ordered verses from a helloao-shaped body', () => {
    const body = {
      chapter: {
        number: 3,
        content: [
          { type: 'heading', content: ['Title'] },
          {
            type: 'verse',
            number: 16,
            content: ['For God so loved the world.'],
          },
          { type: 'line_break' },
          {
            type: 'verse',
            number: 17,
            content: ['For God did not send His Son', { noteId: 1 }, ' into the world.'],
          },
        ],
      },
    }
    expect(extractBsbVerses(body)).toEqual([
      { n: 16, t: 'For God so loved the world.' },
      { n: 17, t: 'For God did not send His Son into the world.' },
    ])
  })

  test('returns [] for malformed input', () => {
    expect(extractBsbVerses(null)).toEqual([])
    expect(extractBsbVerses({})).toEqual([])
    expect(extractBsbVerses({ chapter: { content: 'nope' } })).toEqual([])
  })
})
