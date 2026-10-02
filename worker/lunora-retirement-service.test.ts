import { describe, expect, it } from "bun:test";

import type { Node } from "../src/data/wire-schema";
import type { OutlineSnapshot } from "./backup";
import type { LunoraRetirementSnapshot } from "./lunora-retirement";
import type {
  RetirementBackends,
  RetirementRecord,
} from "./lunora-retirement-service";

import {
  retirementDiagnostic,
  runRetirementOperation,
} from "./lunora-retirement-service";

const USER_ID = "user-1";

function node(id: string): Node {
  return {
    id,
    parentId: null,
    prevSiblingId: null,
    text: id,
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
}

function classicSnapshot(id = "classic"): OutlineSnapshot {
  return {
    version: 1,
    exportedAt: 1,
    seq: 1,
    nodes: [node(id)],
    kv: [
      {
        collection: "account-prefs",
        key: "lunora-beta",
        value: '{"id":"lunora-beta","enabled":true}',
        updatedAt: 1,
      },
    ],
  };
}

function lunoraSnapshot(): LunoraRetirementSnapshot {
  return {
    version: 1,
    exportedAt: 2,
    userId: USER_ID,
    nodes: [{ ...node("lunora"), userId: USER_ID }],
    dailyIndex: [],
    tagColors: [],
    savedQueries: [],
    migrateState: [{ userId: USER_ID, nodesAt: 1, kvAt: 1 }],
  };
}

function clone<A>(value: A): A {
  return structuredClone(value);
}

function fakeDb() {
  let record: RetirementRecord | null = null;
  let attempts = 0;
  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      async first<A>() {
        if (sql.includes("SET activeOperationId = ?")) {
          if (!record || record.activeOperationId !== null) return null;
          // SAFETY: these positions mirror the operation claim's fixed bind list.
          record = {
            ...record,
            activeOperationId: args[0] as string,
            activeOperationStartedAt: args[1] as number,
          };
        }
        // SAFETY: this fake stores only RetirementRecord values and the service requests RetirementRecord here.
        return (record ? clone(record) : null) as A | null;
      },
      async run() {
        if (sql.includes("INSERT OR IGNORE INTO lunora_retirement")) {
          if (!record) {
            // SAFETY: these positions mirror ensureRecord's fixed D1 bind list.
            record = {
              userId: args[0] as string,
              migrationId: args[1] as string,
              state: "created",
              classification: null,
              result: null,
              startedAt: args[2] as number,
              updatedAt: args[3] as number,
              completedAt: null,
              classicSnapshotKey: null,
              classicSnapshotHash: null,
              lunoraSnapshotKey: null,
              lunoraSnapshotHash: null,
              counts: null,
              failureReason: null,
              activeOperationId: null,
              activeOperationStartedAt: null,
            };
          }
        } else if (sql.includes("SET activeOperationId = NULL")) {
          if (record && record.activeOperationId === args[1]) {
            record = {
              ...record,
              activeOperationId: null,
              activeOperationStartedAt: null,
            };
          }
        } else if (sql.includes("UPDATE lunora_retirement SET")) {
          if (!record) throw new Error("missing fake retirement record");
          // SAFETY: these positions mirror updateRecord's fixed D1 bind list.
          record = {
            ...record,
            state: args[0] as string,
            classification: args[1] as RetirementRecord["classification"],
            result: args[2] as string | null,
            updatedAt: args[3] as number,
            completedAt: args[4] as number | null,
            classicSnapshotKey: args[5] as string | null,
            classicSnapshotHash: args[6] as string | null,
            lunoraSnapshotKey: args[7] as string | null,
            lunoraSnapshotHash: args[8] as string | null,
            counts: args[9] as string | null,
            failureReason: args[10] as string | null,
          };
        } else if (sql.includes("INSERT INTO lunora_retirement_attempt")) {
          attempts++;
        }
        return { success: true };
      },
    }),
  });
  // SAFETY: the coordinator tests exercise only prepare/bind/first/run.
  const db = Object.assign({} as D1Database, { prepare });
  return {
    db,
    get record() {
      return record;
    },
    set record(value: RetirementRecord | null) {
      record = value;
    },
    get attempts() {
      return attempts;
    },
  };
}

