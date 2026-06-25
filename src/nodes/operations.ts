import { HttpError } from 'wasp/server'
import type {
  GetNodes,
  UpsertNodes,
  UpdateNodes,
  DeleteNodes,
} from 'wasp/server/operations'
import type { Node as DbNode } from 'wasp/entities'
import type { Prisma } from '@prisma/client'

/**
 * The outline sync boundary (PRD Phase 2). Ports the semantics of the old
 * Cloudflare Worker's `/api/nodes` handler (worker/index.ts) onto Wasp
 * queries/actions, scoped to `context.user.id` instead of a request `owner`
 * header.
 *
 * Wire shape: the client `nodesCollection` speaks the legacy `Node` (see
 * legacy/data/schema.ts) — epoch-ms NUMBERS for createdAt/updatedAt/
 * bookmarkedAt, real booleans, no `userId`/`visibility`. Prisma stores
 * DateTime + scopes by userId. We map between the two here, at the boundary.
 */
export type ClientNode = {
  id: string
  parentId: string | null
  prevSiblingId: string | null
  text: string
  isTask: boolean
  completed: boolean
  collapsed: boolean
  bookmarkedAt: number | null
  createdAt: number
  updatedAt: number
}

function toClientNode(r: DbNode): ClientNode {
  return {
    id: r.id,
    parentId: r.parentId,
    prevSiblingId: r.prevSiblingId,
    text: r.text,
    isTask: r.isTask,
    completed: r.completed,
    collapsed: r.collapsed,
    bookmarkedAt: r.bookmarkedAt ? r.bookmarkedAt.getTime() : null,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  }
}

/** Map a partial client change set to a Prisma update payload. `id`/`userId`
 *  are never writable; `updatedAt` is omitted on purpose — Prisma's `@updatedAt`
 *  stamps the server-authoritative timestamp on apply (PRD US-4). */
function toUpdateData(changes: Partial<ClientNode>): Prisma.NodeUpdateInput {
  const data: Prisma.NodeUpdateInput = {}
  if ('parentId' in changes) data.parentId = changes.parentId ?? null
  if ('prevSiblingId' in changes) data.prevSiblingId = changes.prevSiblingId ?? null
  if ('text' in changes) data.text = changes.text
  if ('isTask' in changes) data.isTask = changes.isTask
  if ('completed' in changes) data.completed = changes.completed
  if ('collapsed' in changes) data.collapsed = changes.collapsed
  if ('bookmarkedAt' in changes) {
    data.bookmarkedAt =
      changes.bookmarkedAt == null ? null : new Date(changes.bookmarkedAt)
  }
  if ('createdAt' in changes && changes.createdAt != null) {
    data.createdAt = new Date(changes.createdAt)
  }
  return data
}

/** Complete server state for the signed-in user. The query collection treats
 *  this as authoritative, so it must return every owned node. */
export const getNodes: GetNodes<void, ClientNode[]> = async (_args, context) => {
  if (!context.user) throw new HttpError(401)
  const rows = await context.entities.Node.findMany({
    where: { userId: context.user.id },
  })
  return rows.map(toClientNode)
}

/**
 * Upsert a batch of the caller's nodes (the collection's onInsert path).
 *
 * Ownership-safe upsert: `id` is globally unique, so it can't carry `userId`
 * in an `upsert`'s `where`. A `updateMany` scoped to `(id, userId)` handles
 * "my existing node"; when it matches nothing the id is either free or owned
 * by someone else, so we `create` only when the id is genuinely unused — never
 * overwriting another user's row. Mirrors the Worker's
 * `WHERE nodes.owner = excluded.owner` conflict guard.
 */
export const upsertNodes: UpsertNodes<{ nodes: ClientNode[] }, void> = async (
  { nodes },
  context,
) => {
  if (!context.user) throw new HttpError(401)
  const userId = context.user.id
  if (!nodes?.length) return

  for (const n of nodes) {
    const bookmarkedAt = n.bookmarkedAt == null ? null : new Date(n.bookmarkedAt)
    const { count } = await context.entities.Node.updateMany({
      where: { id: n.id, userId },
      data: {
        parentId: n.parentId,
        prevSiblingId: n.prevSiblingId,
        text: n.text,
        isTask: n.isTask,
        completed: n.completed,
        collapsed: n.collapsed,
        bookmarkedAt,
      },
    })
    if (count > 0) continue
    const clash = await context.entities.Node.findUnique({
      where: { id: n.id },
      select: { id: true },
    })
    if (clash) continue // id owned by another user — never overwrite
    await context.entities.Node.create({
      data: {
        id: n.id,
        parentId: n.parentId,
        prevSiblingId: n.prevSiblingId,
        text: n.text,
        isTask: n.isTask,
        completed: n.completed,
        collapsed: n.collapsed,
        bookmarkedAt,
        createdAt: new Date(n.createdAt),
        user: { connect: { id: userId } },
      },
    })
  }
}

/**
 * Apply partial updates (the collection's onUpdate path) with last-write-wins.
 *
 * For each update: confirm the row is the caller's, then apply only when the
 * client's `updatedAt` is >= the stored (server-authoritative) timestamp —
 * otherwise drop it silently (a stale device's write). On apply, Prisma's
 * `@updatedAt` overwrites `updatedAt` with the server clock (PRD US-4).
 */
export const updateNodes: UpdateNodes<
  { updates: { id: string; changes: Partial<ClientNode> }[] },
  void
> = async ({ updates }, context) => {
  if (!context.user) throw new HttpError(401)
  const userId = context.user.id
  if (!updates?.length) return

  for (const { id, changes } of updates) {
    const data = toUpdateData(changes)
    if (Object.keys(data).length === 0) continue
    await context.entities.Node.updateMany({
      where: {
        id,
        userId,
        ...(typeof changes.updatedAt === 'number'
          ? { updatedAt: { lte: new Date(changes.updatedAt) } }
          : {}),
      },
      data,
    })
  }
}

/** Delete the caller's nodes by id (the collection's onDelete path). The
 *  `userId` guard makes a cross-user id a no-op. */
export const deleteNodes: DeleteNodes<{ ids: string[] }, void> = async (
  { ids },
  context,
) => {
  if (!context.user) throw new HttpError(401)
  if (!ids?.length) return
  await context.entities.Node.deleteMany({
    where: { id: { in: ids }, userId: context.user.id },
  })
}
