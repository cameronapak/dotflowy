import { createCollection } from '@tanstack/react-db'
import { type Cause, Duration, Effect, Fiber, Schema, Stream } from 'effect'
import { nodeSchema } from './schema'
import type { Node } from './schema'
import { createNodes, deleteNodes, updateNodes } from './api'
import { runPromise } from './nodes-client-effect'
import { makeSyncStream } from './realtime'
import type { ChangeOp, ServerMessage, SyncEvent } from './realtime'
import { appRuntime } from './runtime'
import { buildTreeIndex, childrenOf, now } from './tree'
import { chainDisagreements } from './sibling-chain'
import { isMirrorsEnabled } from './flags'

/**
 * Single source of truth for all outline nodes.
 *
 * Backed by a per-user Durable Object over a real-time WebSocket (realtime.ts ->
 * /api/sync). This is a TanStack DB *custom sync* collection: on connect the DO
 * streams a `snapshot` (the full outline), then every edit on any of the user's
 * devices arrives as a `change` delta and is applied live -- no window-focus
 * refetch. A reconnect resumes from the last applied seq (or falls back to a
 * fresh snapshot). Why a DO + WebSocket: docs/adr/0008-sync-via-a-per-user-durable-object.md.
 *
 * The WRITE path has two lanes. FIELD edits (text, completed, ...) take the
 * optimistic handlers below: insert -> onInsert -> POST, update -> onUpdate ->
 * PATCH, each returning `{ refetch: false }` (the socket echoes the persisted
 * change back, reconciling idempotently). STRUCTURAL edits bypass the handlers
 * via `runStructural` (structural.ts), which batches all their writes into one
 * `POST /api/nodes {ops}` and holds the overlay until the echo (`waitForSeq`
 * here) -- so an insert-and-repoint can't tear across two requests. See
 * docs/adr/0009-atomic-structural-writes.md. Either way a handler maps over
 * `transaction.mutations` (a field op can still carry several), never `[0]`.
 *
 * The collection interface (insert / update / delete / subscribeChanges /
 * toArray / toArrayWhenReady) is unchanged, so the tree store, mutations, and
 * components don't care that the adapter swapped from query-collection to a live
 * socket.
 *
 * We let the schema drive the item type via inference rather than passing
 * `<Node>` to createCollection (the schema overload keys off StandardSchemaV1;
 * an explicit generic routes inference down the wrong branch).
 */

/** The initial-load error, if the first sync failed, else null. The socket calls
 *  markReady() even when it can't reach the server (so the app doesn't hang),
 *  which would otherwise leave the collection ready+empty -- indistinguishable
 *  from a genuinely empty new account. First-run bootstrap reads this to avoid
 *  seeding welcome bullets over a real-but-unreachable outline (see seed.ts).
 *  Cleared the moment a real snapshot arrives (a recovered socket). */
let initialError: Error | null = null
export function nodesLoadError(): Error | null {
  return initialError
}

/**
 * Whether the first sync frame (snapshot, resume, or initial error) has landed --
 * i.e. the collection is ready to render its real state. Distinct from
 * `useHasNodes`, which reads `byId.size > 0` and so CONFLATES "still loading" with
 * "genuinely empty": on first paint both look like zero nodes, which is exactly
 * the state that made the outline flash from empty to populated. This flag flips
 * true exactly once, the moment sync is ready, so the shell can hold a loading
 * spinner until then. Session-lived on purpose: a mid-session reconnect keeps it true, so
 * we never flash the loading state again once the outline has been shown.
 */
let syncReady = false
const syncReadyListeners = new Set<() => void>()
export function isSyncReady(): boolean {
  return syncReady
}
export function subscribeSyncReady(listener: () => void): () => void {
  syncReadyListeners.add(listener)
  return () => {
    syncReadyListeners.delete(listener)
  }
}
function markSyncReady(): void {
  if (syncReady) return
  syncReady = true
  for (const listener of syncReadyListeners) listener()
}

/** Force the outline to reconcile against server truth now (a fresh snapshot).
 *  Used by the daily plugin's claim loser-path; a no-op before the socket
 *  connects (or during the `/` prerender). */
let resyncFn: (() => void) | null = null
export function resyncNodes(): void {
  resyncFn?.()
}

