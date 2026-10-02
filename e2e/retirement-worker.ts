/// <reference types="@cloudflare/workers-types" />

import type { ArgsOf } from "lunorash/client";

// Test-only Workerd entry. Never included in wrangler.jsonc or deployed.
import { createShardClient, createWorker } from "lunorash/runtime";

import type { Node } from "../src/data/wire-schema";
import type {
  RetirementBackends,
  RetirementOperation,
} from "../worker/lunora-retirement-service";

import { api } from "../lunora/_generated/api";
import { LUNORA_FUNCTIONS } from "../lunora/_generated/functions";
import {
  createLunoraOutlineStore,
  createLunoraRetirementClient,
} from "../worker/lunora-mcp-store";
import {
  buildClassicTarget,
  retirementSnapshotKey,
  sha256Hex,
} from "../worker/lunora-retirement";
import {
  RetirementOperationInProgress,
  runRetirementOperation,
} from "../worker/lunora-retirement-service";

export { UserOutlineDO } from "../worker/outline-do";
export { ShardDO } from "../worker/lunora-app";

type Env = Parameters<typeof runRetirementOperation>[0];
export type Input = {
  userId: string;
  classicNodes?: Node[];
  lunoraNodes?: Node[];
  classicDailyIndex?: Array<{ key: string; nodeId: string }>;
  lunoraDailyIndex?: Array<{ key: string; nodeId: string; touchedAt: number }>;
  operation?: RetirementOperation;
  fault?: "retire" | "verify" | "rollback";
  afterRetire?: boolean;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_lunora/ws") {
      // Test-only identity bridge; the production Worker resolves a server session.
      // The bound ShardDO below is the production class and configuration.
      return createWorker({
        shardDO: env.SHARD,
        functions: LUNORA_FUNCTIONS,
        resolveIdentity: async () => ({
          userId: url.searchParams.get("shard") ?? "",
        }),
        authorizeShard: (caller) => caller.identity?.userId === caller.shardKey,
      }).fetch(request, env, { waitUntil() {} });
    }
    if (url.pathname === "/sync") {
      const stub = env.USER_OUTLINE.get(
        env.USER_OUTLINE.idFromName(url.searchParams.get("userId") ?? ""),
      );
      return stub.fetch(request);
    }
    // SAFETY: only the accompanying spec constructs requests to this isolated test Worker.
    const input = await request.json<Input>();
    const { userId } = input;
    const classic = env.USER_OUTLINE.get(env.USER_OUTLINE.idFromName(userId));
    const lunora = createLunoraRetirementClient(env, userId);
    const client = createShardClient(env.SHARD).as({ userId }).forShard(userId);
    try {
      if (url.pathname === "/seed") {
        await classic.seed({
          nodes: input.classicNodes ?? [],
          kv: [
            {
              collection: "account-prefs",
              key: "lunora-beta",
              value: { id: "lunora-beta", enabled: true },
            },
            {
              collection: "account-prefs",
              key: "timezone",
              value: { id: "timezone", zone: "America/Chicago" },
            },
            ...(input.classicDailyIndex ?? []).map((row) => ({
              collection: "daily-index",
              key: row.key,
              value: row,
            })),
          ],
        });
        // SAFETY: generated input types collapse nullability; runtime validators accept the wire Node fields.
        await client.call(api.mutators.importNodes, {
          userId,
          nodes: (input.lunoraNodes ?? []).map((node) => ({
            ...node,
            userId,
          })) as ArgsOf<typeof api.mutators.importNodes>["nodes"],
        });
        const nodeId = input.lunoraNodes?.[0]?.id ?? "";
        await client.call(api.mutators.importKvRows, {
          userId,
          rows: [
            ...(
              input.lunoraDailyIndex ?? [
                { key: "2026-10-02", nodeId, touchedAt: 7 },
              ]
            ).map((row) => ({ kind: "dailyIndex" as const, ...row })),
            { kind: "tagColor", tag: "work", color: "blue" },
            {
              kind: "savedQuery",
              id: crypto.randomUUID(),
              name: "Work",
              query: "#work",
              createdAt: 8,
            },
          ],
        });
        await client.call(api.mutators.setMigrateState, {
          userId,
          nodesAt: 1,
          kvAt: 2,
        });
        return Response.json({
          classic: await classic.exportSnapshot(),
          lunora: await lunora.inspect(),
        });
      }
      if (url.pathname === "/delete") {
        await classic.deleteNodes(
          (input.classicNodes ?? []).map((node) => node.id),
        );
        await createLunoraOutlineStore(env, userId).applyBatch(
          (input.lunoraNodes ?? []).map((node) => ({
            op: "delete",
            key: node.id,
          })),
        );
        return Response.json({ deleted: true });
      }
      if (url.pathname === "/inspect") {
        return Response.json({
          classic: await classic.exportSnapshot(),
          status: await classic.retirementStatus(),
          lunora: await lunora.inspect(),
          record: await env.DB.prepare(
            "SELECT * FROM lunora_retirement WHERE userId = ?",
          )
            .bind(userId)
            .first(),
        });
      }
      if (url.pathname === "/write") {
        await createLunoraOutlineStore(env, userId).applyBatch(
          (input.lunoraNodes ?? []).map((value) => ({ op: "update", value })),
        );
        return Response.json({ written: true });
      }
      if (url.pathname === "/browser-write") {
        await client.call(api.mutators.setText, {
          userId,
          id: input.lunoraNodes?.[0]?.id ?? "",
          text: "stale browser edit",
          updatedAt: 9,
        });
        return Response.json({ written: true });
      }
      if (url.pathname === "/race") {
        let verified!: () => void;
        let releaseMigration!: () => void;
        const atVerification = new Promise<void>((resolve) => {
          verified = resolve;
        });
        const migrationGate = new Promise<void>((resolve) => {
          releaseMigration = resolve;
        });
        const migrating = runRetirementOperation(env, userId, "migrate", {
          classic,
          lunora: {
            ...lunora,
            markRetired: async (id, now) => {
              verified();
              await migrationGate;
              return lunora.markRetired(id, now);
            },
          },
        });
        await atVerification;
        let backendCalls = 0;
        const unexpectedBackendCall = async () => {
          backendCalls++;
          throw new Error("overlapping operation called a backend");
        };
        let rejected = false;
        try {
          await runRetirementOperation(
            env,
            userId,
            input.operation ?? "restore",
            {
              classic: {
                exportSnapshot: unexpectedBackendCall,
                freezeAndExportRetirement: unexpectedBackendCall,
                getNodes: unexpectedBackendCall,
                releaseRetirementFreeze: unexpectedBackendCall,
                restorePreRetirementSnapshot: unexpectedBackendCall,
                restoreRetirementSnapshot: unexpectedBackendCall,
                retirementStatus: unexpectedBackendCall,
              },
              lunora: {
                inspect: unexpectedBackendCall,
                freezeAndExport: unexpectedBackendCall,
                releaseFreeze: unexpectedBackendCall,
                markRetired: unexpectedBackendCall,
              },
            },
          );
        } catch (error) {
          if (!(error instanceof RetirementOperationInProgress)) throw error;
          rejected = true;
        } finally {
          releaseMigration();
        }
        const migration = await migrating;
        return Response.json({
          migration,
          rejected,
          backendCalls,
          classic: await classic.exportSnapshot(),
          status: await classic.retirementStatus(),
          lunora: await lunora.inspect(),
        });
      }
      if (url.pathname === "/interrupt") {
        const record = await runRetirementOperation(env, userId, "dry-run");
        const classicSnapshot = await classic.freezeAndExportRetirement(
          record.migrationId,
        );
        const lunoraSnapshot = await lunora.freezeAndExport(
          record.migrationId,
          Date.now(),
        );
        const classicKey = retirementSnapshotKey(
          userId,
          record.migrationId,
          "classic",
        );
        const lunoraKey = retirementSnapshotKey(
          userId,
          record.migrationId,
          "lunora",
        );
        const classicBytes = JSON.stringify(classicSnapshot);
        const lunoraBytes = JSON.stringify(lunoraSnapshot);
        await env.BACKUPS.put(classicKey, classicBytes);
        await env.BACKUPS.put(lunoraKey, lunoraBytes);
        await env.DB.prepare(
          "UPDATE lunora_retirement SET state = 'backups-verified', classicSnapshotKey = ?, classicSnapshotHash = ?, lunoraSnapshotKey = ?, lunoraSnapshotHash = ? WHERE userId = ?",
        )
          .bind(
            classicKey,
            await sha256Hex(new TextEncoder().encode(classicBytes)),
            lunoraKey,
            await sha256Hex(new TextEncoder().encode(lunoraBytes)),
            userId,
          )
          .run();
        await classic.restoreRetirementSnapshot({
          migrationId: record.migrationId,
          ...buildClassicTarget(
            classicSnapshot,
            lunoraSnapshot,
            record.startedAt,
          ),
        });
        if (input.afterRetire)
          await lunora.markRetired(record.migrationId, Date.now());
        return Response.json({ migrationId: record.migrationId });
      }
      if (url.pathname === "/run") {
        const backends: RetirementBackends = { classic, lunora };
        let mismatch = input.fault === "verify" || input.fault === "rollback";
        if (input.fault === "retire") {
          backends.lunora = {
            ...lunora,
            markRetired: async () => {
              throw new Error("injected retire failure");
            },
          };
        }
        if (mismatch) {
          backends.classic = {
            exportSnapshot: async () => {
              const snapshot = await classic.exportSnapshot();
              if (
                mismatch &&
                (await classic.retirementStatus()).appliedMigrationId
              ) {
                mismatch = false;
                return {
                  ...snapshot,
                  nodes: snapshot.nodes.map((node) => ({
                    ...node,
                    text: "injected verification mismatch",
                  })),
                };
              }
              return snapshot;
            },
            freezeAndExportRetirement: (id) =>
              classic.freezeAndExportRetirement(id),
            getNodes: () => classic.getNodes(),
            retirementStatus: () => classic.retirementStatus(),
            releaseRetirementFreeze: (id) =>
              classic.releaseRetirementFreeze(id),
            restoreRetirementSnapshot: (data) =>
              classic.restoreRetirementSnapshot(data),
            restorePreRetirementSnapshot: async (data) => {
              if (input.fault === "rollback")
                throw new Error("injected rollback failure");
              return classic.restorePreRetirementSnapshot(data);
            },
          };
        }
        return Response.json(
          await runRetirementOperation(
            env,
            userId,
            input.operation ?? "migrate",
            backends,
          ),
        );
      }
      return new Response("unknown fixture operation", { status: 404 });
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof RetirementOperationInProgress
              ? "retirement_operation_in_progress"
              : error instanceof Error
                ? error.message
                : String(error),
        },
        { status: 409 },
      );
    }
  },
};
