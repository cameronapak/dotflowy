import { describe, expect, test } from 'bun:test'
import { tagColorsCss, type TagColorRow } from './tag-colors'

const row = (tag: string, color: string): TagColorRow => ({ tag, color })

describe('tagColorsCss', () => {
  test('no rows -> empty string', () => {
    expect(tagColorsCss([])).toBe('')
  })

  test('emits two keyed rules for a valid colored tag', () => {
    const css = tagColorsCss([row('work', 'blue')])
    expect(css.split('\n')).toHaveLength(2)
    expect(css).toContain('[data-tag="work" i][data-tag]{background:var(--tag-blue)')
    expect(css).toContain('--tag-blue-fg') // the pill hover rule
  })

  test('skips an unknown color', () => {
    expect(tagColorsCss([row('work', 'rainbow')])).toBe('')
  })

  test('skips an unsafe tag name (CSS-injection guard)', () => {
    // quotes/brackets/braces/spaces fail the /^[\p{L}\p{N}_-]+$/u guard
    expect(tagColorsCss([row('work"]{}', 'blue')])).toBe('')
    expect(tagColorsCss([row('has space', 'blue')])).toBe('')
  })

  test('allows hyphen, underscore, and unicode tag names', () => {
    expect(tagColorsCss([row('work-q3', 'red')])).toContain('[data-tag="work-q3" i]')
    expect(tagColorsCss([row('важно', 'green')])).toContain('[data-tag="важно" i]')
  })

  test('emits only the safe rows from a mixed batch', () => {
    const css = tagColorsCss([
      row('ok', 'teal'),
      row('bad"name', 'teal'),
      row('ok2', 'notacolor'),
    ])
    expect(css).toContain('[data-tag="ok" i]')
    expect(css).not.toContain('bad')
    expect(css).not.toContain('ok2')
  })
})
