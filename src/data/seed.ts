import { appendChild } from './mutations'
import { createId, makeNode, now } from './tree'
import { nodesCollection, nodesLoadError } from './collection'
import { importLegacyNodes } from './import-legacy'
import { BootstrapError } from './errors'

// Per-userId guards (PRD US-1): reset when auth changes so a second account
// on the same tab gets its own import-or-seed pass. StrictMode double-mount
// still bails on the same userId — only one chain runs per user.
let bootstrappedUserId: string | null = null

/**
 * First-run bootstrap. Exactly one of two things happens: a legacy localStorage
 * outline is imported into the signed-in user's Postgres silo (returning user),
 * or the welcome bullets are seeded (genuinely new user). Import wins when
 * present. Called once on mount with the current `userId`; guards reset on
 * auth change (PRD US-1).
 */
export async function bootstrapOutline(
  userId: string,
): Promise<BootstrapError | void> {
  if (bootstrappedUserId === userId) return
  bootstrappedUserId = userId
  // Wait for the first load to settle. The .catch covers the rare paths where
  // preload() actually rejects (a synchronous sync-init throw); the common
  // 500/offline case resolves here and is caught by the nodesLoadError gate.
  const ready = await nodesCollection
    .toArrayWhenReady()
    .catch((e) => new BootstrapError({ cause: e }))
  if (ready instanceof Error) return ready
  const loadError = nodesLoadError()
  if (loadError) return new BootstrapError({ cause: loadError })

  if (await importLegacyNodes()) return
  await seedIfEmpty(userId)
}

// Per-userId seed guard — same StrictMode race as bootstrappedUserId above.
let seedStartedUserId: string | null = null

/**
 * Seed the outline on first run. Idempotent and async-safe: it awaits the
 * collection's initial load (`toArrayWhenReady`) before deciding, so it only
 * seeds when the server genuinely has no nodes for this user — never on the
 * brief "empty before the first fetch resolves" window.
 */
async function seedIfEmpty(userId: string): Promise<boolean> {
  if (seedStartedUserId === userId) return false
  seedStartedUserId = userId

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
