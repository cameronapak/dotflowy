/**
 * Off-site backup of per-user Durable Object outlines to R2 (ticket #221,
 * map #151; research in #155). Pure pieces only — key layout, sweep targeting,
 * and the snapshot schema the restore path validates against — so they're
 * unit-testable without a DO or an R2 bucket (worker/backup.test.ts). The DO
 * RPCs (`exportSnapshot`/`restoreSnapshot`) live in worker/outline-do.ts; the
 * cron sweep and admin routes in worker/index.ts. Operator steps in
 * docs/runbooks/offsite-backup-r2.md.
 */

import { Schema } from "effect";

import { NodeSchema } from "../src/data/wire-schema";

/** Bump when the snapshot shape changes; the restore path refuses a version it
 *  doesn't know rather than guessing at a partial read. */
export const SNAPSHOT_VERSION = 1;

/**
 * A kv side-collection row exactly as the DO's SQLite stores it: `value` stays
 * the RAW stored JSON TEXT (never parsed on export, inserted verbatim on
 * restore), so a snapshot round-trips the kv table byte-for-byte and this
 * module never needs to know any side-collection's shape.
 */
export const SnapshotKvRowSchema = Schema.Struct({
  collection: Schema.String,
  key: Schema.String,
  value: Schema.String,
  updatedAt: Schema.Number,
});
export type SnapshotKvRow = Schema.Schema.Type<typeof SnapshotKvRowSchema>;

/**
 * One user's whole outline as exported to R2. `nodes` reuses the shared wire
 * `NodeSchema` (the same leaf the client and the DO already derive from, ADR
 * 0014), so a snapshot a stale export wrote with a missing field is rejected at
 * the restore boundary instead of inserting `undefined` into SQLite. `seq` +
 * `exportedAt` are observability metadata, not restore inputs.
 */
export const OutlineSnapshotSchema = Schema.Struct({
  version: Schema.Number,
  exportedAt: Schema.Number,
  seq: Schema.Number,
  nodes: Schema.Array(NodeSchema),
  kv: Schema.Array(SnapshotKvRowSchema),
});
export type OutlineSnapshot = Schema.Schema.Type<typeof OutlineSnapshotSchema>;

/** The UTC calendar date a sweep runs on — one object per DO per day; a re-run
 *  the same day overwrites (idempotent), never duplicates. */
export function utcDateKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Does a restore request's `date` name a sweep object (`YYYY-MM-DD`)? Checked
 *  at the route so a stray path fragment can never reach the R2 key template. */
export function isBackupDateKey(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

/** R2 key prefix for one DO's snapshots (also the list-backups query prefix).
 *  Keyed by the DO NAME (`resolveUserId`'s output — the owner's account maps to
 *  `'default'`), i.e. by what was actually exported, so an OWNER_USER_ID change
 *  can't strand a backup under an id that no longer routes to that data. */
export function backupPrefix(doName: string): string {
  return `backups/${doName}/`;
}

export function backupKey(doName: string, at: number): string {
  return `${backupPrefix(doName)}${utcDateKey(at)}.json`;
}

/**
 * The DO names one sweep must export: every D1 user id, with the owner's
 * account mapped to the constant `'default'` DO (the same mapping
 * `resolveUserId` applies on the request path), deduped in case a stray D1 row
 * ever carries the literal name. D1's `user` table is the authoritative id set
 * — deliberately NOT the eventually-consistent DO enumeration API (#155).
 */
export function backupTargets(
  userIds: readonly string[],
  ownerUserId: string | undefined,
): string[] {
  const names = userIds.map((id) =>
    ownerUserId && id === ownerUserId ? "default" : id,
  );
  return [...new Set(names)];
}
