import { appendChild } from './mutations'
import { createId, makeNode, now } from './tree'
import { nodesCollection } from './collection'

// One-shot guard, set synchronously before the first await. The old
// localStorage seed was synchronous, so a double-mounted effect saw the
// just-written rows and skipped. The D1 path is async: two effect invocations
// (StrictMode / Start's dev client re-mount) would both await an empty
// collection and both seed. This flag closes that race — the second caller
// bails before inserting. Module-scoped, so it survives a component remount.
let seedStarted = false

/**
 * Seed the outline on first run. Idempotent and async-safe: it awaits the
 * collection's initial load (`toArrayWhenReady`) before deciding, so it only
 * seeds when the server genuinely has no nodes for this user — never on the
 * brief "empty before the first fetch resolves" window the D1-backed query
 * collection passes through. Returns true if it seeded.
 *
 * The component calls this once on mount; the inserts persist to D1 through the
 * collection's normal mutation path. See docs/adr/0023.
 */
export async function seedIfEmpty(): Promise<boolean> {
  if (seedStarted) return false
  seedStarted = true

  const existing = await nodesCollection.toArrayWhenReady()
  if (existing.length > 0) return false

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
