import { appendChild } from './mutations'
import { createId, makeNode, now } from './tree'
import { nodesCollection } from './collection'

/**
 * Seed the outline on first run. Idempotent: if any node already exists
 * in the collection, do nothing.
 *
 * We can't read state synchronously at module load in a way that's safe
 * across hydration, so the component calls this inside a useEffect once
 * it observes an empty collection.
 */
export function seedIfEmpty(hasAnyNode: boolean): boolean {
  if (hasAnyNode) return false

  // Three sibling top-level bullets, one with a child, so the user lands
  // on something that demonstrates the structure immediately.
  const aId = createId()
  const bId = createId()
  const cId = createId()

  nodesCollection.insert(
    makeNode({
      id: aId,
      parentId: null,
      prevSiblingId: null,
      text: 'Welcome to Dotflowy OSS',
      createdAt: now(),
    }),
  )
  nodesCollection.insert(
    makeNode({
      id: bId,
      parentId: null,
      prevSiblingId: aId,
      text: 'Press Enter to add a bullet',
    }),
  )
  nodesCollection.insert(
    makeNode({
      id: cId,
      parentId: null,
      prevSiblingId: bId,
      text: 'Tab indents, Shift+Tab outdents, Backspace on empty deletes',
    }),
  )

  // A child under the welcome bullet to show nesting.
  appendChild(aId, null, 'This is a sub-bullet. Collapse its parent with the dot.')

  return true
}
