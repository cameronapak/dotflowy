/**
 * Server-side outline planning: pure functions that turn a node snapshot into
 * the atomic `ChangeOp` batch a mutation needs — the Worker-side twin of the
 * client's `src/data/mutations.ts`, for callers that aren't a browser (the MCP
 * tools). Each planner mirrors its client counterpart's sibling-chain wiring
 * exactly (insert repoints the follower, delete cascades and relinks, mirrors
 * flatten to the true source and refuse cycles), and every write the Worker
 * derives from a plan lands through the DO's `applyBatch` as ONE frame (ADR
 * 0009) — same rules, different entry point.
 *
 * Pure on purpose (ADR 0021): ids and timestamps come in as arguments, the
 * snapshot comes in as a `TreeIndex`, and failures are value-shaped
 * `Data.TaggedError`s (the `bootstrapOutline` pattern) so `bun test` can cover
 * the chain surgery without a DO or a clock. Tree semantics are IMPORTED from
 * `src/data/tree.ts` — the same index, ordering, and mirror helpers the client
 * uses — so the two sides can't drift.
 */

import { Data } from 'effect'
import {
  type TreeIndex,
  buildTreeIndex,
  buildTrail,
  childrenOf,
  makeNode,
  orphanedMirrorsBy,
  trueSourceOf,
  wouldMirrorCycle,
} from '../src/data/tree'
import type { ChangeOp, Node } from '../src/data/wire-schema'

export { buildTreeIndex, trueSourceOf }
export type { TreeIndex }

// --- Typed failures (value-shaped, Effect-failable) ---------------------------

/** The referenced node id isn't in the snapshot. */
export class NodeNotFound extends Data.TaggedError('NodeNotFound')<{ nodeId: string }> {
  get message() {
    return `node not found: ${this.nodeId}`
  }
}

/** Mirroring here would window a subtree that contains the mirror (ADR 0022). */
export class MirrorCycle extends Data.TaggedError('MirrorCycle')<{ sourceId: string }> {
  get message() {
    return `mirroring ${this.sourceId} here would create a cycle`
  }
}

/** Deleting this subtree would strand mirrors whose source dies with it —
 *  blocked until promote-on-delete ships (ADR 0022 v1 protects). */
export class WouldOrphanMirrors extends Data.TaggedError('WouldOrphanMirrors')<{
  mirrorIds: ReadonlyArray<string>
}> {
  get message() {
    return `deleting this would orphan ${this.mirrorIds.length} mirror(s); delete the mirrors first`
  }
}

/** A move whose destination sits inside one of the moved subtrees (or is a
 *  moved node itself) — it would detach the branch into its own descendants
 *  (ADR 0027 / ADR 0010). */
export class WouldCycle extends Data.TaggedError('WouldCycle')<{
  nodeId: string
  parentId: string
}> {
  get message() {
    return `moving node ${this.nodeId} under ${this.parentId} would put it inside its own subtree`
  }
}

/** Two nodes in one move where one is already inside the other: the descendant
 *  travels with its ancestor, so listing both is ambiguous (ADR 0027). */
export class RedundantDescendant extends Data.TaggedError('RedundantDescendant')<{
  nodeId: string
  ancestorId: string
}> {
  get message() {
    return `node ${this.nodeId} is already inside node ${this.ancestorId}, which you're also moving — move one, not both`
  }
}

/** A batch-insert forest with more nodes than one atomic frame may carry
 *  (ADR 0028). One `applyBatch` is one DO `transactionSync`; the cap keeps an
 *  agent from dropping thousands of rows in a single frame. */
export class BatchTooLarge extends Data.TaggedError('BatchTooLarge')<{ count: number; max: number }> {
  get message() {
    return `too many nodes: ${this.count} exceeds the ${this.max}-node batch limit — split into smaller add_subtree calls`
  }
}

/** `add_subtree` was handed no nodes — nothing to create (ADR 0028). */
export class EmptyForest extends Data.TaggedError('EmptyForest')<Record<never, never>> {
  get message() {
    return 'nothing to add — pass at least one node'
  }
}

// --- Node construction --------------------------------------------------------

/** A complete wire node with caller-supplied identity + clock. `makeNode` owns
 *  the defaults; the explicit timestamps override its `Date.now()` reads. */