/**
 * The highest change-frame `seq` this client has applied (snapshot, resume, or
 * live change). A module-level mirror of the sync cursor so `waitForSeq` can be
 * awaited from outside the sync closure. Starts at 0 (nothing applied).
 */
let appliedSeq = 0
type SeqWaiter = { seq: number; resolve: () => void }
const seqWaiters = new Set<SeqWaiter>()

/**
 * The last `text` value the SYNC channel applied for each node id (a live change
 * or resume frame -- i.e. the server's echo of some edit). The focused bullet
 * uses this to tell an echo-driven store change from a local one: while you are
 * typing, the contentEditable DOM is authoritative, so a store change whose text
 * equals the echo we just received is the network reflecting your own (possibly
 * stale or out-of-order) keystrokes back -- repainting it mid-type is exactly
 * what scrambles characters and jumps the caret. A LOCAL change (undo/redo, a
 * slash insert) carries a value that does NOT match the latest echo, so it still
 * repaints. See OutlineNode's store-sync effect.
 */
const echoedText = new Map<string, string>()
export function echoedTextFor(id: string): string | undefined {
  return echoedText.get(id)
}

/** Advance the applied cursor and release any waiters it satisfies. Monotonic:
 *  a lower/equal seq (a redundant frame) is ignored. Called wherever a LIVE
 *  frame is applied (live change, resume). Snapshots use `resetAppliedSeq`. */
function advanceAppliedSeq(seq: number): void {
  if (seq <= appliedSeq) return
  appliedSeq = seq
  // Deleting the current entry mid-iteration is safe for a Set.
  for (const w of seqWaiters) {
    if (appliedSeq >= w.seq) {
      seqWaiters.delete(w)
      w.resolve()
    }
  }
}

/** Reset the cursor to a snapshot's seq and release EVERY pending waiter.
 *  A snapshot is full server truth, so it supersedes the stream regardless of
 *  direction — and seqs are scoped per Durable Object/user, so a same-page
 *  account switch (sign-out/sign-in is SPA-internal, no reload) can hand us a
 *  LOWER seq than the previous user's. `advanceAppliedSeq` would ignore that
 *  (it's monotonic) and leave the cursor stuck high, so `waitForSeq` would
 *  resolve instantly and silently drop the P2 echo-hold for the new outline.
 *  Setting (not advancing) and resolving all waiters makes any in-flight
 *  structural tx trust the snapshot — the same fallback `waitForSeq`'s timeout
 *  already takes. */
function resetAppliedSeq(seq: number): void {
  appliedSeq = seq
  for (const w of seqWaiters) {
    seqWaiters.delete(w)
    w.resolve()
  }
}

/**
 * Complete once this client has applied change-frame `seq` (the originator's own
 * echo, a resume gap, or a superseding snapshot all advance the cursor past it).
 * `runStructural` composes this onto its batch send (structural.ts) so a
 * structural transaction stays optimistic until its write echoes back — never
 * reverting to a pre-op state a fast follow-up edit could read (PLAN.md, P2).
 *
 * An Effect: the `seqWaiters` registration is lifted with `Effect.callback` (the
 * sync-fiber cursor advance still releases it through `w.resolve`), and the
 * fallback is `Effect.timeoutOrElse` resolving to `void`. On timeout it COMPLETES
 * (never fails): a snapshot/resync may have superseded the seq, or the socket is
 * wedged; either way trust the synced snapshot rather than hang the transaction.
 * The interrupt finalizer drops the waiter, so a timed-out wait can't leak.
 */
export function waitForSeqE(seq: number, timeoutMs = 8000): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    if (appliedSeq >= seq) {
      resume(Effect.void)
      return
    }
    const waiter: SeqWaiter = { seq, resolve: () => resume(Effect.void) }
    seqWaiters.add(waiter)
    return Effect.sync(() => {
      seqWaiters.delete(waiter)
    })
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () => Effect.void,
    }),
  )
}

/**
 * Complete once `id` is present in the collection (live delta or snapshot); on
 * timeout it FAILS (the opposite of `waitForSeqE` — the daily claim loser-path
 * wants to know the node never replicated, then materializes locally instead).
 * `Effect.callback` over `subscribeChanges`, time-bounded by `Effect.timeout`.
 */
