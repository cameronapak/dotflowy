import { describe, expect, test } from 'bun:test'
import {
  BOLD_PATTERN,
  emphasisMarkerLen,
  hasEmphasis,
  ITALIC_PATTERN,
  STRIKETHROUGH_PATTERN,
  stripEmphasis,
  UNDERLINE_PATTERN,
} from './emphasis'

// Match a single pattern against `text` (anchored) -- mirrors how the combined
// regex would dispatch a same-shape run.
function matches(pattern: string, text: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(text)
}

describe('individual patterns', () => {
  test('italic matches a single-* run', () => {
    expect(matches(ITALIC_PATTERN, '*hi*')).toBe(true)
    expect(matches(ITALIC_PATTERN, 'a *hi* b')).toBe(false) // unanchored, has prefix
  })

  test('italic rejects a literal * inside the interior (no nesting v1)', () => {
    expect(matches(ITALIC_PATTERN, '*a*b*c*')).toBe(false)
  })

  test('bold matches a double-* run', () => {
    expect(matches(BOLD_PATTERN, '**hi**')).toBe(true)
    expect(matches(BOLD_PATTERN, '*hi*')).toBe(false) // single-* is italic, not bold
  })

  test('bold interior forbids a literal *', () => {
    expect(matches(BOLD_PATTERN, '**a*b*c**')).toBe(false)
  })

  test('strikethrough matches ~~x~~', () => {
    expect(matches(STRIKETHROUGH_PATTERN, '~~done~~')).toBe(true)
  })

  test('underline matches ~x~', () => {
    expect(matches(UNDERLINE_PATTERN, '~under~')).toBe(true)
  })

  test('underline rejects a literal ~ inside', () => {
    expect(matches(UNDERLINE_PATTERN, '~a~b~')).toBe(false)
  })
})

describe('prefix disambiguation (lower precedence wins on overlap)', () => {
  test('the combined alternation picks bold before italic on a ** run', () => {
    // In the registry, bold is listed before italic in the alternation, so the
    // combined regex matches `**hi**` as BOLD (one match, full span), not as
    // two italic runs `*hi*` + trailing `*`. Verify the precedence holds by
    // matching the combined shape against an isolated ** run.
    const combined = new RegExp(
      `^(?:${BOLD_PATTERN}|${ITALIC_PATTERN})$`,
    )
    expect(combined.test('**hi**')).toBe(true)
    // The match should consume the WHOLE `**hi**` -- if italic won, it would
    // leave a trailing `*` and the anchored test would fail.
  })

  test('strikethrough is picked before underline on a ~~ run', () => {
    const combined = new RegExp(
      `^(?:${STRIKETHROUGH_PATTERN}|${UNDERLINE_PATTERN})$`,
    )
    expect(combined.test('~~done~~')).toBe(true)
    // Same anchor logic: if underline won it'd match `~done~` and leave `~`.
  })
})

describe('hasEmphasis', () => {
  test('detects any emphasis run in free text', () => {
    expect(hasEmphasis('*italic*')).toBe(true)
    expect(hasEmphasis('a **bold** b')).toBe(true)
    expect(hasEmphasis('~~strike~~ and ~underline~')).toBe(true)
  })

  test('is false for plain text and unclosed markers', () => {
    expect(hasEmphasis('plain text')).toBe(false)
    expect(hasEmphasis('*unclosed')).toBe(false)
    expect(hasEmphasis('**also unclosed')).toBe(false)
  })
})

describe('stripEmphasis', () => {
  test('strips markers from each run kind, keeps surrounding text', () => {
    expect(stripEmphasis('*italic*')).toBe('italic')
    expect(stripEmphasis('**bold**')).toBe('bold')
    expect(stripEmphasis('~~strike~~')).toBe('strike')
    expect(stripEmphasis('~underline~')).toBe('underline')
  })

  test('preserves text between runs', () => {
    expect(stripEmphasis('a *b* c **d** e')).toBe('a b c d e')
  })

  test('leaves emphasis-free text untouched', () => {
    expect(stripEmphasis('no emphasis here')).toBe('no emphasis here')
  })

  test('flat-v1 picks the outer bold match on `***triple***` (leftover `*` literal)', () => {
    // `**triple**` matches as bold (precedence wins over italic on overlap);
    // the leading `*` is left literal. This is the documented v1 flat rule --
    // nesting is not supported.
    expect(stripEmphasis('***triple***')).toBe('*triple*')
  })
})

describe('emphasisMarkerLen', () => {
  test('returns 2 for bold and strikethrough, 1 for italic and underline', () => {
    expect(emphasisMarkerLen('**bold**')).toBe(2)
    expect(emphasisMarkerLen('~~strike~~')).toBe(2)
    expect(emphasisMarkerLen('*italic*')).toBe(1)
    expect(emphasisMarkerLen('~underline~')).toBe(1)
  })

  test('returns 0 for an unrecognized run (defensive)', () => {
    expect(emphasisMarkerLen('not a run')).toBe(0)
  })
})