function newNode(args: {
  id: string
  parentId: string | null
  prevSiblingId: string | null
  text: string
  isTask?: boolean
  mirrorOf?: string | null
  /** Provenance: the agent harness that created this node, or null/omitted for
   *  structural scaffolding the DO would create either way (the daily container
   *  and day nodes stay null — they aren't the agent's content contribution). */
  origin?: string | null
  timestamp: number
}): Node {
  return makeNode({
    id: args.id,
    parentId: args.parentId,
    prevSiblingId: args.prevSiblingId,
    text: args.text,
    isTask: args.isTask ?? false,
    mirrorOf: args.mirrorOf ?? null,
    origin: args.origin ?? null,
    createdAt: args.timestamp,
    updatedAt: args.timestamp,
  })
}

function updateOp(node: Node, patch: Partial<Node>, timestamp: number): ChangeOp {
  return { op: 'update', value: { ...node, ...patch, updatedAt: timestamp } }
}

// --- Write planners -----------------------------------------------------------

/**
 * Insert a fresh node under `parentId` (null = top level). A mirror parent
 * redirects to its true source — children always hang off the content node
 * (ADR 0022). `position: 'last'` appends (no repoint); `'first'` pushes the
 * current head down (one repoint), mirroring `insertChildAtStart`.
 */
export function planAddNode(
  index: TreeIndex,
  args: {
    id: string
    text: string
    parentId: string | null
    position: 'first' | 'last'
    isTask: boolean
    origin?: string | null
    timestamp: number
  },
): { ops: ChangeOp[]; nodeId: string; parentId: string | null } | NodeNotFound {
  let parentId: string | null = null
  if (args.parentId !== null) {
    if (!index.byId.has(args.parentId)) return new NodeNotFound({ nodeId: args.parentId })
    parentId = trueSourceOf(index, args.parentId)
  }

  const siblings = childrenOf(index, parentId)
  const ops: ChangeOp[] = []
  if (args.position === 'first') {
    const head = siblings[0]
    ops.push({
      op: 'insert',
      value: newNode({ ...args, parentId, prevSiblingId: null }),
    })
    if (head) ops.push(updateOp(head, { prevSiblingId: args.id }, args.timestamp))
  } else {
    const last = siblings.length ? siblings[siblings.length - 1]! : null
    ops.push({
      op: 'insert',
      value: newNode({ ...args, parentId, prevSiblingId: last ? last.id : null }),
    })
  }
  return { ops, nodeId: args.id, parentId }
}

/** The field changes a tool may apply to a node. */
export interface NodeFieldChanges {
  text?: string
  isTask?: boolean
  completed?: boolean
  collapsed?: boolean
}

/**
 * Patch a node's fields. Content fields (`text`, `isTask`, `completed`) follow
 * the mirror's TRUE SOURCE — editing an instance edits the content everywhere
 * (ADR 0022's field split); `collapsed` stays on the instance (position-local).
 * Emits one op per touched node (usually one; two when a mirror's content and
 * local fields change in the same call).
 */
export function planUpdateNode(
  index: TreeIndex,
  args: { nodeId: string; changes: NodeFieldChanges; timestamp: number },
): { ops: ChangeOp[]; touchedIds: string[] } | NodeNotFound {
  const node = index.byId.get(args.nodeId)
  if (!node) return new NodeNotFound({ nodeId: args.nodeId })

  const contentId = trueSourceOf(index, args.nodeId)
  // The wire Node's fields are readonly; the patch under construction needs a
  // mutable twin.
  type NodePatch = { -readonly [K in keyof Node]?: Node[K] }
  const patches = new Map<string, NodePatch>()
  const patchFor = (id: string): NodePatch => {
    const existing = patches.get(id)
    if (existing) return existing
    const fresh: NodePatch = {}
    patches.set(id, fresh)
    return fresh
  }

  const { changes } = args
  if (changes.text !== undefined) patchFor(contentId).text = changes.text
  if (changes.isTask !== undefined) patchFor(contentId).isTask = changes.isTask
  if (changes.completed !== undefined) patchFor(contentId).completed = changes.completed
  if (changes.collapsed !== undefined) patchFor(args.nodeId).collapsed = changes.collapsed

  const ops: ChangeOp[] = []
  const touchedIds: string[] = []
  for (const [id, patch] of patches) {
    const target = index.byId.get(id)
    if (!target) return new NodeNotFound({ nodeId: id })
    ops.push(updateOp(target, patch, args.timestamp))
    touchedIds.push(id)
  }
  return { ops, touchedIds }
}

