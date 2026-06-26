import { createTransaction, getActiveTransaction } from '@tanstack/react-db'
import { nodesCollection, waitForSeq } from './collection'
import { persistBatch } from './api'
import type { ChangeOp } from './realtime'
import type { Node } from './schema'
import { buildTreeIndex, childrenOf } from './tree'

/**
 * The single choke point for STRUCTURAL outline edits — any mutation that
 * relinks the `prevSiblingId` sibling chain (insert/delete a bullet, move,
 * indent/outdent, reparent, undo/redo restore). Wrapping such an edit gives it
 * two guarantees the per-type collection handlers can't (PLAN.md):
 *
 *  - **P1 (atomic):** every `nodesCollection.insert/update/delete` the body runs
 *    joins ONE transaction whose `mutationFn` ships them as a single
 *    `persistBatch` request → one DO frame → one broadcast. An insert-and-repoint
 *    can no longer tear into a POST + a PATCH that land (or fail) separately.
 *  - **P2 (hold-until-echo):** the transaction doesn't resolve until its own
 *    change frame echoes back (`waitForSeq`). Because TanStack DB holds optimistic
 *    state until the handler resolves — and a `createTransaction` op, unlike a
 *    direct `collection.update`, is dropped on completion unless its echo has
 *    landed — this keeps the readable state from ever reverting to pre-op while
 *    the write is in flight, so a fast follow-up edit always computes against a
 *    state that includes the prior one.
 *
 * `body` runs SYNCHRONOUSLY inside `tx.mutate`, so its return value (e.g. a new
 * node id to focus) is available immediately; persistence happens async after.
 *
 * FIELD edits (text, completed, collapsed, isTask, bookmark) deliberately do NOT
 * route through here: each is a single-node, single-field PATCH that is already
 * one atomic frame, and the per-keystroke text path must not await an echo.
 */
export function runStructural<T>(body: () => T): T {
  // Nesting guard: a compound flow (e.g. the daily get-or-create, which creates
  // a container then a day) may call runStructural while already inside one.
  // Join the outer transaction so the whole flow is ONE frame; never open a
  // second (which would re-tear the very thing we're fixing).
  if (getActiveTransaction()) return body()

  let result!: T
  const tx = createTransaction({
    mutationFn: async ({ transaction }) => {
      const ops = transaction.mutations.map(toChangeOp)
      // A captured-but-no-op command (e.g. indent at the top of a list) makes no
      // mutations; skip the network round-trip entirely.
      if (ops.length === 0) return
      const { seq } = await persistBatch(ops) // P1
      await waitForSeq(seq) // P2
    },
  })
  tx.mutate(() => {
    result = body()
  })
  if (import.meta.env.DEV) assertTouchedChainsClean(tx.mutations)
  return result
}

/** A PendingMutation, narrowed to the fields the batch wire format needs. */
type MutationLike = { type: string; key: unknown; modified: unknown }

/** Map an optimistic mutation to the DO's wire op. Insert/update carry the full
 *  post-mutation node (an upsert); the DO recomputes insert-vs-update itself. */
function toChangeOp(m: MutationLike): ChangeOp {
  if (m.type === 'delete') return { op: 'delete', key: String(m.key) }
  return { op: m.type as 'insert' | 'update', value: m.modified as Node }
}

/**
 * Dev-only invariant tripwire: after a structural op applies optimistically,
 * assert the sibling chains under every parent it touched are total and acyclic
 * (the canonical order buildTreeIndex renders must equal the persisted
 * `prevSiblingId` chain). A mismatch means this op produced a fan/dangle —
 * exactly the corruption the cure exists to prevent — so surface it loudly and
 * located. Scoped to the touched parents so pre-existing corruption elsewhere
 * (repaired separately by healSiblingChains) doesn't cry wolf. Zero cost in prod.
 */
function assertTouchedChainsClean(mutations: readonly MutationLike[]): void {
  try {
    const index = buildTreeIndex(nodesCollection.toArray as Node[])
    const parents = new Set<string | null>()
    for (const m of mutations) {
      const mod = m.modified as Node | undefined
      if (mod && typeof mod === 'object') parents.add(mod.parentId)
      const live = index.byId.get(String(m.key))
      if (live) parents.add(live.parentId)
    }
    for (const parentId of parents) {
      const children = childrenOf(index, parentId)
      let prev: string | null = null
      for (const child of children) {
        if ((child.prevSiblingId ?? null) !== prev) {
          console.error(
            '[structural] sibling-chain invariant broken after a structural write',
            {
              parent: parentId,
              node: child.id,
              expectedPrev: prev,
              actualPrev: child.prevSiblingId ?? null,
            },
          )
          return
        }
        prev = child.id
      }
    }
  } catch (err) {
    console.error('[structural] invariant check threw', err)
  }
}
