import { Schema } from "effect";

import type { Node } from "../src/data/wire-schema";
import type { OutlineSnapshot } from "./backup";
import type { RetirementStatus, UserOutlineDO } from "./outline-do";

import { OutlineSnapshotSchema } from "./backup";
import { resolveUserId } from "./identity";
import { createLunoraRetirementClient } from "./lunora-mcp-store";
import {
  LunoraRetirementSnapshotSchema,
  buildClassicTarget,
  classicSnapshotsEquivalent,
  classifyRetirement,
  disableLunoraPreference,
  isLunoraPreferenceEnabled,
  retirementSnapshotKey,
  sha256Hex,
  snapshotCounts,
  validateClassicSnapshot,
  validateLunoraSnapshot,
  type LunoraRetirementSnapshot,
  type RetirementClassification,
} from "./lunora-retirement";

type RetirementEnv = {
  DB: D1Database;
  BACKUPS: R2Bucket;
  USER_OUTLINE: DurableObjectNamespace<UserOutlineDO>;
  SHARD: Parameters<typeof createLunoraRetirementClient>[0]["SHARD"];
  OWNER_USER_ID?: string;
};

export interface RetirementBackends {
  classic: {
    exportSnapshot(): Promise<OutlineSnapshot>;
    freezeAndExportRetirement(migrationId: string): Promise<OutlineSnapshot>;
    getNodes(): Promise<readonly Node[]>;
    releaseRetirementFreeze(migrationId: string): Promise<void>;
    restorePreRetirementSnapshot(data: {
      migrationId: string;
      nodes: readonly Node[];
      kv: OutlineSnapshot["kv"];
    }): Promise<{ nodes: number; kv: number }>;
    restoreRetirementSnapshot(data: {
      migrationId: string;
      nodes: readonly Node[];
      kv: OutlineSnapshot["kv"];
    }): Promise<{ applied: boolean; nodes: number; kv: number }>;
    retirementStatus(): Promise<RetirementStatus>;
  };
  lunora: {
    inspect(): Promise<{
      retirement: {
        migrationId: string;
        status: string;
        updatedAt: number;
      } | null;
      snapshot: LunoraRetirementSnapshot;
    }>;
    freezeAndExport(
      migrationId: string,
      now: number,
    ): Promise<LunoraRetirementSnapshot>;
    releaseFreeze(migrationId: string): Promise<{ released: boolean }>;
    markRetired(
      migrationId: string,
      now: number,
    ): Promise<{ retired: boolean }>;
  };
}

export type RetirementOperation = "dry-run" | "migrate" | "retry" | "restore";

export interface RetirementRecord {
  userId: string;
  migrationId: string;
  state: string;
  classification: RetirementClassification | null;
  result: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  classicSnapshotKey: string | null;
  classicSnapshotHash: string | null;
  lunoraSnapshotKey: string | null;
  lunoraSnapshotHash: string | null;
  counts: string | null;
  failureReason: string | null;
}

interface AttemptRecord {
  id: number;
  migrationId: string;
  userId: string;
  attemptedAt: number;
  operation: string;
  state: string;
  result: string | null;
  failureReason: string | null;
}

function classicStub(env: RetirementEnv, userId: string) {
  return env.USER_OUTLINE.get(
    env.USER_OUTLINE.idFromName(resolveUserId(userId, env)),
  );
}

function retirementBackends(
  env: RetirementEnv,
  userId: string,
): RetirementBackends {
  return {
    classic: classicStub(env, userId),
    lunora: createLunoraRetirementClient(env, userId),
  };
}

async function getRecord(
  env: RetirementEnv,
  userId: string,
): Promise<RetirementRecord | null> {
  return env.DB.prepare("SELECT * FROM lunora_retirement WHERE userId = ?")
    .bind(userId)
    .first<RetirementRecord>();
}

