/**
 * Off-site backup pure pieces (#221): the R2 key layout, sweep targeting, the
 * restore date guard, and the snapshot schema's accept/reject at the trust
 * boundary (e2e can't reach any of this — seedOutline mocks the Worker). The
 * live pieces (cron sweep, DO export/restore, R2 I/O) are verified by hand via
 * `wrangler dev --test-scheduled` — see docs/runbooks/offsite-backup-r2.md.
 */

import { describe, expect, it } from "bun:test";
import { Schema } from "effect";

import type { Node } from "../src/data/wire-schema";

import {
  OutlineSnapshotSchema,
  SNAPSHOT_VERSION,
  backupKey,
  backupKeyForDate,
  backupPrefix,
  backupTargets,
  isBackupDateKey,
  utcDateKey,
} from "./backup";

const decode = Schema.decodeUnknownSync(OutlineSnapshotSchema);

const NODE: Node = {
  id: "a",
  parentId: null,
  prevSiblingId: null,
  text: "Alpha",
  isTask: false,
  completed: false,
  collapsed: false,
  bookmarkedAt: null,
  mirrorOf: null,
  createdAt: 1,
  updatedAt: 1,
  origin: null,
  kind: null,
};

const SNAPSHOT = {
  version: SNAPSHOT_VERSION,
  exportedAt: 1_700_000_000_000,
  seq: 42,
  nodes: [NODE],
  kv: [
    {
      collection: "daily-index",
      key: "2026-07-17",
      value: '{"nodeId":"a"}',
      updatedAt: 1,
    },
  ],
};

describe("backup keys", () => {
  it("keys one object per DO per UTC day", () => {
    // 2026-07-17T23:30Z stays the 17th regardless of the box's local zone.
    const at = Date.parse("2026-07-17T23:30:00Z");
    expect(utcDateKey(at)).toBe("2026-07-17");
    expect(backupKey("u1", at)).toBe("backups/u1/2026-07-17.json");
    expect(backupPrefix("u1")).toBe("backups/u1/");
  });

  it("computes a restore key from a date string with no Date round-trip", () => {
    // The route builds keys this way so a calendar-invalid shape (2026-02-31)
    // lands as a clean "no backup" miss, never a NaN→RangeError defect.
    expect(backupKeyForDate("u1", "2026-07-17")).toBe(
      "backups/u1/2026-07-17.json",
    );
    expect(backupKeyForDate("u1", "2026-02-31")).toBe(
      "backups/u1/2026-02-31.json",
    );
  });

  it("accepts sweep-shaped dates and rejects path fragments", () => {
    expect(isBackupDateKey("2026-07-17")).toBe(true);
    expect(isBackupDateKey("2026-7-17")).toBe(false);
    expect(isBackupDateKey("../other-user/2026-07-17")).toBe(false);
    expect(isBackupDateKey("2026-07-17.json")).toBe(false);
  });
});

describe("backupTargets", () => {
  // The resolver stands in for resolveUserId — the sweep injects the real one
  // so the owner→'default' mapping lives in exactly one place.
  const resolve = (id: string) => (id === "owner" ? "default" : id);

  it("maps ids through the resolver and dedupes", () => {
    expect(backupTargets(["u1", "owner", "u2"], resolve)).toEqual([
      "u1",
      "default",
      "u2",
    ]);
    // A stray literal 'default' row must not double-export the owner DO.
    expect(backupTargets(["owner", "default"], resolve)).toEqual(["default"]);
  });

  it("passes ids through an identity resolver untouched", () => {
    expect(backupTargets(["u1", "u2"], (id) => id)).toEqual(["u1", "u2"]);
  });
});

describe("OutlineSnapshotSchema", () => {
  it("accepts a well-formed snapshot", () => {
    expect(() => decode(SNAPSHOT)).not.toThrow();
  });

  it("rejects a node missing a required wire field", () => {
    const { kind: _kind, ...partial } = NODE;
    expect(() => decode({ ...SNAPSHOT, nodes: [partial] })).toThrow();
  });

  it("rejects a kv row whose value is not the raw stored TEXT", () => {
    const bad = { ...SNAPSHOT.kv[0], value: { nodeId: "a" } };
    expect(() => decode({ ...SNAPSHOT, kv: [bad] })).toThrow();
  });

  it("rejects a snapshot with no version", () => {
    const { version: _v, ...rest } = SNAPSHOT;
    expect(() => decode(rest)).toThrow();
  });
});