/**
 * Delete a node and its whole subtree (the client's `removeNode` cascade),
 * relinking the follower sibling to the deleted node's predecessor. Refuses a
 * delete that would orphan mirrors of anything inside the subtree (ADR 0022
 * v1: protect, not promote). Deleting a mirror itself is always safe — its
 * "children" belong to the source and don't cascade.
 */
export function planDeleteNode(
  index: TreeIndex,
  nodeId: string,
  timestamp: number,
): { ops: ChangeOp[]; deletedIds: string[] } | NodeNotFound | WouldOrphanMirrors {
  const node = index.byId.get(nodeId)
  if (!node) return new NodeNotFound({ nodeId })

  const orphans = orphanedMirrorsBy(index, [nodeId])
  if (orphans.length) return new WouldOrphanMirrors({ mirrorIds: orphans })

  const deletedIds: string[] = []
  const stack = [nodeId]
  while (stack.length) {
    const id = stack.pop()!
    deletedIds.push(id)
    for (const child of childrenOf(index, id)) stack.push(child.id)
  }

  const ops: ChangeOp[] = []
  const siblings = childrenOf(index, node.parentId)
  const i = siblings.findIndex((n) => n.id === nodeId)
  if (i !== -1 && i + 1 < siblings.length) {
    const next = siblings[i + 1]!
    ops.push(updateOp(next, { prevSiblingId: node.prevSiblingId }, timestamp))
  }
  for (const id of deletedIds) ops.push({ op: 'delete', key: id })
  return { ops, deletedIds }
}

/**
 * Create a mirror of `sourceId` as the last child of `targetParentId` (null =
 * top level) — the client's `mirrorNode` semantics: flatten to the TRUE source
 * (never mirror a mirror) and refuse a cycle (mirroring a node into its own
 * subtree). The mirror's text is a display snapshot; live reads resolve the
 * source (ADR 0022).
 */
export function planMirrorNode(
  index: TreeIndex,
  args: {
    sourceId: string
    targetParentId: string | null
    id: string
    origin?: string | null
    timestamp: number
  },
): { ops: ChangeOp[]; nodeId: string; sourceId: string } | NodeNotFound | MirrorCycle {
  const source = index.byId.get(args.sourceId)
  if (!source) return new NodeNotFound({ nodeId: args.sourceId })

  let parentId: string | null = null
  if (args.targetParentId !== null) {
    if (!index.byId.has(args.targetParentId)) {
      return new NodeNotFound({ nodeId: args.targetParentId })
    }
    parentId = trueSourceOf(index, args.targetParentId)
  }

  const trueSourceId = trueSourceOf(index, args.sourceId)
  if (wouldMirrorCycle(index, trueSourceId, parentId)) {
    return new MirrorCycle({ sourceId: trueSourceId })
  }

  const siblings = childrenOf(index, parentId)
  const last = siblings.length ? siblings[siblings.length - 1]! : null
  const ops: ChangeOp[] = [
    {
      op: 'insert',
      value: newNode({
        id: args.id,
        parentId,
        prevSiblingId: last ? last.id : null,
        text: index.byId.get(trueSourceId)?.text ?? '',
        mirrorOf: trueSourceId,
        origin: args.origin,
        timestamp: args.timestamp,
      }),
    },
  ]
  return { ops, nodeId: args.id, sourceId: trueSourceId }
}

// --- Move planning ------------------------------------------------------------

/** Whether `maybeAncestorId` is `nodeId` itself or one of its ancestors. Pure
 *  upward walk, guarded against a corrupted parent chain. */
function isSelfOrAncestor(index: TreeIndex, nodeId: string, maybeAncestorId: string): boolean {
  let cursor: string | null = nodeId
  let guard = index.byId.size + 1
  while (cursor && guard-- > 0) {
    if (cursor === maybeAncestorId) return true
    cursor = index.byId.get(cursor)?.parentId ?? null
  }
  return false
}

/** A node whose readonly wire fields can be reassigned while we replay a move. */
type MutNode = { -readonly [K in keyof Node]: Node[K] }