function fakeBucket(corruptReadback = false) {
  const objects = new Map<string, Uint8Array>();
  let corruptNext = false;
  const get = async (key: string) => {
    const stored = objects.get(key);
    if (!stored) return null;
    let bytes = stored;
    if (corruptNext) {
      corruptNext = false;
      // SAFETY: the fake corrupts snapshots written by this test, all of which have numeric exportedAt.
      const raw = JSON.parse(new TextDecoder().decode(stored)) as {
        exportedAt: number;
      };
      bytes = new TextEncoder().encode(
        JSON.stringify({ ...raw, exportedAt: raw.exportedAt + 1 }),
      );
    }
    // SAFETY: this object implements the only R2ObjectBody method the coordinator reads.
    return {
      arrayBuffer: async () => bytes.slice().buffer,
    } as R2ObjectBody;
  };
  const put = async (key: string, value: Uint8Array) => {
    if (!objects.has(key)) objects.set(key, value.slice());
    if (corruptReadback) corruptNext = true;
    // SAFETY: callers ignore the R2Object returned by put; the fake preserves that contract.
    return {} as R2Object;
  };
  // SAFETY: the coordinator tests exercise only get/put.
  const bucket = Object.assign({} as R2Bucket, { get, put });
  return { bucket, objects };
}

function fakeBackends(options?: {
  failMarkRetired?: boolean;
  failPreRestore?: boolean;
}) {
  let classic = classicSnapshot();
  let lunora = lunoraSnapshot();
  let classicFrozenBy: string | null = null;
  let appliedMigrationId: string | null = null;
  let lunoraStatus: "frozen" | "retired" | null = null;
  let lunoraMigrationId: string | null = null;
  let classicFreezeCalls = 0;
  let restoreCalls = 0;
  let failPreRestore = options?.failPreRestore ?? false;

  const backends: RetirementBackends = {
    classic: {
      async exportSnapshot() {
        return clone(classic);
      },
      async freezeAndExportRetirement(migrationId: string) {
        if (classicFrozenBy && classicFrozenBy !== migrationId)
          throw new Error("classic fenced by another migration");
        classicFrozenBy = migrationId;
        classicFreezeCalls++;
        return clone(classic);
      },
      async getNodes() {
        return clone(classic.nodes);
      },
      async releaseRetirementFreeze(migrationId: string) {
        if (classicFrozenBy && classicFrozenBy !== migrationId)
          throw new Error("wrong classic fence");
        classicFrozenBy = null;
      },
      async restoreRetirementSnapshot(input: {
        migrationId: string;
        nodes: readonly Node[];
        kv: OutlineSnapshot["kv"];
      }) {
        restoreCalls++;
        if (
          classicFrozenBy !== input.migrationId ||
          lunoraStatus !== "frozen" ||
          lunoraMigrationId !== input.migrationId
        ) {
          throw new Error("restore attempted without both write fences");
        }
        if (appliedMigrationId === input.migrationId)
          return {
            applied: false,
            nodes: classic.nodes.length,
            kv: classic.kv.length,
          };
        classic = {
          ...classic,
          nodes: clone([...input.nodes]),
          kv: clone(input.kv),
        };
        appliedMigrationId = input.migrationId;
        return {
          applied: true,
          nodes: classic.nodes.length,
          kv: classic.kv.length,
        };
      },
      async restorePreRetirementSnapshot(input: {
        migrationId: string;
        nodes: readonly Node[];
        kv: OutlineSnapshot["kv"];
      }) {
        if (classicFrozenBy !== input.migrationId)
          throw new Error("rollback attempted without classic fence");
        if (failPreRestore) throw new Error("pre-migration restore failed");
        classic = {
          ...classic,
          nodes: clone([...input.nodes]),
          kv: clone(input.kv),
        };
        appliedMigrationId = null;
        return { nodes: classic.nodes.length, kv: classic.kv.length };
      },
      async retirementStatus() {
        return { frozenBy: classicFrozenBy, appliedMigrationId };
      },
    },
    lunora: {
      async inspect() {
        return {
          retirement: lunoraStatus
            ? {
                migrationId: lunoraMigrationId!,
                status: lunoraStatus,
                updatedAt: 1,
              }
            : null,
          snapshot: clone(lunora),
        };
      },
      async freezeAndExport(migrationId: string) {
        if (lunoraMigrationId && lunoraMigrationId !== migrationId)
          throw new Error("Lunora fenced by another migration");
        lunoraMigrationId = migrationId;
        lunoraStatus = "frozen";
        return clone(lunora);
      },
      async releaseFreeze(migrationId: string) {
        if (lunoraMigrationId && lunoraMigrationId !== migrationId)
          throw new Error("wrong Lunora fence");
        if (lunoraStatus !== "retired") {
          lunoraStatus = null;
          lunoraMigrationId = null;
        }
        return { released: true };
      },
      async markRetired(migrationId: string) {
        if (options?.failMarkRetired) throw new Error("mark retired failed");
        if (lunoraStatus !== "frozen" || lunoraMigrationId !== migrationId)
          throw new Error("matching Lunora fence required");
        lunoraStatus = "retired";
        return { retired: true };
      },
    },
  };

  return {
    backends,
    get classic() {
      return classic;
    },
    get classicFrozenBy() {
      return classicFrozenBy;
    },
    get lunoraStatus() {
      return lunoraStatus;
    },
    get classicFreezeCalls() {
      return classicFreezeCalls;
    },
    get restoreCalls() {
      return restoreCalls;
    },
    simulateCrashAfterRestore(migrationId: string) {
      classicFrozenBy = migrationId;
      appliedMigrationId = migrationId;
      lunoraMigrationId = migrationId;
      lunoraStatus = "frozen";
    },
    failNextPreRetirementRestore() {
      failPreRestore = true;
    },
    editLunora(text: string) {
      if (lunoraStatus) throw new Error("Lunora is frozen");
      lunora = {
        ...lunora,
        nodes: lunora.nodes.map((row) => ({ ...row, text })),
      };
    },
    replaceLunora(snapshot: LunoraRetirementSnapshot) {
      if (lunoraStatus) throw new Error("Lunora is frozen");
      lunora = clone(snapshot);
    },
    replaceClassic(snapshot: OutlineSnapshot) {
      if (classicFrozenBy) throw new Error("classic is frozen");
      classic = clone(snapshot);
    },
  };
}

