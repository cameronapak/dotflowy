import { HttpError } from 'wasp/server'
import type {
  GetTagColors,
  UpsertTagColors,
  DeleteTagColors,
} from 'wasp/server/operations'

/**
 * Custom tag colors (Seam E side-collection, PRD Phase 2). Replaces the
 * generic `/api/kv?collection=tag-colors` store with a typed Prisma model.
 * The wire row is `{ tag, color }` — the normalized tag name is the key
 * (legacy/data/tag-colors.ts); `userId`/`updatedAt` stay server-side.
 */
export type TagColorRow = { tag: string; color: string }

export const getTagColors: GetTagColors<void, TagColorRow[]> = async (
  _args,
  context,
) => {
  if (!context.user) throw new HttpError(401)
  return context.entities.TagColor.findMany({
    where: { userId: context.user.id },
    select: { tag: true, color: true },
  })
}

/** Upsert color rows by `(userId, tag)` — the compound id carries `userId`, so
 *  a plain Prisma upsert is already ownership-safe (no cross-user clash). */
export const upsertTagColors: UpsertTagColors<
  { rows: TagColorRow[] },
  void
> = async ({ rows }, context) => {
  if (!context.user) throw new HttpError(401)
  const userId = context.user.id
  if (!rows?.length) return
  for (const r of rows) {
    await context.entities.TagColor.upsert({
      where: { userId_tag: { userId, tag: r.tag } },
      create: { userId, tag: r.tag, color: r.color },
      update: { color: r.color },
    })
  }
}

/** Clear colors (the legacy `clearTagColor` onDelete path). Not in the PRD
 *  tags table — an inconsistency vs. daily's delete op — but the client's
 *  collection onDelete needs it. */
export const deleteTagColors: DeleteTagColors<
  { tags: string[] },
  void
> = async ({ tags }, context) => {
  if (!context.user) throw new HttpError(401)
  if (!tags?.length) return
  await context.entities.TagColor.deleteMany({
    where: { userId: context.user.id, tag: { in: tags } },
  })
}