async function ensureRecord(
  env: RetirementEnv,
  userId: string,
  now: number,
): Promise<RetirementRecord> {
  const migrationId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO lunora_retirement
      (userId, migrationId, state, startedAt, updatedAt)
     VALUES (?, ?, 'created', ?, ?)`,
  )
    .bind(userId, migrationId, now, now)
    .run();
  const record = await getRecord(env, userId);
  if (!record) throw new Error("failed to create retirement record");
  return record;
}

async function updateRecord(
  env: RetirementEnv,
  record: RetirementRecord,
  patch: Partial<RetirementRecord>,
): Promise<RetirementRecord> {
  const next = { ...record, ...patch, updatedAt: Date.now() };
  await env.DB.prepare(
    `UPDATE lunora_retirement SET
      state = ?, classification = ?, result = ?, updatedAt = ?, completedAt = ?,
      classicSnapshotKey = ?, classicSnapshotHash = ?, lunoraSnapshotKey = ?,
      lunoraSnapshotHash = ?, counts = ?, failureReason = ?
     WHERE userId = ? AND migrationId = ?`,
  )
    .bind(
      next.state,
      next.classification,
      next.result,
      next.updatedAt,
      next.completedAt,
      next.classicSnapshotKey,
      next.classicSnapshotHash,
      next.lunoraSnapshotKey,
      next.lunoraSnapshotHash,
      next.counts,
      next.failureReason,
      next.userId,
      next.migrationId,
    )
    .run();
  return next;
}

async function appendAttempt(
  env: RetirementEnv,
  record: RetirementRecord,
  operation: RetirementOperation,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lunora_retirement_attempt
      (migrationId, userId, attemptedAt, operation, state, result, failureReason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      record.migrationId,
      record.userId,
      Date.now(),
      operation,
      record.state,
      record.result,
      record.failureReason,
    )
    .run();
}

function failureReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function readVerifiedObject<A>(
  env: RetirementEnv,
  key: string,
  schema: Schema.ConstraintDecoder<A>,
): Promise<{ value: A; hash: string }> {
  const object = await env.BACKUPS.get(key);
  if (!object) throw new Error(`missing retirement snapshot ${key}`);
  const bytes = await object.arrayBuffer();
  const hash = await sha256Hex(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`retirement snapshot ${key} is not JSON`);
  }
  return { value: Schema.decodeUnknownSync(schema)(raw), hash };
}

async function storeImmutable<A>(
  env: RetirementEnv,
  key: string,
  value: A,
  schema: Schema.ConstraintDecoder<A>,
): Promise<{ value: A; hash: string }> {
  const existing = await env.BACKUPS.get(key);
  if (!existing) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    await env.BACKUPS.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    });
    const readback = await readVerifiedObject(env, key, schema);
    if (readback.hash !== (await sha256Hex(bytes))) {
      throw new Error(
        `retirement snapshot ${key} failed write-read hash verification`,
      );
    }
    return readback;
  }
  return readVerifiedObject(env, key, schema);
}

async function inspect(
  env: RetirementEnv,
  userId: string,
  backends: RetirementBackends,
): Promise<{
  classic: OutlineSnapshot;
  lunora: LunoraRetirementSnapshot;
  classification: RetirementClassification;
  reasons: { classic?: string; lunora?: string };
}> {
  const classic = await backends.classic.exportSnapshot();
  const raw = await backends.lunora.inspect();
  const lunora = Schema.decodeUnknownSync(LunoraRetirementSnapshotSchema)(
    raw.snapshot,
  );
  const classicValidation = validateClassicSnapshot(classic);
  const lunoraValidation = validateLunoraSnapshot(lunora, userId);
  return {
    classic,
    lunora,
    classification: classifyRetirement({
      preferenceEnabled: isLunoraPreferenceEnabled(classic),
      classic: classicValidation,
      lunora: lunoraValidation,
      lunoraNodeCount: lunora.nodes.length,
    }),
    reasons: {
      classic: classicValidation.ok ? undefined : classicValidation.reason,
      lunora: lunoraValidation.ok ? undefined : lunoraValidation.reason,
    },
  };
}

async function rollback(
  env: RetirementEnv,
  record: RetirementRecord,
  backends: RetirementBackends,
  allowRetired = false,
): Promise<RetirementRecord> {
  if (!record.classicSnapshotKey || !record.classicSnapshotHash) {
    throw new Error("classic retirement backup is unavailable");
  }
  const backup = await readVerifiedObject(
    env,
    record.classicSnapshotKey,
    OutlineSnapshotSchema,
  );
  if (backup.hash !== record.classicSnapshotHash) {
    throw new Error("classic retirement backup hash mismatch");
  }
  const stub = backends.classic;
  const lunoraClient = backends.lunora;
  const lunoraStatus = (await lunoraClient.inspect()).retirement;
  const isRetired = lunoraStatus?.status === "retired";
  if (isRetired && !allowRetired) {
    throw new Error("Lunora retired before rollback completed");
  }
  const target = isRetired
    ? {
        nodes: backup.value.nodes,
        kv: disableLunoraPreference(backup.value.kv, record.startedAt),
      }
    : backup.value;
  await stub.restorePreRetirementSnapshot({
    migrationId: record.migrationId,
    nodes: target.nodes,
    kv: target.kv,
  });
  const restored = await stub.exportSnapshot();
  if (!classicSnapshotsEquivalent(restored, target)) {
    throw new Error("classic rollback verification failed");
  }
  if (!isRetired) {
    await lunoraClient.releaseFreeze(record.migrationId);
  }
  await stub.releaseRetirementFreeze(record.migrationId);
  return updateRecord(env, record, {
    state: "rolled-back",
    result: "failed-rolled-back",
  });
}

async function migrate(
  env: RetirementEnv,
  initial: RetirementRecord,
  backends: RetirementBackends,
): Promise<RetirementRecord> {
  if (initial.state === "completed") return initial;
  let record = initial;
  const stub = backends.classic;
  const lunoraClient = backends.lunora;
  try {
    const classicExport = await stub.freezeAndExportRetirement(
      record.migrationId,
    );
    const classicKey = retirementSnapshotKey(
      record.userId,
      record.migrationId,
      "classic",
    );
    const classicBackup = await storeImmutable(
      env,
      classicKey,
      classicExport,
      OutlineSnapshotSchema,
    );
    if (
      record.classicSnapshotHash &&
      record.classicSnapshotHash !== classicBackup.hash
    ) {
      throw new Error("classic retirement backup hash changed");
    }
    record = await updateRecord(env, record, {
      state: "classic-backed-up",
      classicSnapshotKey: classicKey,
      classicSnapshotHash: classicBackup.hash,
    });

    const lunoraExport = await lunoraClient.freezeAndExport(
      record.migrationId,
      Date.now(),
    );
    const lunoraKey = retirementSnapshotKey(
      record.userId,
      record.migrationId,
      "lunora",
    );
    const lunoraBackup = await storeImmutable(
      env,
      lunoraKey,
      lunoraExport,
      LunoraRetirementSnapshotSchema,
    );
    if (
      record.lunoraSnapshotHash &&
      record.lunoraSnapshotHash !== lunoraBackup.hash
    ) {
      throw new Error("Lunora retirement backup hash changed");
    }
    record = await updateRecord(env, record, {
      state: "backups-verified",
      lunoraSnapshotKey: lunoraKey,
      lunoraSnapshotHash: lunoraBackup.hash,
      counts: JSON.stringify(snapshotCounts(lunoraBackup.value)),
    });

    const classicValidation = validateClassicSnapshot(classicBackup.value);
    const lunoraValidation = validateLunoraSnapshot(
      lunoraBackup.value,
      record.userId,
    );
    const classification = classifyRetirement({
      preferenceEnabled: isLunoraPreferenceEnabled(classicBackup.value),
      classic: classicValidation,
      lunora: lunoraValidation,
      lunoraNodeCount: lunoraBackup.value.nodes.length,
    });
    record = await updateRecord(env, record, { classification });
    if (classification !== "eligible") {
      await lunoraClient.releaseFreeze(record.migrationId);
      await stub.releaseRetirementFreeze(record.migrationId);
      return updateRecord(env, record, {
        state: "classified",
        result: "skipped",
        failureReason: !classicValidation.ok
          ? classicValidation.reason
          : !lunoraValidation.ok
            ? lunoraValidation.reason
            : classification,
      });
    }

    const target = buildClassicTarget(
      classicBackup.value,
      lunoraBackup.value,
      record.startedAt,
    );
    await stub.restoreRetirementSnapshot({
      migrationId: record.migrationId,
      ...target,
    });
    record = await updateRecord(env, record, { state: "classic-restored" });

    const verified = await stub.exportSnapshot();
    const targetSnapshot = { nodes: target.nodes, kv: target.kv };
    if (!classicSnapshotsEquivalent(verified, targetSnapshot)) {
      throw new Error(
        "restored classic snapshot is not semantically equivalent",
      );
    }
    if (
      target.nodes[0] &&
      !(await stub.getNodes()).some((n) => n.id === target.nodes[0]!.id)
    ) {
      throw new Error("representative classic read failed");
    }
    record = await updateRecord(env, record, { state: "classic-verified" });

    await lunoraClient.markRetired(record.migrationId, Date.now());
    record = await updateRecord(env, record, { state: "lunora-retired" });
    await stub.releaseRetirementFreeze(record.migrationId);
    return updateRecord(env, record, {
      state: "completed",
      result: "migrated",
      completedAt: Date.now(),
      failureReason: null,
    });
  } catch (error) {
    const reason = failureReason(error);
    try {
      const status = await stub.retirementStatus();
      const lunoraStatus = (await lunoraClient.inspect()).retirement;
      if (
        record.state === "lunora-retired" ||
        lunoraStatus?.status === "retired"
      ) {
        record = await updateRecord(env, record, {
          state: "uncertain",
          result: "operator-recovery-required",
          failureReason: reason,
        });
      } else if (status.appliedMigrationId === record.migrationId) {
        record = await rollback(env, record, backends);
        record = await updateRecord(env, record, { failureReason: reason });
      } else {
        await lunoraClient.releaseFreeze(record.migrationId);
        await stub.releaseRetirementFreeze(record.migrationId);
        record = await updateRecord(env, record, {
          state: "failed",
          result: "failed-before-restore",
          failureReason: reason,
        });
      }
    } catch (recoveryError) {
      record = await updateRecord(env, record, {
        state: "uncertain",
        result: "operator-recovery-required",
        failureReason: `${reason}; recovery: ${failureReason(recoveryError)}`,
      });
    }
    return record;
  }
}

export async function runRetirementOperation(
  env: RetirementEnv,
  userId: string,
  operation: RetirementOperation,
  backends = retirementBackends(env, userId),
): Promise<RetirementRecord & { dryRun?: unknown }> {
  let record = await ensureRecord(env, userId, Date.now());
  if (operation === "dry-run") {
    const report = await inspect(env, userId, backends);
    record = await updateRecord(env, record, {
      state: "classified",
      classification: report.classification,
      result: "dry-run",
      counts: JSON.stringify(snapshotCounts(report.lunora)),
      failureReason: report.reasons.classic ?? report.reasons.lunora ?? null,
    });
    await appendAttempt(env, record, operation);
    return {
      ...record,
      dryRun: {
        classification: report.classification,
        counts: snapshotCounts(report.lunora),
        reasons: report.reasons,
      },
    };
  }
  if (operation === "restore") {
    try {
      await backends.classic.freezeAndExportRetirement(record.migrationId);
      record = await rollback(env, record, backends, true);
      record = await updateRecord(env, record, {
        state: "restored-pre-migration",
        result: "restored",
        failureReason: null,
      });
    } catch (error) {
      record = await updateRecord(env, record, {
        state: "uncertain",
        result: "operator-recovery-required",
        failureReason: failureReason(error),
      });
    }
    await appendAttempt(env, record, operation);
    return record;
  }
  record = await migrate(env, record, backends);
  await appendAttempt(env, record, operation);
  return record;
}

export async function retirementReport(
  env: RetirementEnv,
  userId?: string,
): Promise<{ records: RetirementRecord[]; attempts: AttemptRecord[] }> {
  const records = userId
    ? [await getRecord(env, userId)].filter(
        (row): row is RetirementRecord => row !== null,
      )
    : (
        await env.DB.prepare(
          "SELECT * FROM lunora_retirement ORDER BY userId",
        ).all<RetirementRecord>()
      ).results;
  const attempts = userId
    ? (
        await env.DB.prepare(
          "SELECT * FROM lunora_retirement_attempt WHERE userId = ? ORDER BY id",
        )
          .bind(userId)
          .all<AttemptRecord>()
      ).results
    : (
        await env.DB.prepare(
          "SELECT * FROM lunora_retirement_attempt ORDER BY id",
        ).all<AttemptRecord>()
      ).results;
  return { records, attempts };
}

export async function retirementPopulation(
  env: RetirementEnv,
): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT id FROM "user" ORDER BY id',
  ).all<{ id: string }>();
  return results.map((row) => row.id);
}