function fixture(options?: {
  corruptReadback?: boolean;
  failMarkRetired?: boolean;
}) {
  const db = fakeDb();
  const bucket = fakeBucket(options?.corruptReadback);
  const backend = fakeBackends({ failMarkRetired: options?.failMarkRetired });
  // SAFETY: injected backends mean this test env exercises only DB and BACKUPS; production-only namespaces are never read.
  const env = {
    DB: db.db,
    BACKUPS: bucket.bucket,
  } as Parameters<typeof runRetirementOperation>[0];
  return { db, bucket, backend, env };
}

describe("read-only retirement diagnostic", () => {
  it("reads both backends without creating a record, backup, or fence", async () => {
    const f = fixture();
    const before = await f.backend.backends.lunora.inspect();
    const classicBefore = clone(f.backend.classic);
    const report = await retirementDiagnostic(
      f.env,
      USER_ID,
      f.backend.backends,
    );
    expect(report).toMatchObject({
      userId: USER_ID,
      experimentalPreference: "enabled",
      nodes: { classic: 1, experimental: 1, shared: 0 },
    });
    expect(report.readFinishedAt).toBeGreaterThanOrEqual(report.readStartedAt);
    expect(f.backend.classic).toEqual(classicBefore);
    expect(await f.backend.backends.lunora.inspect()).toEqual(before);
    expect(f.db.record).toBeNull();
    expect(f.db.attempts).toBe(0);
    expect(f.bucket.objects.size).toBe(0);
    expect(f.backend.classicFreezeCalls).toBe(0);
    expect(f.backend.restoreCalls).toBe(0);
  });

  it("rejects malformed snapshots with a constant content-free error", async () => {
    for (const backend of ["classic", "experimental"]) {
      const f = fixture();
      if (backend === "classic") {
        const classic = classicSnapshot();
        for (const row of classic.nodes) Reflect.deleteProperty(row, "text");
        f.backend.replaceClassic(classic);
      } else {
        const experimental = lunoraSnapshot();
        for (const row of experimental.nodes)
          Reflect.deleteProperty(row, "text");
        f.backend.replaceLunora(experimental);
      }
      await expect(
        retirementDiagnostic(f.env, USER_ID, f.backend.backends),
      ).rejects.toThrow("retirement diagnostic snapshot schema rejected");
    }
  });

  it("rejects unsupported versions and foreign ownership in every experimental collection", async () => {
    const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => f.backend.replaceClassic({ ...classicSnapshot(), version: 2 }),
      (f) => f.backend.replaceLunora({ ...lunoraSnapshot(), version: 2 }),
      (f) =>
        f.backend.replaceLunora({ ...lunoraSnapshot(), userId: "foreign" }),
      (f) =>
        f.backend.replaceLunora({
          ...lunoraSnapshot(),
          nodes: [{ ...node("x"), userId: "foreign" }],
        }),
      (f) =>
        f.backend.replaceLunora({
          ...lunoraSnapshot(),
          dailyIndex: [
            { key: "SECRET_DAY", nodeId: "x", touchedAt: 1, userId: "foreign" },
          ],
        }),
      (f) =>
        f.backend.replaceLunora({
          ...lunoraSnapshot(),
          tagColors: [
            { tag: "SECRET_TAG", color: "SECRET_COLOR", userId: "foreign" },
          ],
        }),
      (f) =>
        f.backend.replaceLunora({
          ...lunoraSnapshot(),
          savedQueries: [
            {
              id: "q",
              name: "SECRET_NAME",
              query: "SECRET_QUERY",
              createdAt: 1,
              userId: "foreign",
            },
          ],
        }),
      (f) =>
        f.backend.replaceLunora({
          ...lunoraSnapshot(),
          migrateState: [{ nodesAt: 1, kvAt: 1, userId: "foreign" }],
        }),
    ];
    for (const mutate of mutations) {
      const f = fixture();
      mutate(f);
      await expect(
        retirementDiagnostic(f.env, USER_ID, f.backend.backends),
      ).rejects.toThrow("retirement diagnostic version or ownership rejected");
      expect(f.db.record).toBeNull();
      expect(f.bucket.objects.size).toBe(0);
    }
  });
});