export function waitForNodeE(
  id: string,
  timeoutMs = 8000,
): Effect.Effect<void, Cause.TimeoutError> {
  return Effect.callback<void>((resume) => {
    const present = () => nodesCollection.toArray.some((n) => n.id === id)
    if (present()) {
      resume(Effect.void)
      return
    }
    // `Effect.callback`'s returned finalizer runs ONLY on interruption (the
    // timeout path), NOT on a successful `resume` — so the success paths must
    // unsubscribe themselves or the listener leaks (it would keep running
    // `present()` on every future collection change). `unsubscribe` is
    // idempotent, so a later finalizer call after success is harmless.
    const sub = nodesCollection.subscribeChanges(() => {
      if (present()) {
        sub.unsubscribe()
        resume(Effect.void)
      }
    })
    // Guard the registration gap (a delta applied between the check and subscribe).
    if (present()) {
      sub.unsubscribe()
      resume(Effect.void)
    }
    return Effect.sync(() => {
      sub.unsubscribe()
    })
  }).pipe(Effect.timeout(Duration.millis(timeoutMs)))
}

/** Promise form of {@link waitForNodeE} for the daily claim loser-path (rejects
 *  on timeout; the caller `.catch`es it and materializes locally). */
export function waitForNode(id: string, timeoutMs = 8000): Promise<void> {
  return runPromise(waitForNodeE(id, timeoutMs))
}

/**
 * Heal a shattered sibling order.
 *
 * Order within a parent is a `prevSiblingId` linked list, rebuilt at read time
 * by buildTreeIndex (tree.ts). A write race (a structural move/insert relinking
 * pointers against a stale TreeIndex, or an optimistic edit reconciling with the
 * sync echo) can persist a broken chain: two siblings sharing one
 * `prevSiblingId` (a "fan"), or a pointer to a node that is no longer a sibling
 * (a "dangle"). buildTreeIndex tolerates that by appending the unreachable nodes
 * as orphans, BUT a contiguous orphan block can no longer be reordered -- both
 * keyboard moves and drag relink within the block without ever re-threading it
 * into the head chain, so every move is a silent no-op (and survives refresh,
 * since the broken pointers are persisted).
 *
 * The repair: adopt the exact order buildTreeIndex already renders as canonical,
 * and rewrite only the `prevSiblingId` pointers that disagree with it. Nothing
 * visibly reorders -- the orphaned nodes simply become movable again. It's
 * idempotent: clean data yields zero fixes, so it auto-corrects any future
 * corruption on the next snapshot and is a no-op forever after.
 *
 * Returns the minimal set of pointer corrections.
 */
export function siblingChainRepairs(
  nodes: Node[],
): Array<{ id: string; prevSiblingId: string | null }> {
  const index = buildTreeIndex(nodes)
  const fixes: Array<{ id: string; prevSiblingId: string | null }> = []
  // childrenByParent holds ordered child *ids* now; map them back to the rows
  // chainDisagreements compares (the ids are canonical-order by construction).
  for (const ids of index.childrenByParent.values()) {
    const ordered = ids
      .map((id) => index.byId.get(id))
      .filter((n): n is Node => n != null)
    for (const d of chainDisagreements(ordered)) {
      fixes.push({ id: d.id, prevSiblingId: d.expectedPrev })
    }
  }
  return fixes
}

/** Apply sibling-chain repairs as one optimistic transaction (so the Worker
 *  persists them in a single round trip and the socket echoes them back). Runs
 *  in a microtask, after the snapshot commit has settled, and never throws into
 *  the sync path. */
function healSiblingChains(nodes: Node[]): void {
  let fixes: ReturnType<typeof siblingChainRepairs>
  try {
    fixes = siblingChainRepairs(nodes)
  } catch {
    return
  }
  if (fixes.length === 0) return
  queueMicrotask(() => {
    try {
      for (const fix of fixes) {
        nodesCollection.update(fix.id, (draft) => {
          draft.prevSiblingId = fix.prevSiblingId
          draft.updatedAt = now()
        })
      }
    } catch {
      // A node may have been deleted between snapshot and microtask; a failed
      // heal is harmless -- the next snapshot retries.
    }
  })
}