/**
 * `moveNode`'s sibling-chain surgery (client mutations.ts), applied to a
 * working-copy map instead of the live collection: reads come from `idx`
 * (rebuilt from the working copy before each call), writes mutate `working`.
 * Same guards as the client (can't land after self, become own parent, or move
 * to the exact spot it already holds — the last would corrupt the follower
 * repoint). Never adds or removes an entry, only relinks `parentId`/
 * `prevSiblingId`.
 */
function applyMoveInPlace(
  working: Map<string, MutNode>,
  idx: TreeIndex,
  nodeId: string,
  newParentId: string | null,
  afterSiblingId: string | null,
): void {
  const node = idx.byId.get(nodeId)
  if (!node) return
  if (afterSiblingId === nodeId || newParentId === nodeId) return
  if (
    newParentId === node.parentId &&
    (afterSiblingId ?? null) === (node.prevSiblingId ?? null)
  ) {
    return
  }

  const oldSiblings = childrenOf(idx, node.parentId)
  const oi = oldSiblings.findIndex((n) => n.id === nodeId)
  const oldNext = oi !== -1 && oi + 1 < oldSiblings.length ? oldSiblings[oi + 1]! : null

  const newSiblings = childrenOf(idx, newParentId)
  let newNext: Node | null = null
  if (afterSiblingId === null) {
    newNext = newSiblings[0] ?? null
  } else {
    const ni = newSiblings.findIndex((n) => n.id === afterSiblingId)
    newNext = ni !== -1 && ni + 1 < newSiblings.length ? newSiblings[ni + 1]! : null
  }

  if (oldNext) working.get(oldNext.id)!.prevSiblingId = node.prevSiblingId
  const w = working.get(nodeId)!
  w.parentId = newParentId
  w.prevSiblingId = afterSiblingId
  if (newNext && newNext.id !== nodeId) working.get(newNext.id)!.prevSiblingId = nodeId
}

/**
 * Move existing nodes (each with its whole subtree) to become children of
 * `newParentId` (null = top level), preserving the given order — the pure twin
 * of the client's `moveManyNodes` (mutations.ts). It replays `moveNode`'s chain
 * surgery on a working copy, rebuilding the index between moves so a run of
 * mutual siblings can't tear the chain, then diffs the copy to emit the touched
 * `parentId`/`prevSiblingId` updates.
 *
 * STRUCTURAL ONLY (ADR 0027): the plan is exclusively `update` ops — never an
 * insert or delete — so ids, subtrees, `origin` provenance, mirrors, and every
 * other field ride through untouched. A move reorganizes; it never recreates.
 * A mirror `newParentId` redirects to its true source (children hang off the
 * content node, ADR 0022), matching planAddNode/planMirrorNode.
 *
 * Validation is atomic all-or-nothing: a missing node, a missing parent, a
 * destination inside a moved subtree (WouldCycle), or a node listed alongside
 * its own moved ancestor (RedundantDescendant) fails the WHOLE call.
 */