describe("Lunora retirement coordinator", () => {
  it("installs both write fences before restore and leaves only Lunora retired", async () => {
    const f = fixture();
    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "migrate",
      f.backend.backends,
    );

    expect(result.state).toBe("completed");
    expect(f.backend.classic.nodes.map((row) => row.id)).toEqual(["lunora"]);
    expect(f.backend.classicFrozenBy).toBeNull();
    expect(f.backend.lunoraStatus).toBe("retired");
  });

  it("refuses restore when immutable backup read-back differs and releases safe fences", async () => {
    const f = fixture({ corruptReadback: true });
    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "migrate",
      f.backend.backends,
    );

    expect(result.result).toBe("failed-before-restore");
    expect(result.failureReason).toContain("write-read hash verification");
    expect(f.backend.restoreCalls).toBe(0);
    expect(f.backend.classic.nodes.map((row) => row.id)).toEqual(["classic"]);
    expect(f.backend.classicFrozenBy).toBeNull();
    expect(f.backend.lunoraStatus).toBeNull();
  });

  it("resumes an applied restore and makes a completed retry a backend no-op", async () => {
    const f = fixture();
    const first = await runRetirementOperation(
      f.env,
      USER_ID,
      "migrate",
      f.backend.backends,
    );
    const migrationId = first.migrationId;
    f.db.record = {
      ...first,
      state: "classic-restored",
      result: null,
      completedAt: null,
    };
    f.backend.simulateCrashAfterRestore(migrationId);

    const resumed = await runRetirementOperation(
      f.env,
      USER_ID,
      "retry",
      f.backend.backends,
    );
    expect(resumed.state).toBe("completed");
    expect(resumed.migrationId).toBe(migrationId);
    const freezeCalls = f.backend.classicFreezeCalls;
    const completed = await runRetirementOperation(
      f.env,
      USER_ID,
      "retry",
      f.backend.backends,
    );
    expect(completed.state).toBe("completed");
    expect(f.backend.classicFreezeCalls).toBe(freezeCalls);
  });

  it("rolls classic back and verifies it when retirement fails after restore", async () => {
    const f = fixture({ failMarkRetired: true });
    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "migrate",
      f.backend.backends,
    );

    expect(result.state).toBe("rolled-back");
    expect(result.result).toBe("failed-rolled-back");
    expect(result.failureReason).toBe("mark retired failed");
    expect(f.backend.classic.nodes.map((row) => row.id)).toEqual(["classic"]);
    expect(f.backend.classicFrozenBy).toBeNull();
    expect(f.backend.lunoraStatus).toBeNull();
  });

  it("keeps classic routing disabled after an operator restore of a retired shard", async () => {
    const f = fixture();
    const migrated = await runRetirementOperation(
      f.env,
      USER_ID,
      "migrate",
      f.backend.backends,
    );
    expect(migrated.state).toBe("completed");

    const restored = await runRetirementOperation(
      f.env,
      USER_ID,
      "restore",
      f.backend.backends,
    );
    const preference = f.backend.classic.kv.find(
      (row) => row.collection === "account-prefs" && row.key === "lunora-beta",
    );
    expect(restored.state).toBe("restored-pre-migration");
    expect(f.backend.classic.nodes.map((row) => row.id)).toEqual(["classic"]);
    expect(preference?.value).toBe('{"id":"lunora-beta","enabled":false}');
    expect(f.backend.classicFrozenBy).toBeNull();
    expect(f.backend.lunoraStatus).toBe("retired");
  });

  it("releases safe fences when operator restore fails before content changes", async () => {
    const f = fixture();
    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "restore",
      f.backend.backends,
    );

    expect(result.state).toBe("failed");
    expect(result.result).toBe("failed-before-restore");
    expect(result.failureReason).toBe(
      "classic retirement backup is unavailable",
    );
    expect(f.backend.classicFrozenBy).toBeNull();
    expect(f.backend.lunoraStatus).toBeNull();
  });

  it("keeps classic fenced when operator restore may have started", async () => {
    const f = fixture();
    const migrated = await runRetirementOperation(
      f.env,
      USER_ID,
      "migrate",
      f.backend.backends,
    );
    f.backend.failNextPreRetirementRestore();

    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "restore",
      f.backend.backends,
    );

    expect(result.state).toBe("uncertain");
    expect(result.result).toBe("operator-recovery-required");
    expect(result.failureReason).toBe("pre-migration restore failed");
    expect(f.backend.classicFrozenBy).toBe(migrated.migrationId);
    expect(f.backend.lunoraStatus).toBe("retired");
  });

  it("refuses a stale backup after rollback and preserves newer Lunora edits", async () => {
    const f = fixture();
    const markRetired = f.backend.backends.lunora.markRetired;
    f.backend.backends.lunora.markRetired = async () => {
      throw new Error("transient retirement failure");
    };
    const first = await runRetirementOperation(
      f.env,
      USER_ID,
      "migrate",
      f.backend.backends,
    );
    expect(first.state).toBe("rolled-back");
    const backups = clone([...f.bucket.objects]);
    f.backend.editLunora("edit accepted after rollback");
    f.backend.backends.lunora.markRetired = markRetired;

    const retried = await runRetirementOperation(
      f.env,
      USER_ID,
      "retry",
      f.backend.backends,
    );
    expect(retried.result).toBe("failed-before-restore");
    expect(retried.failureReason).toContain("Lunora content changed");
    expect(f.backend.restoreCalls).toBe(1);
    expect(f.backend.classic.nodes[0]?.text).toBe("classic");
    expect(
      (await f.backend.backends.lunora.inspect()).snapshot.nodes[0]?.text,
    ).toBe("edit accepted after rollback");
    expect(f.backend.classicFrozenBy).toBeNull();
    expect(f.backend.lunoraStatus).toBeNull();
    expect([...f.bucket.objects]).toEqual(backups);
  });

  it("keeps completion durable through repeated population dry-runs and retries", async () => {
    const f = fixture();
    const completed = await runRetirementOperation(
      f.env,
      USER_ID,
      "migrate",
      f.backend.backends,
    );
    const calls = f.backend.classicFreezeCalls;
    for (let i = 0; i < 2; i++) {
      const preview = await runRetirementOperation(
        f.env,
        USER_ID,
        "dry-run",
        f.backend.backends,
      );
      expect(preview.state).toBe("completed");
      expect(preview.result).toBe("migrated");
      expect(f.db.record).toEqual(completed);
      await runRetirementOperation(f.env, USER_ID, "retry", f.backend.backends);
    }
    expect(f.backend.classicFreezeCalls).toBe(calls);
  });

  it("keeps uncertain recovery state and fences through dry-run and retry", async () => {
    const f = fixture();
    await runRetirementOperation(f.env, USER_ID, "migrate", f.backend.backends);
    f.backend.failNextPreRetirementRestore();
    const uncertain = await runRetirementOperation(
      f.env,
      USER_ID,
      "restore",
      f.backend.backends,
    );
    const calls = f.backend.classicFreezeCalls;
    await runRetirementOperation(f.env, USER_ID, "dry-run", f.backend.backends);
    expect(f.db.record).toEqual(uncertain);
    await runRetirementOperation(f.env, USER_ID, "retry", f.backend.backends);
    expect(f.db.record).toEqual(uncertain);
    expect(f.backend.classicFreezeCalls).toBe(calls);
    expect(f.backend.classicFrozenBy).toBe(uncertain.migrationId);
  });

  it.each(["nodes", "preferences"])(
    "rejects changed classic %s after rollback before restoring",
    async (content) => {
      const f = fixture({ failMarkRetired: true });
      await runRetirementOperation(
        f.env,
        USER_ID,
        "migrate",
        f.backend.backends,
      );
      if (content === "nodes") {
        f.backend.replaceClassic({
          ...f.backend.classic,
          nodes: f.backend.classic.nodes.map((row) => ({
            ...row,
            text: "new classic edit",
          })),
        });
      } else {
        f.backend.replaceClassic({
          ...f.backend.classic,
          kv: [
            ...f.backend.classic.kv,
            {
              collection: "account-prefs",
              key: "timezone",
              value: '{"zone":"Pacific/Auckland"}',
              updatedAt: 27,
            },
          ],
        });
      }
      const edited = clone(f.backend.classic);
      const result = await runRetirementOperation(
        f.env,
        USER_ID,
        "retry",
        f.backend.backends,
      );
      expect(result.failureReason).toContain("classic content changed");
      expect(f.backend.restoreCalls).toBe(1);
      expect(f.backend.classic).toEqual(edited);
      expect(f.backend.classicFrozenBy).toBeNull();
      expect(f.backend.lunoraStatus).toBeNull();
    },
  );

  it.each(["dailyIndex", "tagColors", "savedQueries", "migrateState"] as const)(
    "rejects changed Lunora %s even when nodes are unchanged",
    async (table) => {
      const f = fixture({ failMarkRetired: true });
      await runRetirementOperation(
        f.env,
        USER_ID,
        "migrate",
        f.backend.backends,
      );
      const snapshot = (await f.backend.backends.lunora.inspect()).snapshot;
      const edited = {
        ...snapshot,
        dailyIndex:
          table === "dailyIndex"
            ? [
                {
                  userId: USER_ID,
                  key: "2026-10-02",
                  nodeId: "lunora",
                  touchedAt: 4,
                },
              ]
            : snapshot.dailyIndex,
        tagColors:
          table === "tagColors"
            ? [{ userId: USER_ID, tag: "work", color: "red" }]
            : snapshot.tagColors,
        savedQueries:
          table === "savedQueries"
            ? [
                {
                  userId: USER_ID,
                  id: "query",
                  name: "Work",
                  query: "#work",
                  createdAt: 5,
                },
              ]
            : snapshot.savedQueries,
        migrateState:
          table === "migrateState"
            ? [{ userId: USER_ID, nodesAt: 1, kvAt: 6 }]
            : snapshot.migrateState,
      };
      f.backend.replaceLunora(edited);
      const backups = clone([...f.bucket.objects]);
      const result = await runRetirementOperation(
        f.env,
        USER_ID,
        "retry",
        f.backend.backends,
      );
      expect(result.failureReason).toContain("Lunora content changed");
      expect(f.backend.restoreCalls).toBe(1);
      expect((await f.backend.backends.lunora.inspect()).snapshot).toEqual(
        edited,
      );
      expect([...f.bucket.objects]).toEqual(backups);
      expect(f.backend.classicFrozenBy).toBeNull();
      expect(f.backend.lunoraStatus).toBeNull();
    },
  );

  it("allows unchanged re-exports with different timestamps and row order", async () => {
    const f = fixture();
    f.backend.replaceLunora({
      ...lunoraSnapshot(),
      nodes: [
        { ...node("lunora"), userId: USER_ID },
        { ...node("second"), prevSiblingId: "lunora", userId: USER_ID },
      ],
    });
    const retire = f.backend.backends.lunora.markRetired;
    f.backend.backends.lunora.markRetired = async () => {
      throw new Error("transient failure");
    };
    await runRetirementOperation(f.env, USER_ID, "migrate", f.backend.backends);
    const snapshot = (await f.backend.backends.lunora.inspect()).snapshot;
    f.backend.replaceLunora({
      ...snapshot,
      exportedAt: 900,
      nodes: [...snapshot.nodes].reverse(),
    });
    f.backend.replaceClassic({
      ...f.backend.classic,
      exportedAt: 800,
      seq: 12,
    });
    f.backend.backends.lunora.markRetired = retire;
    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "retry",
      f.backend.backends,
    );
    expect(result.state).toBe("completed");
    expect(f.backend.classic.nodes.map((row) => row.id)).toEqual([
      "lunora",
      "second",
    ]);
  });
});
