import { describe, expect, it } from "bun:test";

import type { Node } from "../src/data/wire-schema";
import type { OutlineSnapshot } from "./backup";
import type {
  LunoraRetirementArchive,
  LunoraRetirementSnapshot,
} from "./lunora-retirement";
import type {
  RetirementBackends,
  RetirementRecord,
} from "./lunora-retirement-service";

import {
  retirementDiagnostic,
  retirementRepairPreview,
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
    locked: false,
    mirrorOf: null,
    createdAt: 1,
    updatedAt: 1,
    origin: null,
    kind: null,
  };
}

function classicSnapshot(id = "classic"): OutlineSnapshot {
  return {
    version: 2,
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
              policy: "lunora-to-classic-v1",
              recoveryManifestKey: null,
              recoveryManifestHash: null,
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
          if (sql.includes("SET policy = ?")) {
            if (
              record.userId === args[1] &&
              record.activeOperationId === args[2] &&
              (args[0] === "experimental-primary-recovery-v1" ||
                args[0] === "classic-link-repair-v1")
            )
              record = {
                ...record,
                policy: args[0],
              };
            return { success: true };
          }
          if (sql.includes("policy = 'preserve-classic-v1'")) {
            // SAFETY: these positions mirror selectPreserveClassicPolicy's fixed bind list.
            record = {
              ...record,
              migrationId: args[0] as string,
              policy: "preserve-classic-v1",
              state: "created",
              classification: null,
              result: null,
              startedAt: args[1] as number,
              updatedAt: args[2] as number,
              completedAt: null,
              classicSnapshotKey: null,
              classicSnapshotHash: null,
              lunoraSnapshotKey: null,
              lunoraSnapshotHash: null,
              recoveryManifestKey: null,
              recoveryManifestHash: null,
              counts: null,
              failureReason: null,
            };
            return { success: true };
          }
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
            recoveryManifestKey: args[11] as string | null,
            recoveryManifestHash: args[12] as string | null,
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
  let preserveCalls = 0;
  let recoveryCalls = 0;
  let retiredRoutingBy: string | null = null;
  let preserveReceipt: Awaited<
    ReturnType<RetirementBackends["classic"]["preserveClassicReceipt"]>
  > = null;
  let recoveryReceipt: Awaited<
    ReturnType<RetirementBackends["classic"]["classicRecoveryReceipt"]>
  > = null;
  let failPreRestore = options?.failPreRestore ?? false;

  const backends: RetirementBackends = {
    classic: {
      async preserveClassicReceipt() {
        return preserveReceipt;
      },
      async preserveClassicRetirement(input) {
        preserveCalls++;
        if (classicFrozenBy !== input.migrationId)
          throw new Error("preservation requires classic fence");
        preserveReceipt ??= {
          policy: "preserve-classic-v1",
          migrationId: input.migrationId,
          classicSnapshotHash: input.classicSnapshotHash,
          lunoraSnapshotHash: input.lunoraSnapshotHash,
        };
        return preserveReceipt;
      },
      async finalizeRetirementRouting(migrationId: string) {
        if (
          classicFrozenBy !== migrationId ||
          (appliedMigrationId !== migrationId &&
            preserveReceipt?.migrationId !== migrationId)
        )
          throw new Error(
            "finalization requires applied migration or preservation",
          );
        retiredRoutingBy = migrationId;
      },
      async isLunoraRetired() {
        return retiredRoutingBy !== null;
      },
      async classicRecoveryReceipt() {
        return recoveryReceipt;
      },
      async importClassicRecovery(input) {
        recoveryCalls++;
        recoveryReceipt ??= {
          migrationId: input.migrationId,
          manifestHash: input.manifestHash,
          applied: true,
          seq: classic.seq,
          rootId: input.rootId,
          nodes: input.nodes.length,
        };
        return recoveryReceipt;
      },
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
      async freezeAndExportArchive(migrationId: string, now: number) {
        const snapshot = await this.freezeAndExport(migrationId, now);
        return {
          version: 1,
          userId: USER_ID,
          exportedAt: snapshot.exportedAt,
          snapshot,
          raw: {
            nodes: snapshot.nodes.map((row) => ({
              ...clone(row),
              _id: row.id,
              _creationTime: row.createdAt,
            })),
            dailyIndex: snapshot.dailyIndex.map((row) => ({
              ...clone(row),
              _id: `daily-${row.key}`,
              _creationTime: row.touchedAt,
            })),
            tagColors: snapshot.tagColors.map((row) => ({
              ...clone(row),
              _id: `tag-${row.tag}`,
              _creationTime: 1,
            })),
            savedQueries: snapshot.savedQueries.map((row) => ({
              ...clone(row),
              _id: row.id,
              _creationTime: row.createdAt,
            })),
            migrateState: snapshot.migrateState.map((row) => ({
              ...clone(row),
              _id: `migration-${row.userId}`,
              _creationTime: 1,
            })),
          },
        } satisfies LunoraRetirementArchive;
      },
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
    get preserveCalls() {
      return preserveCalls;
    },
    get recoveryCalls() {
      return recoveryCalls;
    },
    get retiredRoutingBy() {
      return retiredRoutingBy;
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
    const unsupportedClassic = fixture();
    // SAFETY: this deliberately passes an impossible future version to exercise the decoder boundary.
    unsupportedClassic.backend.replaceClassic({
      ...classicSnapshot(),
      version: 3 as OutlineSnapshot["version"],
    });
    await expect(
      retirementDiagnostic(
        unsupportedClassic.env,
        USER_ID,
        unsupportedClassic.backend.backends,
      ),
    ).rejects.toThrow("retirement diagnostic snapshot schema rejected");
    expect(unsupportedClassic.db.record).toBeNull();
    expect(unsupportedClassic.bucket.objects.size).toBe(0);

    const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
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
  it("atomically installs experimental nodes with detached Classic alternatives only when requested", async () => {
    const f = fixture();
    const original = clone(f.backend.classic);
    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "migrate-with-recovery",
      f.backend.backends,
    );
    expect(result.state, result.failureReason ?? "").toBe("completed");
    expect(result.result).toBe("migrated-with-classic-recovery");
    expect(result.policy).toBe("experimental-primary-recovery-v1");
    expect(f.backend.classic.nodes[0]).toEqual(node("lunora"));
    const root = f.backend.classic.nodes.find(
      (row) => row.text === "Recovered Classic content",
    );
    expect(root?.prevSiblingId).toBe("lunora");
    const recovered = f.backend.classic.nodes.find(
      (row) => row.text === "classic",
    );
    expect(recovered?.id).not.toBe("classic");
    expect(recovered?.parentId).not.toBeNull();
    expect(JSON.parse(result.counts ?? "{}").recovery).toMatchObject({
      classicOnly: 1,
      copies: 4,
    });
    expect(JSON.stringify(result)).not.toContain("Recovered Classic content");
    expect(
      JSON.parse(
        new TextDecoder().decode(
          f.bucket.objects.get(result.classicSnapshotKey!)!,
        ),
      ).nodes,
    ).toEqual(original.nodes);
    expect(f.backend.restoreCalls).toBe(1);
    expect(f.backend.recoveryCalls).toBe(0); // Copies are in the replacement transaction, not a second import.
    expect(f.backend.classicFrozenBy).toBeNull();
    expect(f.backend.lunoraStatus).toBe("retired");
    const edited = {
      ...clone(f.backend.classic),
      nodes: [
        {
          ...node("lunora"),
          text: "new live edit after deleting the recovery folder",
        },
      ],
    };
    f.backend.replaceClassic(edited);
    await runRetirementOperation(f.env, USER_ID, "retry", f.backend.backends);
    expect(f.backend.classic).toEqual(edited);
    expect(f.backend.restoreCalls).toBe(1);
  });

  it("reuses persisted copy ids after rollback and rejects a changed recovery manifest", async () => {
    const f = fixture({ failMarkRetired: true });
    const first = await runRetirementOperation(
      f.env,
      USER_ID,
      "migrate-with-recovery",
      f.backend.backends,
    );
    expect(first.state).toBe("rolled-back");
    const key = first.recoveryManifestKey!;
    const bytes = f.bucket.objects.get(key)!;
    const manifest = JSON.parse(new TextDecoder().decode(bytes));
    const again = await runRetirementOperation(
      f.env,
      USER_ID,
      "retry",
      f.backend.backends,
    );
    expect(again.state).toBe("rolled-back");
    expect(again.recoveryManifestHash).toBe(first.recoveryManifestHash);
    expect(f.bucket.objects.get(key)).toEqual(bytes);
    f.bucket.objects.set(
      key,
      new TextEncoder().encode(
        JSON.stringify({ ...manifest, createdAt: manifest.createdAt + 1 }),
      ),
    );
    const restores = f.backend.restoreCalls;
    const rejected = await runRetirementOperation(
      f.env,
      USER_ID,
      "retry",
      f.backend.backends,
    );
    expect(rejected.failureReason).toContain("manifest hash changed");
    expect(f.backend.restoreCalls).toBe(restores);
    expect(f.backend.classic.nodes).toEqual([node("classic")]);
  });

  it("rejects changing migration policy after an ordinary migration completed", async () => {
    const f = fixture();
    await runRetirementOperation(f.env, USER_ID, "migrate", f.backend.backends);
    const before = clone(f.backend.classic);
    await expect(
      runRetirementOperation(
        f.env,
        USER_ID,
        "migrate-with-recovery",
        f.backend.backends,
      ),
    ).rejects.toThrow("new, unmodified automatic migration");
    expect(f.backend.classic).toEqual(before);
    expect(f.backend.restoreCalls).toBe(1);
    expect(f.db.record?.activeOperationId).toBeNull();
  });

  async function preserveClassicFixture() {
    const f = fixture();
    const current = classicSnapshot();
    const before = {
      ...current,
      kv: current.kv.map((row) => ({
        ...row,
        value: '{"id":"lunora-beta","enabled":false}',
      })),
    };
    f.backend.replaceClassic(before);
    const completed = await runRetirementOperation(
      f.env,
      USER_ID,
      "preserve-classic",
      f.backend.backends,
    );
    expect(completed.failureReason).toBeNull();
    expect(completed.state).toBe("completed");
    expect(completed.policy).toBe("preserve-classic-v1");
    expect(f.backend.classic).toEqual(before);
    expect(f.backend.retiredRoutingBy).toBe(completed.migrationId);
    return { ...f, before, completed };
  }

  it("audits only when retrying completed preserve-Classic retirement", async () => {
    const f = await preserveClassicFixture();
    const backendState = {
      classic: clone(f.backend.classic),
      freezes: f.backend.classicFreezeCalls,
      preserves: f.backend.preserveCalls,
      routing: f.backend.retiredRoutingBy,
      lunora: await f.backend.backends.lunora.inspect(),
    };
    const attempts = f.db.attempts;

    const retried = await runRetirementOperation(
      f.env,
      USER_ID,
      "retry",
      f.backend.backends,
    );

    expect(retried.state).toBe("completed");
    expect(f.db.attempts).toBe(attempts + 1);
    expect(f.backend.classic).toEqual(backendState.classic);
    expect(f.backend.classicFreezeCalls).toBe(backendState.freezes);
    expect(f.backend.preserveCalls).toBe(backendState.preserves);
    expect(f.backend.retiredRoutingBy).toBe(backendState.routing);
    expect(await f.backend.backends.lunora.inspect()).toEqual(
      backendState.lunora,
    );
  });

  it.each(["migrate", "restore"] as const)(
    "forbids %s after preserve-Classic policy is chosen",
    async (operation) => {
      const f = await preserveClassicFixture();
      const before = clone(f.backend.classic);
      await expect(
        runRetirementOperation(f.env, USER_ID, operation, f.backend.backends),
      ).rejects.toThrow(
        "replacement and rollback operations cannot overwrite chosen Classic",
      );
      expect(f.backend.classic).toEqual(before);
      expect(f.backend.restoreCalls).toBe(0);
    },
  );

  it("requires the exact reviewed recovery manifest hash", async () => {
    const f = await preserveClassicFixture();
    await expect(
      runRetirementOperation(
        f.env,
        USER_ID,
        "recover-classic",
        f.backend.backends,
        "wrong-manifest-hash",
      ),
    ).rejects.toThrow(
      "recovery requires completed preservation and exact reviewed manifest hash",
    );
    expect(f.backend.recoveryCalls).toBe(0);

    const recovered = await runRetirementOperation(
      f.env,
      USER_ID,
      "recover-classic",
      f.backend.backends,
      f.completed.recoveryManifestHash!,
    );
    expect(recovered.result).toBe("classic-recovery-imported");
    expect(f.backend.recoveryCalls).toBe(1);
  });

  it("installs both write fences before restore and leaves only Lunora retired", async () => {
    const f = fixture();
    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "migrate",
      f.backend.backends,
    );

    expect(result.state, result.failureReason ?? "").toBe("completed");
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

describe("guarded Classic link repair", () => {
  function repairFixture(options?: Parameters<typeof fixture>[0]) {
    const f = fixture(options);
    f.backend.replaceClassic({
      ...classicSnapshot(),
      nodes: [
        node("a"),
        { ...node("b"), text: "KEEP_PRIVATE_PAYLOAD", completed: true },
      ],
      kv: [
        {
          collection: "daily-index",
          key: "day",
          value: '{"key":"day","nodeId":"retained-claim"}',
          updatedAt: 12,
        },
      ],
    });
    f.backend.replaceLunora({
      ...lunoraSnapshot(),
      nodes: [],
      migrateState: [],
    });
    return f;
  }

  it("previews without writing, then archives and repairs all payloads and side data", async () => {
    const f = repairFixture();
    const original = clone(f.backend.classic);
    const preview = await retirementRepairPreview(
      f.env,
      USER_ID,
      f.backend.backends,
    );
    expect(preview).toMatchObject({
      eligible: true,
      counts: { nodes: 2, parentLinks: 0, siblingLinks: 1 },
    });
    expect(f.db.record).toBeNull();
    expect(f.db.attempts).toBe(0);
    expect(f.bucket.objects.size).toBe(0);
    expect(f.backend.classicFreezeCalls).toBe(0);
    expect(JSON.stringify(preview)).not.toContain("KEEP_PRIVATE_PAYLOAD");
    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "repair-classic",
      f.backend.backends,
      preview.approvalHash,
    );
    expect(result).toMatchObject({
      state: "completed",
      policy: "classic-link-repair-v1",
      result: "classic-links-repaired",
      activeOperationId: null,
      failureReason: null,
    });
    expect(f.backend.classic.nodes).toEqual(
      original.nodes.map((row) =>
        row.id === "b" ? { ...row, prevSiblingId: "a" } : row,
      ),
    );
    expect(
      f.backend.classic.kv.filter((r) => r.collection !== "account-prefs"),
    ).toEqual([...original.kv]);
    expect(JSON.parse(result.counts ?? "{}").repair).toEqual({
      nodes: 2,
      parentLinks: 0,
      siblingLinks: 1,
    });
    expect(result.recoveryManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.bucket.objects.size).toBe(4);
    expect(f.backend.classicFrozenBy).toBeNull();
    expect(f.backend.lunoraStatus).toBe("retired");
  });

  it("rejects a missing approval before creating an audit record", async () => {
    const f = repairFixture();
    await expect(
      runRetirementOperation(
        f.env,
        USER_ID,
        "repair-classic",
        f.backend.backends,
      ),
    ).rejects.toThrow("approved preview hash");
    expect(f.db.record).toBeNull();
    expect(f.backend.restoreCalls).toBe(0);
  });

  it("rejects edits between preview and freeze without replacing them", async () => {
    const f = repairFixture();
    const preview = await retirementRepairPreview(
      f.env,
      USER_ID,
      f.backend.backends,
    );
    const edited = {
      ...clone(f.backend.classic),
      seq: 9,
      nodes: f.backend.classic.nodes.map((n) => ({ ...n, text: "fresh edit" })),
    };
    f.backend.replaceClassic(edited);
    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "repair-classic",
      f.backend.backends,
      preview.approvalHash,
    );
    expect(result.state).toBe("failed");
    expect(result.failureReason).toContain("stale");
    expect(f.backend.restoreCalls).toBe(0);
    expect(f.backend.classic).toEqual(edited);
    expect(f.backend.classicFrozenBy).toBeNull();
    expect(f.backend.lunoraStatus).toBeNull();
  });

  it("rejects enabled preference and experimental side data even with zero experimental nodes", async () => {
    for (const conflict of ["enabled", "side-data"] as const) {
      const f = repairFixture();
      if (conflict === "enabled")
        f.backend.replaceClassic({
          ...f.backend.classic,
          kv: classicSnapshot().kv,
        });
      else
        f.backend.replaceLunora({
          ...lunoraSnapshot(),
          nodes: [],
          migrateState: [],
          tagColors: [{ userId: USER_ID, tag: "private", color: "red" }],
        });
      const before = clone(f.backend.classic);
      expect(
        await retirementRepairPreview(f.env, USER_ID, f.backend.backends),
      ).toEqual({ userId: USER_ID, eligible: false });
      const result = await runRetirementOperation(
        f.env,
        USER_ID,
        "repair-classic",
        f.backend.backends,
        "a".repeat(64),
      );
      expect(result.state).toBe("failed");
      expect(f.backend.restoreCalls).toBe(0);
      expect(f.backend.classic).toEqual(before);
    }
  });

  it("rolls back the exact original graph on verification or retirement failure", async () => {
    const f = repairFixture({ failMarkRetired: true });
    const original = clone(f.backend.classic);
    const preview = await retirementRepairPreview(
      f.env,
      USER_ID,
      f.backend.backends,
    );
    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "repair-classic",
      f.backend.backends,
      preview.approvalHash,
    );
    expect(result.state).toBe("rolled-back");
    expect(f.backend.classic).toEqual(original);
    expect(f.backend.classicFrozenBy).toBeNull();
    expect(f.backend.lunoraStatus).toBeNull();
  });

  it("does not overwrite later edits on a completed retry", async () => {
    const f = repairFixture();
    const preview = await retirementRepairPreview(
      f.env,
      USER_ID,
      f.backend.backends,
    );
    await runRetirementOperation(
      f.env,
      USER_ID,
      "repair-classic",
      f.backend.backends,
      preview.approvalHash,
    );
    const edited = {
      ...clone(f.backend.classic),
      nodes: [{ ...f.backend.classic.nodes[0]!, text: "later edit" }],
    };
    f.backend.replaceClassic(edited);
    const result = await runRetirementOperation(
      f.env,
      USER_ID,
      "retry",
      f.backend.backends,
    );
    expect(result.state).toBe("completed");
    expect(f.backend.classic).toEqual(edited);
    expect(f.backend.restoreCalls).toBe(1);
  });
});