export function planReparent(
  index: TreeIndex,
  args: {
    nodeIds: readonly string[]
    newParentId: string | null
    position: 'first' | 'last'
    timestamp: number
  },
):
  | { ops: ChangeOp[]; movedIds: string[]; parentId: string | null }
  | NodeNotFound
  | WouldCycle
  | RedundantDescendant {
  // A literal duplicate id is benign — dedup, keeping first-seen order.
  const nodeIds = [...new Set(args.nodeIds)]

  // 1. Every moved node must exist.
  for (const id of nodeIds) {
    if (!index.byId.has(id)) return new NodeNotFound({ nodeId: id })
  }

  // 2. The destination must exist; a mirror parent redirects to its true source
  //    so children hang off the content node (ADR 0022).
  let parentId: string | null = null
  if (args.newParentId !== null) {
    if (!index.byId.has(args.newParentId)) return new NodeNotFound({ nodeId: args.newParentId })
    parentId = trueSourceOf(index, args.newParentId)
  }

  // 3. No node may land inside its own subtree (self or descendant) — checked
  //    against the resolved parent, where the node actually lands.
  if (parentId !== null) {
    for (const id of nodeIds) {
      if (isSelfOrAncestor(index, parentId, id)) {
        return new WouldCycle({ nodeId: id, parentId })
      }
    }
  }

  // 4. No node may be listed alongside an ancestor also being moved.
  const moving = new Set(nodeIds)
  for (const id of nodeIds) {
    let cursor = index.byId.get(id)!.parentId
    let guard = index.byId.size + 1
    while (cursor && guard-- > 0) {
      if (moving.has(cursor)) return new RedundantDescendant({ nodeId: id, ancestorId: cursor })
      cursor = index.byId.get(cursor)?.parentId ?? null
    }
  }

  // Replay the moves on a mutable clone, rebuilding the index between each so
  // reads reflect prior moves (the rebuild-between-moves guard moveManyNodes
  // needs when the moved nodes are siblings of one another).
  const working = new Map<string, MutNode>()
  for (const [id, n] of index.byId) working.set(id, { ...n })

  // 'last': chain after the target's current last child. 'first': chain from the
  // head (after = null), each move landing after the previously-moved node, so
  // the run keeps its order at the front and pushes existing children down.
  let after: string | null = null
  if (args.position === 'last') {
    const kids = childrenOf(index, parentId)
    after = kids.length ? kids[kids.length - 1]!.id : null
  }

  for (const id of nodeIds) {
    const idx = buildTreeIndex([...working.values()] as Node[])
    applyMoveInPlace(working, idx, id, parentId, after)
    after = id
  }

  // Diff: one update per node whose parent or predecessor actually changed.
  const ops: ChangeOp[] = []
  for (const [id, w] of working) {
    const orig = index.byId.get(id)!
    if (w.parentId !== orig.parentId || w.prevSiblingId !== orig.prevSiblingId) {
      ops.push({ op: 'update', value: { ...w, updatedAt: args.timestamp } })
    }
  }
  return { ops, movedIds: nodeIds, parentId }
}

// --- Subtree (batch insert) planning ------------------------------------------

/** A node to create in a batch, with its own nested children — the recursive
 *  shape the `add_subtree` tool accepts. Fresh content only: no id (the caller
 *  mints them), no mirror, no completed/collapsed state (ADR 0028). */
export interface SubtreeInput {
  text: string
  isTask?: boolean | null
  children?: readonly SubtreeInput[] | null
}

/** Total node count of a forest (roots + every descendant), for the size cap. */
function countForest(nodes: readonly SubtreeInput[]): number {
  let n = 0
  const stack: SubtreeInput[] = [...nodes]
  while (stack.length) {
    const node = stack.pop()!
    n++
    if (node.children) stack.push(...node.children)
  }
  return n
}

/**
 * Emit a forest depth-first under `parentId`, chaining each node's
 * `prevSiblingId` to the previously-emitted sibling AT ITS LEVEL. The first root
 * chains from `firstPrev` (the parent's existing anchor sibling, or null).
 *
 * CORRECT BY CONSTRUCTION (ADR 0028): the wiring reads NOTHING from the tree
 * index — the caller handed us the whole shape, so sibling order comes from the
 * emission order, not from `childrenOf`. This is why the batch tool does NOT
 * loop `planAddNode` (which re-reads the stale last-sibling each call and would
 * give every new root the same predecessor, tearing the chain).
 */
function emitForest(
  nodes: readonly SubtreeInput[],
  parentId: string | null,
  firstPrev: string | null,
  origin: string | null | undefined,
  timestamp: number,
  newId: () => string,
): { ops: ChangeOp[]; rootIds: string[] } {
  const ops: ChangeOp[] = []
  const walk = (siblings: readonly SubtreeInput[], parent: string | null, initialPrev: string | null): string[] => {
    const ids: string[] = []
    let prev = initialPrev
    for (const input of siblings) {
      const id = newId()
      ops.push({
        op: 'insert',
        value: newNode({
          id,
          parentId: parent,
          prevSiblingId: prev,
          text: input.text,
          isTask: input.isTask ?? false,
          origin,
          timestamp,
        }),
      })
      ids.push(id)
      if (input.children && input.children.length) walk(input.children, id, null)
      prev = id
    }
    return ids
  }
  return { ops, rootIds: walk(nodes, parentId, firstPrev) }
}

/**
 * Insert a whole nested forest under `parentId` (null = top level) in ONE batch
 * — the batch twin of `planAddNode`. Interior links are wired by construction
 * (`emitForest`); only the top-level run reads the parent's existing children to
 * anchor, reusing `planAddNode`'s first/last rule: `last` chains the run after
 * the current last child; `first` puts it at the head and repoints the old head
 * to the run's LAST root. A mirror parent redirects to its true source (ADR
 * 0022). Fails the whole call on an empty forest, an over-cap payload, or a
 * missing parent — all-or-nothing, matching the one-frame model (ADR 0009).
 */
