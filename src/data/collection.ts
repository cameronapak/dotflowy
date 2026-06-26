import { createCollection } from '@tanstack/react-db'
import { nodeSchema } from './schema'
import type { Node } from './schema'
import { createNodes, deleteNodes, updateNodes } from './api'
import { connectSyncSocket } from './realtime'
import type { ChangeOp, ServerMessage } from './realtime'

/**
 * Single source of truth for all outline nodes.
 *
 * Backed by a per-user Durable Object over a real-time WebSocket (realtime.ts ->
 * /api/sync). This is a TanStack DB *custom sync* collection: on connect the DO
 * streams a `snapshot` (the full outline), then every edit on any of the user's
 * devices arrives as a `change` delta and is applied live -- no window-focus
 * refetch. A reconnect resumes from the last applied seq (or falls back to a
 * fresh snapshot). Why a DO + WebSocket: docs/DECISIONS.md (per-user DO sync).
 *
 * The WRITE path is unchanged: optimistic mutations still POST/PATCH/DELETE
 * /api/nodes, each handler returning `{ refetch: false }` (the socket echoes the
 * persisted change back, which reconciles idempotently -- no need to skip the
 * originator). A transaction can carry several mutations (a structural move
 * relinks multiple siblings), so every handler maps over `transaction.mutations`
 * rather than reading `[0]`; the Worker batches them into one DO round trip.
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

/** Force the outline to reconcile against server truth now (a fresh snapshot).
 *  Used by the daily plugin's claim loser-path; a no-op before the socket
 *  connects (or during the `/` prerender). */
let resyncFn: (() => void) | null = null
export function resyncNodes(): void {
  resyncFn?.()
}

/** Resolve once `id` is present in the collection (live delta or snapshot).
 *  Used by the daily claim loser-path so navigation doesn't zoom to a node
 *  that hasn't replicated locally yet. */
export function waitForNode(id: string, timeoutMs = 8000): Promise<void> {
  if (nodesCollection.toArray.some((n) => n.id === id)) return Promise.resolve()

  return new Promise((resolve, reject) => {
    let sub: ReturnType<typeof nodesCollection.subscribeChanges>
    const timer = setTimeout(() => {
      sub.unsubscribe()
      reject(new Error(`node ${id} not synced within ${timeoutMs}ms`))
    }, timeoutMs)

    sub = nodesCollection.subscribeChanges(() => {
      if (!nodesCollection.toArray.some((n) => n.id === id)) return
      clearTimeout(timer)
      sub.unsubscribe()
      resolve()
    })

    if (nodesCollection.toArray.some((n) => n.id === id)) {
      clearTimeout(timer)
      sub.unsubscribe()
      resolve()
    }
  })
}

export const nodesCollection = createCollection({
  id: 'nodes',
  getKey: (node: Node) => node.id,
  schema: nodeSchema,
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
      }
      const getCursor = (): number | null =>
        (metadata?.collection.get('cursor') as number | undefined) ?? null

      const applyOps = (ops: ChangeOp[], seq: number): void => {
        begin()
        for (const op of ops) {
          if (op.op === 'delete') write({ type: 'delete', key: op.key })
          else write({ type: op.op, value: op.value })
        }
        metadata?.collection.set('cursor', seq)
        commit()
      }

      const socket = connectSyncSocket({
        getCursor,
        onInitialError: (err) => {
          initialError = err
          ensureReady()
        },
        onMessage: (msg: ServerMessage) => {
          if (msg.type === 'snapshot') {
            // Replace the whole collection: truncate, then write the full set.
            // Idempotent on first connect (empty) and on a resync past the
            // changelog window. The cursor survives truncate (separate store).
            begin()
            truncate()
            for (const n of msg.nodes) write({ type: 'insert', value: n })
            metadata?.collection.set('cursor', msg.seq)
            commit()
            initialError = null
            ensureReady()
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
        },
      })
      resyncFn = socket.resync

      return () => {
        resyncFn = null
        socket.close()
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
