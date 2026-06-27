import { describe, expect, test } from 'bun:test'
import { toKvKeys, toKvRows } from './kv-api'

// The transaction shape these read is structural: { mutations: [{ key, modified }] }.
const tx = (mutations: { key: unknown; modified?: unknown }[]) => ({ mutations })

describe('toKvRows', () => {
  test('maps each mutation to { key: String(key), value: modified }', () => {
    const out = toKvRows(
      tx([
        { key: 'work', modified: { tag: 'work', color: 'blue' } },
        { key: 'urgent', modified: { tag: 'urgent', color: 'red' } },
      ]),
    )
    expect(out).toEqual([
      { key: 'work', value: { tag: 'work', color: 'blue' } },
      { key: 'urgent', value: { tag: 'urgent', color: 'red' } },
    ])
  })

  test('stringifies non-string keys and passes modified through verbatim', () => {
    expect(toKvRows(tx([{ key: 42, modified: undefined }]))).toEqual([
      { key: '42', value: undefined },
    ])
  })

  test('empty transaction -> empty rows', () => {
    expect(toKvRows(tx([]))).toEqual([])
  })
})

describe('toKvKeys', () => {
  test('maps each mutation to its stringified key', () => {
    expect(toKvKeys(tx([{ key: 'a' }, { key: 'b' }, { key: 7 }]))).toEqual([
      'a',
      'b',
      '7',
    ])
  })

  test('empty transaction -> empty keys', () => {
    expect(toKvKeys(tx([]))).toEqual([])
  })
})
