import { HttpError, prisma } from 'wasp/server'
import type {
  GetDailyIndex,
  UpsertDailyIndex,
  DeleteDailyIndexKeys,
} from 'wasp/server/operations'

/**
 * Daily-note identity index (Seam E side-collection, PRD Phase 2). Replaces
 * the generic `/api/kv?collection=daily-index` store with a typed Prisma
 * model. A row maps a key -> nodeId: a local date `YYYY-MM-DD`, or the
 * `"container"` sentinel (legacy/plugins/daily/daily-index.ts). `userId` stays
 * server-side.
 */
export type DailyRow = { key: string; nodeId: string }

export const getDailyIndex: GetDailyIndex<void, DailyRow[]> = async (
  _args,
  context,
) => {
  if (!context.user) throw new HttpError(401)
  return context.entities.DailyIndexEntry.findMany({
    where: { userId: context.user.id },
    select: { key: true, nodeId: true },
  })
}

/** Upsert mappings by `(userId, key)` — the compound id carries `userId`, so a
 *  plain Prisma upsert is ownership-safe. All rows commit in one transaction. */
export const upsertDailyIndex: UpsertDailyIndex<
  { rows: DailyRow[] },
  void
> = async ({ rows }, context) => {
  if (!context.user) throw new HttpError(401)
  const userId = context.user.id
  if (!rows?.length) return
  await prisma.$transaction(
    rows.map((r) =>
      prisma.dailyIndexEntry.upsert({
        where: { userId_key: { userId, key: r.key } },
        create: { userId, key: r.key, nodeId: r.nodeId },
        update: { nodeId: r.nodeId },
      }),
    ),
  )
}

export const deleteDailyIndexKeys: DeleteDailyIndexKeys<
  { keys: string[] },
  void
> = async ({ keys }, context) => {
  if (!context.user) throw new HttpError(401)
  if (!keys?.length) return
  await context.entities.DailyIndexEntry.deleteMany({
    where: { userId: context.user.id, key: { in: keys } },
  })
}
