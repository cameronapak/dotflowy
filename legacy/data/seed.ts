import { appendChild } from './mutations'
import { createId, makeNode, now } from './tree'
import { nodesCollection, nodesLoadError } from './collection'
import { importLegacyNodes } from './import-legacy'
import { BootstrapError } from './errors'

// One-shot guard, set synchronously before the first await. bootstrapOutline is
// the single mount entry point; this guard means React StrictMode's
// double-mounted effect can't run two competing chains — which would otherwise
// race the legacy import against the seed on the same empty collection.
let bootstrapped = false

/**
 * First-run bootstrap. Exactly one of two things happens: a pre-D1 outline in
 * localStorage is imported into D1 (returning user), or the welcome bullets are
 * seeded (genuinely new user). Import wins when present, so we never stack
 * welcome bullets on top of imported data. Called once on mount; see
 * import-legacy.ts and docs/DECISIONS.md (D1 sync).
 *
 * Bail BEFORE seeding/importing if the initial load failed. The query adapter
 * calls markReady() even on a failed fetch, so `toArrayWhenReady()` resolves
 * EMPTY rather than rejecting (see nodesLoadError) -- without this gate a
 * returning user who opens the app during a server outage would have welcome
 * bullets seeded over their real (just-unreachable) outline, and the one-time
 * legacy-import flag would be set against a write that rolls back. We surface
 * the failure as a value (errore convention); the caller logs it.
 */
export async function bootstrapOutline(): Promise<BootstrapError | void> {
  if (bootstrapped) return
  bootstrapped = true
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
  await seedIfEmpty()
}

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
 * collection passes through. Returns true if it seeded, false otherwise.
 *
 * The failed-load case is handled upstream in bootstrapOutline (the query
 * adapter resolves this empty on failure, so seeding here would clobber a
 * just-unreachable outline). By the time bootstrap calls us the collection is
 * already ready, so this await resolves instantly.
 *
 * The component calls this once on mount; the inserts persist to D1 through the
 * collection's normal mutation path. See docs/DECISIONS.md (D1 sync).
 */
async function seedIfEmpty(): Promise<boolean> {
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
