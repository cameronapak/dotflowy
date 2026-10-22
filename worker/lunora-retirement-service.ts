import { Schema } from "effect";

import type { Node } from "../src/data/wire-schema";
import type { OutlineSnapshot } from "./backup";
import type { RetirementStatus, UserOutlineDO } from "./outline-do";

import { OutlineSnapshotSchema, isSupportedSnapshotVersion } from "./backup";
import { resolveUserId } from "./identity";
import { createLunoraRetirementClient } from "./lunora-mcp-store";
import {
  ClassicRecoveryManifestSchema,
  ExperimentalPrimaryRecoveryManifestSchema,
  planClassicRecovery,
  planExperimentalPrimaryRecovery,
} from "./lunora-recovery";
import {
  ClassicLinkRepairManifestSchema,
  LunoraRetirementArchiveSchema,
  LunoraRetirementSnapshotSchema,
  RETIREMENT_SNAPSHOT_VERSION,
  buildClassicTarget,
  classicSnapshotsEquivalent,
  classicLinkRepairSourceHash,
  classifyRetirement,
  compareRetirementSnapshots,
  disableLunoraPreference,
  isLunoraPreferenceEnabled,
  planClassicLinkRepair,
  retirementSnapshotKey,
  sha256Hex,
  snapshotCounts,
  validateClassicSnapshot,
  validateClassicLinkRepairSources,
  validateLunoraSnapshot,
  validateLunoraRetirementArchive,
  validateNodeGraph,
  type LunoraRetirementArchive,
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
    preserveClassicReceipt(): Promise<
      ReturnType<UserOutlineDO["preserveClassicReceipt"]>
    >;
    preserveClassicRetirement(
      data: Parameters<UserOutlineDO["preserveClassicRetirement"]>[0],
    ): Promise<ReturnType<UserOutlineDO["preserveClassicRetirement"]>>;
    finalizeRetirementRouting(migrationId: string): Promise<void>;
    isLunoraRetired(): Promise<boolean>;
    classicRecoveryReceipt(): Promise<
      ReturnType<UserOutlineDO["classicRecoveryReceipt"]>
    >;
    importClassicRecovery(
      data: Parameters<UserOutlineDO["importClassicRecovery"]>[0],
    ): Promise<ReturnType<UserOutlineDO["importClassicRecovery"]>>;
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
    freezeAndExportArchive(
      migrationId: string,
      now: number,
    ): Promise<LunoraRetirementArchive>;
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

export type RetirementOperation =
  | "dry-run"
  | "migrate"
  | "migrate-with-recovery"
  | "repair-classic"
  | "retry"
  | "restore"
  | "preserve-classic"
  | "recover-classic";

export interface RetirementRecord {
  userId: string;
  migrationId: string;
  policy:
    | "lunora-to-classic-v1"
    | "preserve-classic-v1"
    | "classic-link-repair-v1"
    | "experimental-primary-recovery-v1";
  recoveryManifestKey: string | null;
  recoveryManifestHash: string | null;
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
  activeOperationId: string | null;
  activeOperationStartedAt: number | null;
}

export class RetirementOperationInProgress extends Schema.TaggedError<RetirementOperationInProgress>()(
  "RetirementOperationInProgress",
  { userId: Schema.String },
) {}

export class RetirementOperationRejected extends Schema.TaggedError<RetirementOperationRejected>()(
  "RetirementOperationRejected",
  { message: Schema.String },
) {}

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

interface RollbackProgress {
  restoreStarted: boolean;
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
      lunoraSnapshotHash = ?, counts = ?, failureReason = ?, recoveryManifestKey = ?, recoveryManifestHash = ?
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
      next.recoveryManifestKey,
      next.recoveryManifestHash,
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
  const decoded = Schema.decodeUnknownOption(schema)(raw);
  if (decoded._tag === "None")
    throw new Error(`retirement snapshot ${key} schema rejected`);
  return { value: decoded.value, hash };
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

function lunoraSnapshotsEquivalent(
  left: LunoraRetirementSnapshot,
  right: LunoraRetirementSnapshot,
): boolean {
  const rows = (values: readonly unknown[]) =>
    values.map((row) => JSON.stringify(row)).sort();
  const normalize = (snapshot: LunoraRetirementSnapshot) => ({
    version: snapshot.version,
    userId: snapshot.userId,
    nodes: rows(snapshot.nodes),
    dailyIndex: rows(snapshot.dailyIndex),
    tagColors: rows(snapshot.tagColors),
    savedQueries: rows(snapshot.savedQueries),
    migrateState: rows(snapshot.migrateState),
  });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function rawArchivesEquivalent(
  left: LunoraRetirementArchive,
  right: LunoraRetirementArchive,
): boolean {
  const rows = (raw: LunoraRetirementArchive["raw"]) =>
    Object.entries(raw).map(([table, values]) => [
      table,
      values.map((value) => JSON.stringify(value)).sort(),
    ]);
  return JSON.stringify(rows(left.raw)) === JSON.stringify(rows(right.raw));
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
  progress?: RollbackProgress,
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
  if (progress) progress.restoreStarted = true;
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
  approvedSourceHash?: string,
): Promise<RetirementRecord> {
  if (initial.state === "completed") return initial;
  let record = initial;
  const stub = backends.classic;
  const lunoraClient = backends.lunora;
  try {
    const classicExport = Schema.decodeUnknownSync(OutlineSnapshotSchema)(
      await stub.freezeAndExportRetirement(record.migrationId),
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
    const classicStatus = await stub.retirementStatus();
    if (
      classicStatus.appliedMigrationId !== record.migrationId &&
      !classicSnapshotsEquivalent(classicBackup.value, classicExport)
    ) {
      throw new Error(
        "classic content changed since the immutable backup; operator review required",
      );
    }
    record = await updateRecord(env, record, {
      state: "classic-backed-up",
      classicSnapshotKey: classicKey,
      classicSnapshotHash: classicBackup.hash,
    });

    const lunoraExport = Schema.decodeUnknownSync(
      LunoraRetirementSnapshotSchema,
    )(await lunoraClient.freezeAndExport(record.migrationId, Date.now()));
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
    if (!lunoraSnapshotsEquivalent(lunoraBackup.value, lunoraExport)) {
      throw new Error(
        "Lunora content changed since the immutable backup; operator review required",
      );
    }
    // Retain exact source documents as well as the strict replacement projection.
    const currentArchive = Schema.decodeUnknownSync(
      LunoraRetirementArchiveSchema,
    )(
      await lunoraClient.freezeAndExportArchive(
        record.migrationId,
        record.startedAt,
      ),
    );
    const archive = await storeImmutable(
      env,
      `${lunoraKey}.archive`,
      currentArchive,
      LunoraRetirementArchiveSchema,
    );
    if (
      !validateLunoraRetirementArchive(archive.value, record.userId).ok ||
      !lunoraSnapshotsEquivalent(archive.value.snapshot, lunoraBackup.value) ||
      !validateLunoraRetirementArchive(currentArchive, record.userId).ok ||
      !lunoraSnapshotsEquivalent(currentArchive.snapshot, lunoraBackup.value) ||
      !rawArchivesEquivalent(archive.value, currentArchive)
    ) {
      throw new Error(
        "raw experimental archive does not match the replacement snapshot",
      );
    }
    record = await updateRecord(env, record, {
      state: "backups-verified",
      lunoraSnapshotKey: lunoraKey,
      lunoraSnapshotHash: lunoraBackup.hash,
      counts: JSON.stringify({
        ...snapshotCounts(lunoraBackup.value),
        rawArchiveHash: archive.hash,
      }),
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
    if (
      classification !== "eligible" &&
      record.policy !== "classic-link-repair-v1"
    ) {
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

    let target;
    if (record.policy === "classic-link-repair-v1") {
      validateClassicLinkRepairSources(
        classicBackup.value,
        lunoraBackup.value,
        record.userId,
      );
      const plan = planClassicLinkRepair(classicBackup.value);
      const sourceHash = await classicLinkRepairSourceHash(
        record.userId,
        classicBackup.value,
        lunoraBackup.value,
      );
      const key = `${classicKey}.link-repair`;
      const retained = await env.BACKUPS.get(key);
      if (
        (!retained && approvedSourceHash !== sourceHash) ||
        (approvedSourceHash !== undefined && approvedSourceHash !== sourceHash)
      )
        throw new Error("link repair preview is missing or stale");
      const manifest = retained
        ? await readVerifiedObject(env, key, ClassicLinkRepairManifestSchema)
        : await storeImmutable(
            env,
            key,
            ClassicLinkRepairManifestSchema.make({
              version: 1,
              policy: "classic-link-repair-v1",
              userId: record.userId,
              migrationId: record.migrationId,
              classicSnapshotHash: classicBackup.hash,
              lunoraSnapshotHash: lunoraBackup.hash,
              approvedSourceHash: sourceHash,
              ...plan,
            }),
            ClassicLinkRepairManifestSchema,
          );
      if (
        manifest.value.userId !== record.userId ||
        manifest.value.migrationId !== record.migrationId ||
        manifest.value.classicSnapshotHash !== classicBackup.hash ||
        manifest.value.lunoraSnapshotHash !== lunoraBackup.hash ||
        manifest.value.approvedSourceHash !== sourceHash ||
        (record.recoveryManifestHash &&
          record.recoveryManifestHash !== manifest.hash) ||
        !classicSnapshotsEquivalent(
          { nodes: manifest.value.nodes, kv: classicBackup.value.kv },
          { nodes: plan.nodes, kv: classicBackup.value.kv },
        )
      )
        throw new Error("link repair manifest binding rejected");
      target = {
        nodes: manifest.value.nodes,
        kv: disableLunoraPreference(classicBackup.value.kv, record.startedAt),
      };
      record = await updateRecord(env, record, {
        recoveryManifestKey: key,
        recoveryManifestHash: manifest.hash,
        counts: JSON.stringify({
          ...snapshotCounts(lunoraBackup.value),
          rawArchiveHash: archive.hash,
          repair: manifest.value.summary,
        }),
      });
    } else {
      target = buildClassicTarget(
        classicBackup.value,
        lunoraBackup.value,
        record.startedAt,
      );
    }
    if (record.policy === "experimental-primary-recovery-v1") {
      const key = `${classicKey}.experimental-primary-recovery`;
      const manifest = (await env.BACKUPS.get(key))
        ? await readVerifiedObject(
            env,
            key,
            ExperimentalPrimaryRecoveryManifestSchema,
          )
        : await storeImmutable(
            env,
            key,
            ExperimentalPrimaryRecoveryManifestSchema.make({
              ...planExperimentalPrimaryRecovery(
                classicBackup.value,
                lunoraBackup.value,
                {
                  userId: record.userId,
                  timestamp: record.startedAt,
                  newId: () => crypto.randomUUID(),
                },
              ),
              version: 1,
              userId: record.userId,
              migrationId: record.migrationId,
              createdAt: record.startedAt,
              classicSnapshotHash: classicBackup.hash,
              lunoraSnapshotHash: lunoraBackup.hash,
            }),
            ExperimentalPrimaryRecoveryManifestSchema,
          );
      if (
        record.recoveryManifestHash &&
        record.recoveryManifestHash !== manifest.hash
      )
        throw new Error("experimental-primary recovery manifest hash changed");
      record = await updateRecord(env, record, {
        recoveryManifestKey: key,
        recoveryManifestHash: manifest.hash,
        counts: JSON.stringify({
          ...snapshotCounts(lunoraBackup.value),
          rawArchiveHash: archive.hash,
          recovery: {
            ...manifest.value.summary,
            copies: manifest.value.nodes.length,
            adaptations: manifest.value.adaptations.length,
            links: manifest.value.links,
          },
        }),
      });
      await recoveryManifest(env, record);
      const roots = target.nodes.filter((node) => node.parentId === null);
      const followed = new Set(roots.map((node) => node.prevSiblingId));
      const tail = roots.find((node) => !followed.has(node.id));
      const copies = manifest.value.nodes.map((node) =>
        node.id === manifest.value.rootId
          ? { ...node, prevSiblingId: tail?.id ?? null }
          : node,
      );
      target = { ...target, nodes: [...target.nodes, ...copies] };
      if (!validateNodeGraph(target.nodes).ok)
        throw new Error("experimental-primary recovery target graph rejected");
    }
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
    await stub.finalizeRetirementRouting(record.migrationId);
    await stub.releaseRetirementFreeze(record.migrationId);
    return updateRecord(env, record, {
      state: "completed",
      classification:
        record.policy === "classic-link-repair-v1"
          ? "already-classic"
          : record.classification,
      result:
        record.policy === "classic-link-repair-v1"
          ? "classic-links-repaired"
          : record.policy === "experimental-primary-recovery-v1"
            ? "migrated-with-classic-recovery"
            : "migrated",
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

/** Explicit policy revision. Old immutable objects and attempt records remain. */
async function selectPreserveClassicPolicy(
  env: RetirementEnv,
  record: RetirementRecord,
  backends: RetirementBackends,
): Promise<RetirementRecord> {
  if (record.policy === "preserve-classic-v1" && record.state !== "failed")
    return record;
  const status = await backends.classic.retirementStatus();
  const receipt = await backends.classic.preserveClassicReceipt();
  const experimental = await backends.lunora.inspect();
  if (
    record.state === "completed" ||
    status.frozenBy ||
    status.appliedMigrationId ||
    receipt ||
    experimental.retirement
  ) {
    throw new RetirementOperationRejected({
      message:
        "a new preserve-Classic revision requires unfenced, unmodified backends",
    });
  }
  if (isLunoraPreferenceEnabled(await backends.classic.exportSnapshot()))
    throw new RetirementOperationRejected({
      message:
        "enabled accounts require full experimental migration, not preserve-Classic",
    });
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE lunora_retirement SET migrationId = ?, policy = 'preserve-classic-v1', state = 'created', classification = NULL, result = NULL, startedAt = ?, updatedAt = ?, completedAt = NULL, classicSnapshotKey = NULL, classicSnapshotHash = NULL, lunoraSnapshotKey = NULL, lunoraSnapshotHash = NULL, recoveryManifestKey = NULL, recoveryManifestHash = NULL, counts = NULL, failureReason = NULL WHERE userId = ? AND activeOperationId = ?`,
  )
    .bind(
      crypto.randomUUID(),
      now,
      now,
      record.userId,
      record.activeOperationId,
    )
    .run();
  const selected = await getRecord(env, record.userId);
  if (!selected) throw new Error("preserve-Classic record missing");
  return selected;
}

async function selectReplacementPolicy(
  env: RetirementEnv,
  record: RetirementRecord,
  backends: RetirementBackends,
  policy: "experimental-primary-recovery-v1" | "classic-link-repair-v1",
): Promise<RetirementRecord> {
  if (record.policy === policy) return record;
  if (
    record.policy !== "lunora-to-classic-v1" ||
    !["created", "classified"].includes(record.state) ||
    record.classicSnapshotHash ||
    record.lunoraSnapshotHash
  )
    throw new RetirementOperationRejected({
      message:
        "recovery migration requires a new, unmodified automatic migration",
    });
  const status = await backends.classic.retirementStatus();
  const experimental = await backends.lunora.inspect();
  if (status.frozenBy || status.appliedMigrationId || experimental.retirement)
    throw new RetirementOperationRejected({
      message: "recovery migration requires unfenced, unmodified backends",
    });
  await env.DB.prepare(
    `UPDATE lunora_retirement SET policy = ?
     WHERE userId = ? AND activeOperationId = ?`,
  )
    .bind(policy, record.userId, record.activeOperationId)
    .run();
  const selected = await getRecord(env, record.userId);
  if (selected?.policy !== policy)
    throw new Error("replacement policy selection failed");
  return selected;
}

async function recoveryManifest(env: RetirementEnv, record: RetirementRecord) {
  if (!record.recoveryManifestKey || !record.recoveryManifestHash)
    throw new Error("verified recovery manifest is unavailable");
  const manifest = await readVerifiedObject(
    env,
    record.recoveryManifestKey,
    Schema.Union([
      ClassicRecoveryManifestSchema,
      ExperimentalPrimaryRecoveryManifestSchema,
    ]),
  );
  if (
    manifest.hash !== record.recoveryManifestHash ||
    manifest.value.userId !== record.userId ||
    manifest.value.migrationId !== record.migrationId ||
    manifest.value.classicSnapshotHash !== record.classicSnapshotHash ||
    manifest.value.lunoraSnapshotHash !== record.lunoraSnapshotHash ||
    manifest.value.policy !==
      (record.policy === "experimental-primary-recovery-v1"
        ? "experimental-primary-recovery-copies-v1"
        : "classic-recovery-copies-v1")
  )
    throw new Error("recovery manifest binding rejected");
  return manifest;
}

async function preserveClassic(
  env: RetirementEnv,
  initial: RetirementRecord,
  backends: RetirementBackends,
): Promise<RetirementRecord> {
  let record = initial;
  const stub = backends.classic;
  const experimental = backends.lunora;
  try {
    let receipt = await stub.preserveClassicReceipt();
    if (!receipt) {
      const current = await stub.freezeAndExportRetirement(record.migrationId);
      const validation = validateClassicSnapshot(current);
      if (!validation.ok) throw new Error(validation.reason);
      const classicKey = retirementSnapshotKey(
        record.userId,
        record.migrationId,
        "classic",
      );
      const classic = await storeImmutable(
        env,
        classicKey,
        current,
        OutlineSnapshotSchema,
      );
      if (
        (record.classicSnapshotHash &&
          classic.hash !== record.classicSnapshotHash) ||
        !classicSnapshotsEquivalent(classic.value, current)
      )
        throw new Error(
          "Classic changed since archive; a new reviewed revision is required",
        );
      record = await updateRecord(env, record, {
        state: "classic-backed-up",
        classicSnapshotKey: classicKey,
        classicSnapshotHash: classic.hash,
      });
      const currentArchive = Schema.decodeUnknownSync(
        LunoraRetirementArchiveSchema,
      )(
        await experimental.freezeAndExportArchive(
          record.migrationId,
          record.startedAt,
        ),
      );
      const rawValidation = validateLunoraRetirementArchive(
        currentArchive,
        record.userId,
      );
      if (!rawValidation.ok) throw new Error(rawValidation.reason);
      const archiveKey = `${retirementSnapshotKey(record.userId, record.migrationId, "lunora")}.archive`;
      const archive = await storeImmutable(
        env,
        archiveKey,
        currentArchive,
        LunoraRetirementArchiveSchema,
      );
      if (
        (record.lunoraSnapshotHash &&
          archive.hash !== record.lunoraSnapshotHash) ||
        !rawArchivesEquivalent(archive.value, currentArchive)
      )
        throw new Error(
          "experimental data changed since archive; a new reviewed revision is required",
        );
      const archiveValidation = validateLunoraRetirementArchive(
        archive.value,
        record.userId,
      );
      if (!archiveValidation.ok) throw new Error(archiveValidation.reason);
      const plan = planClassicRecovery(classic.value, archive.value.snapshot, {
        userId: record.userId,
        timestamp: record.startedAt,
        newId: () => crypto.randomUUID(),
      });
      const manifestValue = ClassicRecoveryManifestSchema.make({
        ...plan,
        version: 1,
        userId: record.userId,
        migrationId: record.migrationId,
        createdAt: record.startedAt,
        classicSnapshotHash: classic.hash,
        lunoraSnapshotHash: archive.hash,
      });
      const manifest = await storeImmutable(
        env,
        `${classicKey}.recovery`,
        manifestValue,
        ClassicRecoveryManifestSchema,
      );
      record = await updateRecord(env, record, {
        state: "backups-verified",
        lunoraSnapshotKey: archiveKey,
        lunoraSnapshotHash: archive.hash,
        recoveryManifestKey: `${classicKey}.recovery`,
        recoveryManifestHash: manifest.hash,
        counts: JSON.stringify({
          ...snapshotCounts(archive.value.snapshot),
          recovery: {
            ...manifest.value.summary,
            copies: manifest.value.nodes.length,
            adaptations: manifest.value.adaptations.length,
            links: manifest.value.links,
          },
        }),
      });
      await recoveryManifest(env, record);
      receipt = await stub.preserveClassicRetirement({
        migrationId: record.migrationId,
        classicSnapshotHash: classic.hash,
        lunoraSnapshotHash: archive.hash,
        nodes: classic.value.nodes,
        kv: classic.value.kv,
      });
    }
    if (
      receipt.migrationId !== record.migrationId ||
      receipt.classicSnapshotHash !== record.classicSnapshotHash ||
      receipt.lunoraSnapshotHash !== record.lunoraSnapshotHash
    )
      throw new Error("preserve-Classic receipt binding rejected");
    // Once this receipt exists, never export/replace/replan current Classic on retry.
    const classic = await readVerifiedObject(
      env,
      record.classicSnapshotKey ?? "",
      OutlineSnapshotSchema,
    );
    const archive = await readVerifiedObject(
      env,
      record.lunoraSnapshotKey ?? "",
      LunoraRetirementArchiveSchema,
    );
    if (
      classic.hash !== receipt.classicSnapshotHash ||
      archive.hash !== receipt.lunoraSnapshotHash
    )
      throw new Error("preserved archive hash mismatch");
    await recoveryManifest(env, record);
    await experimental.markRetired(record.migrationId, Date.now());
    await stub.finalizeRetirementRouting(record.migrationId);
    await stub.releaseRetirementFreeze(record.migrationId);
    return updateRecord(env, record, {
      state: "completed",
      result: "classic-preserved",
      completedAt: Date.now(),
      failureReason: null,
    });
  } catch (error) {
    try {
      const receipt = await stub.preserveClassicReceipt();
      const status = (await experimental.inspect()).retirement;
      if (receipt || status?.status === "retired")
        return updateRecord(env, record, {
          state: "uncertain",
          result: "operator-recovery-required",
          failureReason: failureReason(error),
        });
      await experimental.releaseFreeze(record.migrationId);
      await stub.releaseRetirementFreeze(record.migrationId);
      return updateRecord(env, record, {
        state: "failed",
        result: "failed-before-preservation",
        failureReason: failureReason(error),
      });
    } catch {
      return updateRecord(env, record, {
        state: "uncertain",
        result: "operator-recovery-required",
        failureReason:
          "preserve-Classic recovery state could not be established",
      });
    }
  }
}

async function recoverClassic(
  env: RetirementEnv,
  record: RetirementRecord,
  backends: RetirementBackends,
  approvedManifestHash?: string,
): Promise<RetirementRecord> {
  if (
    record.state !== "completed" ||
    record.policy !== "preserve-classic-v1" ||
    !approvedManifestHash ||
    approvedManifestHash !== record.recoveryManifestHash
  )
    throw new RetirementOperationRejected({
      message:
        "recovery requires completed preservation and exact reviewed manifest hash",
    });
  const manifest = await recoveryManifest(env, record);
  const classic = await readVerifiedObject(
    env,
    record.classicSnapshotKey ?? "",
    OutlineSnapshotSchema,
  );
  const archive = await readVerifiedObject(
    env,
    record.lunoraSnapshotKey ?? "",
    LunoraRetirementArchiveSchema,
  );
  if (
    classic.hash !== record.classicSnapshotHash ||
    archive.hash !== record.lunoraSnapshotHash ||
    !validateLunoraRetirementArchive(archive.value, record.userId).ok
  )
    throw new Error("recovery archives could not be verified");
  const receipt = await backends.classic.importClassicRecovery({
    migrationId: record.migrationId,
    manifestHash: manifest.hash,
    rootId: manifest.value.rootId,
    nodes: manifest.value.nodes,
  });
  if (
    receipt.migrationId !== record.migrationId ||
    receipt.manifestHash !== manifest.hash ||
    receipt.rootId !== manifest.value.rootId ||
    receipt.nodes !== manifest.value.nodes.length
  )
    throw new Error("recovery import receipt rejected");
  return updateRecord(env, record, {
    result: "classic-recovery-imported",
    failureReason: null,
  });
}

export async function runRetirementOperation(
  env: RetirementEnv,
  userId: string,
  operation: RetirementOperation,
  backends = retirementBackends(env, userId),
  approvedManifestHash?: string,
): Promise<RetirementRecord & { dryRun?: unknown }> {
  if (
    operation === "repair-classic" &&
    !/^[a-f0-9]{64}$/.test(approvedManifestHash ?? "")
  )
    throw new RetirementOperationRejected({
      message: "link repair requires an approved preview hash",
    });
  await ensureRecord(env, userId, Date.now());
  const operationId = crypto.randomUUID();
  const record = await env.DB.prepare(
    `UPDATE lunora_retirement
     SET activeOperationId = ?, activeOperationStartedAt = ?
     WHERE userId = ? AND activeOperationId IS NULL
     RETURNING *`,
  )
    .bind(operationId, Date.now(), userId)
    .first<RetirementRecord>();
  if (!record) throw new RetirementOperationInProgress({ userId });

  // Keep ownership through recovery and audit writes. A terminated executor
  // cannot run finally, so its durable claim remains held without a timeout.
  try {
    const selected =
      operation === "preserve-classic"
        ? await selectPreserveClassicPolicy(env, record, backends)
        : operation === "migrate-with-recovery" ||
            operation === "repair-classic"
          ? await selectReplacementPolicy(
              env,
              record,
              backends,
              operation === "repair-classic"
                ? "classic-link-repair-v1"
                : "experimental-primary-recovery-v1",
            )
          : record;
    const result = await performRetirementOperation(
      env,
      selected,
      operation,
      backends,
      approvedManifestHash,
    );
    return {
      ...result,
      activeOperationId: null,
      activeOperationStartedAt: null,
    };
  } finally {
    await env.DB.prepare(
      `UPDATE lunora_retirement
       SET activeOperationId = NULL, activeOperationStartedAt = NULL
       WHERE userId = ? AND activeOperationId = ?`,
    )
      .bind(userId, operationId)
      .run();
  }
}

async function performRetirementOperation(
  env: RetirementEnv,
  record: RetirementRecord,
  operation: RetirementOperation,
  backends: RetirementBackends,
  approvedManifestHash?: string,
): Promise<RetirementRecord & { dryRun?: unknown }> {
  const userId = record.userId;
  if (operation === "recover-classic") {
    const result = await recoverClassic(
      env,
      record,
      backends,
      approvedManifestHash,
    );
    await appendAttempt(env, result, operation);
    return result;
  }
  if (record.policy === "preserve-classic-v1") {
    if (
      operation === "migrate" ||
      operation === "migrate-with-recovery" ||
      operation === "repair-classic" ||
      operation === "restore"
    )
      throw new RetirementOperationRejected({
        message:
          "replacement and rollback operations cannot overwrite chosen Classic",
      });
    if (record.state === "completed" || operation === "dry-run") {
      await appendAttempt(env, record, operation);
      return record;
    }
    const result = await preserveClassic(env, record, backends);
    await appendAttempt(env, result, operation);
    return result;
  }
  if (
    operation !== "restore" &&
    (record.state === "completed" || record.state === "uncertain")
  ) {
    await appendAttempt(env, record, operation);
    return record;
  }
  if (operation === "dry-run") {
    const report = await inspect(env, userId, backends);
    if (record.state === "created" || record.state === "classified") {
      record = await updateRecord(env, record, {
        state: "classified",
        classification: report.classification,
        result: "dry-run",
        counts: JSON.stringify(snapshotCounts(report.lunora)),
        failureReason: report.reasons.classic ?? report.reasons.lunora ?? null,
      });
    }
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
    const progress: RollbackProgress = { restoreStarted: false };
    try {
      await backends.classic.freezeAndExportRetirement(record.migrationId);
      record = await rollback(env, record, backends, true, progress);
      record = await updateRecord(env, record, {
        state: "restored-pre-migration",
        result: "restored",
        failureReason: null,
      });
    } catch (error) {
      const reason = failureReason(error);
      if (!progress.restoreStarted) {
        try {
          const retirement = (await backends.lunora.inspect()).retirement;
          if (retirement?.status !== "retired") {
            await backends.lunora.releaseFreeze(record.migrationId);
          }
          await backends.classic.releaseRetirementFreeze(record.migrationId);
          record = await updateRecord(env, record, {
            state: "failed",
            result: "failed-before-restore",
            failureReason: reason,
          });
        } catch (recoveryError) {
          record = await updateRecord(env, record, {
            state: "uncertain",
            result: "operator-recovery-required",
            failureReason: `${reason}; recovery: ${failureReason(recoveryError)}`,
          });
        }
      } else {
        record = await updateRecord(env, record, {
          state: "uncertain",
          result: "operator-recovery-required",
          failureReason: reason,
        });
      }
    }
    await appendAttempt(env, record, operation);
    return record;
  }
  record = await migrate(env, record, backends, approvedManifestHash);
  await appendAttempt(env, record, operation);
  return record;
}

/** Read-only approval preview, deliberately separate from ordinary classification. */
export async function retirementRepairPreview(
  env: RetirementEnv,
  userId: string,
  backends = retirementBackends(env, userId),
) {
  const classic = Schema.decodeUnknownSync(OutlineSnapshotSchema)(
    await backends.classic.exportSnapshot(),
  );
  const experimental = await backends.lunora.inspect();
  const status = await backends.classic.retirementStatus();
  if (status.frozenBy || status.appliedMigrationId || experimental.retirement)
    return { userId, eligible: false };
  try {
    validateClassicLinkRepairSources(classic, experimental.snapshot, userId);
    const plan = planClassicLinkRepair(classic);
    return {
      userId,
      eligible: true,
      approvalHash: await classicLinkRepairSourceHash(
        userId,
        classic,
        experimental.snapshot,
      ),
      counts: plan.summary,
    };
  } catch {
    return { userId, eligible: false };
  }
}

/** Read the two backends without invoking the migration state machine. */
export async function retirementDiagnostic(
  env: RetirementEnv,
  userId: string,
  backends = retirementBackends(env, userId),
) {
  const readStartedAt = Date.now();
  const classic = Schema.decodeUnknownOption(OutlineSnapshotSchema)(
    await backends.classic.exportSnapshot(),
  );
  const experimental = Schema.decodeUnknownOption(
    LunoraRetirementSnapshotSchema,
  )((await backends.lunora.inspect()).snapshot);
  if (classic._tag === "None" || experimental._tag === "None") {
    throw new Error("retirement diagnostic snapshot schema rejected");
  }
  const snapshot = experimental.value;
  if (
    !isSupportedSnapshotVersion(classic.value.version) ||
    snapshot.version !== RETIREMENT_SNAPSHOT_VERSION ||
    snapshot.userId !== userId ||
    [
      snapshot.nodes,
      snapshot.dailyIndex,
      snapshot.tagColors,
      snapshot.savedQueries,
      snapshot.migrateState,
    ].some((rows) => rows.some((row) => row.userId !== userId))
  ) {
    throw new Error("retirement diagnostic version or ownership rejected");
  }
  return {
    userId,
    readStartedAt,
    readFinishedAt: Date.now(),
    ...compareRetirementSnapshots(classic.value, snapshot),
  };
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
