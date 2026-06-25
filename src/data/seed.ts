import { appendChild } from './mutations'
import { createId, makeNode, now } from './tree'
import { nodesCollection, nodesLoadError } from './collection'
import { importLegacyNodes } from './import-legacy'
import { BootstrapError } from './errors'

// Completed bootstrap for this user (StrictMode + revisits). A monotonic run
// token cancels stale async chains when auth switches before await points finish.
let bootstrappedUserId: string | null = null
let bootstrapRunId = 0

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
  const runId = ++bootstrapRunId
  const alive = () => runId === bootstrapRunId

  const ready = await nodesCollection
    .toArrayWhenReady()
    .catch((e) => new BootstrapError({ cause: e }))
  if (!alive()) return
  if (ready instanceof Error) return ready
  const loadError = nodesLoadError()
  if (loadError) return new BootstrapError({ cause: loadError })

  if (await importLegacyNodes()) {
    if (!alive()) return
    bootstrappedUserId = userId
    return
  }
  await seedIfEmpty(userId, alive)
  if (!alive()) return
  bootstrappedUserId = userId
}

/**
 * Seed the outline on first run. Idempotent and async-safe: it awaits the
 * collection's initial load (`toArrayWhenReady`) before deciding, so it only
 * seeds when the server genuinely has no nodes for this user — never on the
 * brief "empty before the first fetch resolves" window.
 */
async function seedIfEmpty(
  userId: string,
  alive: () => boolean,
): Promise<void> {
  if (!alive()) return

  const existing = await nodesCollection.toArrayWhenReady()
  if (!alive()) return
  if (existing.length > 0) return

  const aId = createId()
  const bId = createId()
  const cId = createId()

  if (!alive()) return
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

  appendChild(aId, null, 'This is a sub-bullet. Collapse its parent with the dot.')
}
