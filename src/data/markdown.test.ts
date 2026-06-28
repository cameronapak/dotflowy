import { describe, expect, test } from 'bun:test'
import { buildTreeIndex, makeNode } from './tree'
import { outlineToMarkdown } from './markdown'

describe('outlineToMarkdown', () => {
  test('nests children two spaces per level under the root bullet', () => {
    // root
    //   child
    //     grandchild
    const root = makeNode({ id: 'root', text: 'root' })
    const child = makeNode({ id: 'child', parentId: 'root', text: 'child' })
    const grandchild = makeNode({
      id: 'gc',
      parentId: 'child',
      text: 'grandchild',
    })
    const index = buildTreeIndex([root, child, grandchild])

    expect(outlineToMarkdown(index, ['root'])).toBe(
      ['- root', '  - child', '    - grandchild'].join('\n'),
    )
  })

  test('orders siblings by the prevSiblingId chain', () => {
    const root = makeNode({ id: 'root', text: 'root' })
    const a = makeNode({ id: 'a', parentId: 'root', prevSiblingId: null, text: 'a' })
    const b = makeNode({ id: 'b', parentId: 'root', prevSiblingId: 'a', text: 'b' })
    // fed out of order on purpose
    const index = buildTreeIndex([b, root, a])

    expect(outlineToMarkdown(index, ['root'])).toBe(
      ['- root', '  - a', '  - b'].join('\n'),
    )
  })

  test('renders tasks as GFM checkboxes by completion', () => {
    const open = makeNode({ id: 'o', isTask: true, completed: false, text: 'open' })
    const done = makeNode({ id: 'd', isTask: true, completed: true, text: 'done' })
    const index = buildTreeIndex([open, done])

    expect(outlineToMarkdown(index, ['o', 'd'])).toBe(
      ['- [ ] open', '- [x] done'].join('\n'),
    )
  })

  test('emits node.text verbatim (links, tags, code are already markdown)', () => {
    const node = makeNode({
      id: 'n',
      text: 'see [docs](https://x.dev) #ref `code`',
    })
    const index = buildTreeIndex([node])

    expect(outlineToMarkdown(index, ['n'])).toBe(
      '- see [docs](https://x.dev) #ref `code`',
    )
  })

  test('includes collapsed and completed nodes (full fidelity, ignores view)', () => {
    const root = makeNode({ id: 'root', text: 'root', collapsed: true })
    const hidden = makeNode({
      id: 'h',
      parentId: 'root',
      text: 'still here',
      isTask: true,
      completed: true,
    })
    const index = buildTreeIndex([root, hidden])

    expect(outlineToMarkdown(index, ['root'])).toBe(
      ['- root', '  - [x] still here'].join('\n'),
    )
  })

  test('an empty node is a bare bullet', () => {
    const root = makeNode({ id: 'root', text: '' })
    const child = makeNode({ id: 'c', parentId: 'root', text: 'child' })
    const index = buildTreeIndex([root, child])

    expect(outlineToMarkdown(index, ['root'])).toBe(['- ', '  - child'].join('\n'))
  })

  test('multiple roots serialize as adjacent top-level bullets', () => {
    const a = makeNode({ id: 'a', prevSiblingId: null, text: 'a' })
    const b = makeNode({ id: 'b', prevSiblingId: 'a', text: 'b' })
    const a1 = makeNode({ id: 'a1', parentId: 'a', text: 'a1' })
    const index = buildTreeIndex([a, b, a1])

    expect(outlineToMarkdown(index, ['a', 'b'])).toBe(
      ['- a', '  - a1', '- b'].join('\n'),
    )
  })

  test('unknown root id contributes nothing', () => {
    const a = makeNode({ id: 'a', text: 'a' })
    const index = buildTreeIndex([a])

    expect(outlineToMarkdown(index, ['ghost'])).toBe('')
  })
})