/**
 * Rescue nodes stranded UNDER a mirror instance (ADR 0022). A mirror windows its
 * SOURCE's children, so a node whose `parentId` points at a mirror instance
 * (`parent.mirrorOf != null`) is orphaned -- the render walk reads the source's
 * children, never the instance's, so the node is invisible (the "disappears on
 * Tab" bug, before keyboard indent learned to resolve the mirror boundary the
 * drag path already did). Repoint each such node at the true source, appended
 * after the source's current real children, so it reappears in every instance;
 * runs alongside `healSiblingChains` at snapshot load and persists the same way.
 *
 * Gated on the mirrors flag ON PURPOSE: with mirrors OFF, a node carrying
 * `mirrorOf` renders as a plain node with its OWN children, so a child parented
 * to it is legitimately placed and must NOT be moved. Early-returns on any
 * flag-off / mirror-free / orphan-free outline (the mirrorOf lookups all miss).
 */
function healMirrorOrphans(nodes: Node[]): void {
  if (!isMirrorsEnabled()) return
  const byId = new Map<string, Node>()
  for (const n of nodes) byId.set(n.id, n)

  // Group orphans by their true source. `parent.mirrorOf` is already the true
  // source (mirror-of-mirror is flattened at creation -- ADR 0022), so there's
  // no chain to resolve here.
  const orphansBySource = new Map<string, string[]>()
  for (const n of nodes) {
    if (n.parentId == null) continue
    const source = byId.get(n.parentId)?.mirrorOf
    if (!source) continue
    const list = orphansBySource.get(source)
    if (list) list.push(n.id)
    else orphansBySource.set(source, [n.id])
  }
  if (orphansBySource.size === 0) return

  // Thread each rescued run after the source's current LAST real child (its own
  // children hang off the source id, so the orphans -- bucketed under the mirror
  // instance id -- are excluded from this read). Keeps the orphans' snapshot
  // order among themselves.
  const index = buildTreeIndex(nodes)
  const fixes: { id: string; parentId: string; prevSiblingId: string | null }[] = []
  for (const [source, orphanIds] of orphansBySource) {
    const existing = childrenOf(index, source)
    let prev: string | null =
      existing.length > 0 ? existing[existing.length - 1]!.id : null
    for (const id of orphanIds) {
      fixes.push({ id, parentId: source, prevSiblingId: prev })
      prev = id
    }
  }

  queueMicrotask(() => {
    try {
      for (const fix of fixes) {
        nodesCollection.update(fix.id, (draft) => {
          draft.parentId = fix.parentId
          draft.prevSiblingId = fix.prevSiblingId
          draft.updatedAt = now()
        })
      }
    } catch {
      // A node may have been deleted between snapshot and microtask; harmless --
      // the next snapshot retries.
    }
  })
}

/**
 * Backfill nullable-required fields added after some rows were persisted (ADR
 * 0022's `mirrorOf`, and node `origin`). The per-user DO adds each column with a
 * NULL default in its migrator, so a healthy DO always sends them; this guards
 * the brief pre-migration window and any mock/snapshot that predates the field
 * (e.g. the e2e Worker mock). Done inline rather than via the post-commit
 * sibling-chain heal because the value must be present BEFORE the schema-typed
 * collection write (both fields are required, no default — ADR 0003), and it
 * allocates a new object only when something is actually absent (the never-taken
 * branch once every DO has migrated). */
function withNodeDefaults(n: Node): Node {
  // The wire/DO type says these are always present, so read them through a loose
  // cast: a row persisted before a field existed (or the e2e mock) may omit it
  // at runtime even though the type can't express that.
  const loose = n as { mirrorOf?: unknown; origin?: unknown }
  if (loose.mirrorOf !== undefined && loose.origin !== undefined) return n
  return {
    ...n,
    mirrorOf: loose.mirrorOf === undefined ? null : n.mirrorOf,
    origin: loose.origin === undefined ? null : n.origin,
  }
}