export function planAddSubtree(
  index: TreeIndex,
  args: {
    nodes: readonly SubtreeInput[]
    parentId: string | null
    position: 'first' | 'last'
    origin?: string | null
    timestamp: number
    newId: () => string
    maxNodes: number
  },
): { ops: ChangeOp[]; rootIds: string[]; parentId: string | null } | NodeNotFound | EmptyForest | BatchTooLarge {
  const count = countForest(args.nodes)
  if (count === 0) return new EmptyForest()
  if (count > args.maxNodes) return new BatchTooLarge({ count, max: args.maxNodes })

  let parentId: string | null = null
  if (args.parentId !== null) {
    if (!index.byId.has(args.parentId)) return new NodeNotFound({ nodeId: args.parentId })
    parentId = trueSourceOf(index, args.parentId)
  }

  const siblings = childrenOf(index, parentId)
  const head = args.position === 'first' ? (siblings[0] ?? null) : null
  const firstPrev =
    args.position === 'first' ? null : siblings.length ? siblings[siblings.length - 1]!.id : null

  const { ops, rootIds } = emitForest(
    args.nodes,
    parentId,
    firstPrev,
    args.origin,
    args.timestamp,
    args.newId,
  )
  if (head) {
    ops.push(updateOp(head, { prevSiblingId: rootIds[rootIds.length - 1]! }, args.timestamp))
  }
  return { ops, rootIds, parentId }
}

// --- Daily-note planning ------------------------------------------------------
// The daily plugin's identity model, server-side: the `daily-index` kv
// side-collection maps `container` -> the "Daily" container node and a local
// `YYYY-MM-DD` key -> that day's note. The MCP handler CLAIMS both ids through
// the DO's atomic `getOrCreateKv` first (same race-killer the client uses —
// daily-index.ts `claimMapping`), then this planner materializes whichever node
// rows are missing: container appended at the end of the top level, day
// inserted as the container's FIRST child (newest on top), both exactly like
// the client's ensureContainer/ensureDay.

/** Canonical container text — keep in sync with the daily plugin's
 *  `DAILY_CONTAINER_TEXT` (cosmetic; identity is the kv mapping). */
export const DAILY_CONTAINER_TEXT = 'Daily'

/** `YYYY-MM-DD`, the daily index's key shape. */
export const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/** The full human date a day node's text seeds to ("Friday, July 3, 2026") —
 *  the client's `formatDayText`, minus the locale dependence (the Worker has no
 *  user locale; fixed English matches the app's chrome). */
