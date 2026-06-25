import { HttpError } from 'wasp/server'
import type { DeleteAccount } from 'wasp/server/operations'

/**
 * Delete the signed-in user and everything they own (PRD Phase 2: account
 * deletion cascade). One delete is enough: `onDelete: Cascade` from User ->
 * Node/TagColor/DailyIndexEntry (schema.prisma) clears their data, and Wasp's
 * generated Auth -> User cascade clears their credentials. No UI yet — that
 * lands with the client port (Phase 3).
 */
export const deleteAccount: DeleteAccount<void, void> = async (
  _args,
  context,
) => {
  if (!context.user) throw new HttpError(401)
  await context.entities.User.delete({ where: { id: context.user.id } })
}