export const nodesCollection = createCollection({
  id: 'nodes',
  getKey: (node: Node) => node.id,
  schema: Schema.toStandardSchemaV1(nodeSchema),
  sync: {
    // Updates carry only changed fields (a PATCH) OR a full row (an upsert);
    // partial merges both correctly.
    rowUpdateMode: 'partial',
    sync: ({ begin, write, commit, markReady, truncate, metadata }) => {
      // SPA / no-SSR: never open a socket during the `/` prerender. Mark ready so
      // any defensive server-side read resolves empty instead of hanging.
      if (typeof window === 'undefined') {
        markReady()
        return () => {}
      }

      let ready = false
      const ensureReady = () => {
        if (ready) return
        ready = true
        markReady()
        // Release the shell's loading spinner (module signal, see markSyncReady).
        markSyncReady()
      }
      const getCursor = (): number | null =>
        (metadata?.collection.get('cursor') as number | undefined) ?? null

      const applyOps = (ops: readonly ChangeOp[], seq: number): void => {
        begin()
        for (const op of ops) {
          if (op.op === 'delete') {
            write({ type: 'delete', key: op.key })
            echoedText.delete(op.key)
          } else {
            write({ type: op.op, value: withNodeDefaults(op.value) })
            echoedText.set(op.value.id, op.value.text)
          }
        }
        metadata?.collection.set('cursor', seq)
        commit()
        // Release any runStructural transaction awaiting its own echo (P2).
        advanceAppliedSeq(seq)
      }

      // Apply one decoded server frame. Unchanged from the old onMessage body —
      // it just runs on the sync fiber now (driven by Stream.runForEach below).
      const applyMessage = (msg: ServerMessage): void => {
        if (msg.type === 'snapshot') {
          // Replace the whole collection: truncate, then write the full set.
          // Idempotent on first connect (empty) and on a resync past the
          // changelog window. The cursor survives truncate (separate store).
          begin()
          truncate()
          for (const n of msg.nodes) write({ type: 'insert', value: withNodeDefaults(n) })
          metadata?.collection.set('cursor', msg.seq)
          commit()
          // A fresh snapshot supersedes every earlier seq (and may be the
          // resolution a runStructural transaction is waiting on after a
          // reconnect or a same-page account switch), so reset the cursor to
          // it — even if it's LOWER than what a prior outline left behind.
          resetAppliedSeq(msg.seq)
          initialError = null
          ensureReady()
          // Self-heal any persisted sibling-chain corruption now that the full
          // outline is in hand (deferred so it writes outside this commit).
          // Copy: msg.nodes is a readonly wire array; the heal path wants Node[].
          healSiblingChains(msg.nodes.slice())
          // Rescue any node stranded under a mirror instance (ADR 0022 boundary
          // gap). Queued AFTER the chain heal so its parentId+prevSiblingId write
          // wins on the rescued node if both touch it.
          healMirrorOrphans(msg.nodes.slice())
        } else if (msg.type === 'resume') {
          // The gap since our cursor. Empty = already current; the cursor is
          // unchanged so there's nothing to write.
          for (const frame of msg.changes) applyOps(frame.ops, frame.seq)
          initialError = null
          ensureReady()
        } else {
          // A live change broadcast from this or another device.
          applyOps(msg.ops, msg.seq)
        }
      }

      // Allocate the producer synchronously (state only, no services), so the
      // resync bridge is wired before sync() returns; then fork the consuming
      // fiber onto the app runtime. The fiber drains the event stream for the
      // session; the cleanup interrupts it, which closes the WebSocket via the
      // socket's scope finalizer.
      const { events, resync } = Effect.runSync(
        makeSyncStream(Effect.sync(getCursor)),
      )
      resyncFn = () => {
        appRuntime.runFork(resync)
      }

      const fiber = appRuntime.runFork(
        Stream.runForEach(events, (event: SyncEvent) =>
          Effect.sync(() => {
            if (event._tag === 'InitialError') {
              initialError = event.error
              ensureReady()
            } else {
              applyMessage(event.message)
            }
          }),
        ),
      )

      return () => {
        resyncFn = null
        appRuntime.runFork(Fiber.interrupt(fiber))
      }
    },
  },
  onInsert: async ({ transaction }) => {
    await createNodes(transaction.mutations.map((m) => m.modified as Node))
    return { refetch: false }
  },
  onUpdate: async ({ transaction }) => {
    await updateNodes(
      transaction.mutations.map((m) => ({
        id: m.key as string,
        changes: m.changes as Partial<Node>,
      })),
    )
    return { refetch: false }
  },
  onDelete: async ({ transaction }) => {
    await deleteNodes(transaction.mutations.map((m) => m.key as string))
    return { refetch: false }
  },
})