export function formatDayText(dateKey: string): string {
  if (!isValidDateKey(dateKey)) return dateKey
  const [y, mo, d] = dateKey.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, mo - 1, d, 12))
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`
}

/**
 * Whether `dateKey` is a REAL calendar date, not merely `YYYY-MM-DD` shaped.
 * `Date.UTC` silently rolls impossible parts over ("2026-13-45" -> 2027-02-14,
 * "2026-02-31" -> 2026-03-03), so require the components to round-trip. The
 * `DATE_KEY_PATTERN` test alone lets those bogus keys through.
 */
export function isValidDateKey(dateKey: string): boolean {
  if (!DATE_KEY_PATTERN.test(dateKey)) return false
  const [y, mo, d] = dateKey.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, mo - 1, d, 12))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

/**
 * Materialize the daily container and/or day node the kv claims settled on,
 * for whichever of the two isn't in the snapshot yet. Also heals a blank
 * existing day's text (client `ensureDay` parity). Returns ops only — the
 * caller stacks its own add/mirror ops on top and commits ONE batch.
 */
export function planEnsureDaily(
  index: TreeIndex,
  args: { dateKey: string; containerId: string; dayId: string; timestamp: number },
): { ops: ChangeOp[] } {
  const ops: ChangeOp[] = []
  const containerExists = index.byId.has(args.containerId)
  if (!containerExists) {
    const tops = childrenOf(index, null)
    const last = tops.length ? tops[tops.length - 1]! : null
    ops.push({
      op: 'insert',
      value: newNode({
        id: args.containerId,
        parentId: null,
        prevSiblingId: last ? last.id : null,
        text: DAILY_CONTAINER_TEXT,
        timestamp: args.timestamp,
      }),
    })
  }

  const day = index.byId.get(args.dayId)
  if (!day) {
    const head = containerExists ? (childrenOf(index, args.containerId)[0] ?? null) : null
    ops.push({
      op: 'insert',
      value: newNode({
        id: args.dayId,
        parentId: args.containerId,
        prevSiblingId: null,
        text: formatDayText(args.dateKey),
        timestamp: args.timestamp,
      }),
    })
    if (head) ops.push(updateOp(head, { prevSiblingId: args.dayId }, args.timestamp))
  } else if (!day.text.trim()) {
    ops.push(updateOp(day, { text: formatDayText(args.dateKey) }, args.timestamp))
  }

  return { ops }
}

/** Ensure the day exists, then append a fresh node as its LAST child — one
 *  combined batch for the `add_to_today` tool. */
export function planAddToDaily(
  index: TreeIndex,
  args: {
    dateKey: string
    containerId: string
    dayId: string
    newNodeId: string
    text: string
    isTask: boolean
    origin?: string | null
    timestamp: number
  },
): { ops: ChangeOp[]; nodeId: string } {
  const { ops } = planEnsureDaily(index, args)
  // A pre-existing day may have children; a just-planned one can't.
  const siblings = index.byId.has(args.dayId) ? childrenOf(index, args.dayId) : []
  const last = siblings.length ? siblings[siblings.length - 1]! : null
  ops.push({
    op: 'insert',
    value: newNode({
      id: args.newNodeId,
      parentId: args.dayId,
      prevSiblingId: last ? last.id : null,
      text: args.text,
      isTask: args.isTask,
      origin: args.origin,
      timestamp: args.timestamp,
    }),
  })
  return { ops, nodeId: args.newNodeId }
}

/** Ensure the day exists, then append a whole nested forest as its LAST children
 *  — one combined batch for `add_subtree`'s `date` path. Always appends
 *  (position is a `parentId`-path concept); the size cap is enforced here too so
 *  the daily path can't smuggle an over-cap payload past it (ADR 0028). */
export function planAddSubtreeToDaily(
  index: TreeIndex,
  args: {
    nodes: readonly SubtreeInput[]
    dateKey: string
    containerId: string
    dayId: string
    origin?: string | null
    timestamp: number
    newId: () => string
    maxNodes: number
  },
): { ops: ChangeOp[]; rootIds: string[] } | EmptyForest | BatchTooLarge {
  const count = countForest(args.nodes)
  if (count === 0) return new EmptyForest()
  if (count > args.maxNodes) return new BatchTooLarge({ count, max: args.maxNodes })

  const { ops } = planEnsureDaily(index, args)
  // A pre-existing day may already have children; a just-planned one can't.
  const siblings = index.byId.has(args.dayId) ? childrenOf(index, args.dayId) : []
  const firstPrev = siblings.length ? siblings[siblings.length - 1]!.id : null
  const emitted = emitForest(args.nodes, args.dayId, firstPrev, args.origin, args.timestamp, args.newId)
  ops.push(...emitted.ops)
  return { ops, rootIds: emitted.rootIds }
}

/** Ensure the day exists, then mirror `sourceId` as its LAST child — one
 *  combined batch for the `mirror_to_today` tool. */
export function planMirrorToDaily(
  index: TreeIndex,
  args: {
    dateKey: string
    containerId: string
    dayId: string
    sourceId: string
    mirrorId: string
    origin?: string | null
    timestamp: number
  },
): { ops: ChangeOp[]; nodeId: string; sourceId: string } | NodeNotFound | MirrorCycle {
  const source = index.byId.get(args.sourceId)
  if (!source) return new NodeNotFound({ nodeId: args.sourceId })

  const trueSourceId = trueSourceOf(index, args.sourceId)
  // Cycle guard: the mirror lands under the day, which is (or will become) a
  // child of the container. If the day isn't in the snapshot yet, walking up
  // from its id finds nothing — so check against the container it will hang
  // under, otherwise mirroring the container onto a fresh day slips through and
  // builds a self-cycle (day under container, mirror->container under day). An
  // existing day is checked directly (also catches mirroring the day onto itself).
  const cycleParent = index.byId.has(args.dayId) ? args.dayId : args.containerId
  if (wouldMirrorCycle(index, trueSourceId, cycleParent)) {
    return new MirrorCycle({ sourceId: trueSourceId })
  }

  const { ops } = planEnsureDaily(index, args)
  const siblings = index.byId.has(args.dayId) ? childrenOf(index, args.dayId) : []
  const last = siblings.length ? siblings[siblings.length - 1]! : null
  ops.push({
    op: 'insert',
    value: newNode({
      id: args.mirrorId,
      parentId: args.dayId,
      prevSiblingId: last ? last.id : null,
      text: index.byId.get(trueSourceId)?.text ?? '',
      mirrorOf: trueSourceId,
      origin: args.origin,
      timestamp: args.timestamp,
    }),
  })
  return { ops, nodeId: args.mirrorId, sourceId: trueSourceId }
}

// --- Read planners ------------------------------------------------------------

export interface OutlineLine {
  id: string
  depth: number
  text: string
  isTask: boolean
  completed: boolean
  /** Set when this row is a mirror instance (points at its true source). */
  mirrorOf: string | null
  /** True when a mirror was not expanded because its source is already an
   *  ancestor on this path (the render walk's cycle cap, ADR 0022). */
  capped: boolean
}

/**
 * Flatten a subtree (or the whole outline for a null root) to depth-annotated
 * lines in render order. Mirrors window their source's children, with the same
 * cycle cap as the client's render walk. `maxNodes` bounds the payload for an
 * agent context window; `truncated` says the cap hit.
 */
export function flattenSubtree(
  index: TreeIndex,
  rootId: string | null,
  options: { maxDepth: number; maxNodes: number },
): { lines: OutlineLine[]; truncated: boolean } | NodeNotFound {
  if (rootId !== null && !index.byId.has(rootId)) return new NodeNotFound({ nodeId: rootId })

  const lines: OutlineLine[] = []
  let truncated = false

  const visit = (id: string, depth: number, sourcesOnPath: ReadonlySet<string>): void => {
    if (lines.length >= options.maxNodes) {
      truncated = true
      return
    }
    const node = index.byId.get(id)
    if (!node) return
    const contentId = trueSourceOf(index, id)
    const content = index.byId.get(contentId) ?? node
    const isMirror = node.mirrorOf !== null
    const capped = isMirror && sourcesOnPath.has(contentId)
    lines.push({
      id,
      depth,
      text: content.text,
      isTask: content.isTask,
      completed: content.completed,
      mirrorOf: node.mirrorOf,
      capped,
    })
    if (capped || depth + 1 > options.maxDepth) return
    const nextSources = new Set(sourcesOnPath)
    nextSources.add(contentId)
    for (const child of childrenOf(index, contentId)) {
      visit(child.id, depth + 1, nextSources)
    }
  }

  const roots = rootId === null ? childrenOf(index, null).map((n) => n.id) : [rootId]
  for (const id of roots) visit(id, 0, new Set())
  return { lines, truncated }
}

/** Render flattened lines as the agent-facing text outline. */
export function formatOutlineLines(lines: ReadonlyArray<OutlineLine>): string {
  return lines
    .map((l) => {
      const indent = '  '.repeat(l.depth)
      const check = l.isTask ? (l.completed ? '[x] ' : '[ ] ') : ''
      const meta: string[] = [`id: ${l.id}`]
      if (l.mirrorOf) meta.push(`mirror of ${l.mirrorOf}`)
      if (l.capped) meta.push('cycle capped')
      if (!l.isTask && l.completed) meta.push('completed')
      return `${indent}- ${check}${l.text || '(empty)'} (${meta.join(', ')})`
    })
    .join('\n')
}

export interface SearchHit {
  id: string
  text: string
  /** Ancestor texts from the top of the outline down to (not including) the hit. */
  path: string[]
}

/** Case-insensitive substring search over node text, capped at `limit` hits in
 *  snapshot order, each with its breadcrumb trail for orientation. */
export function searchNodes(index: TreeIndex, query: string, limit: number): SearchHit[] {
  const q = query.trim().toLowerCase()
  const hits: SearchHit[] = []
  if (!q) return hits
  for (const node of index.byId.values()) {
    if (!node.text.toLowerCase().includes(q)) continue
    hits.push({
      id: node.id,
      text: node.text,
      path: buildTrail(index, node.id)
        .slice(0, -1)
        .map((n) => n.text),
    })
    if (hits.length >= limit) break
  }
  return hits
}
