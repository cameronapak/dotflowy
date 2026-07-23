/// <reference types="@cloudflare/workers-types" />

/**
 * MCP OutlineStore backed by the Lunora SHARD (ADR 0055).
 *
 * When `LUNORA_OUTLINE=1`, Worker MCP tools keep planning via outline-ops
 * (`ChangeOp[]`) but commit through `mutators:applyChangeOps` on the same
 * user shard the browser mutators use — not classic UserOutlineDO.applyBatch.
 *
 * Identity is Worker-trusted: the MCP bearer was already validated; we forward
 * `x-lunora-userid` (+ system) to the shard the same way Lunora's compose
 * forwards authenticated RPCs.
 */

import { resolveShard, type ShardNamespaceLike } from "lunorash/runtime";

import type { ChangeOp, Node } from "../src/data/wire-schema";
import type { OutlineStore } from "./mcp-tools";

type LunoraRpcEnv = {
  SHARD: ShardNamespaceLike;
};

type RpcResult = { result?: unknown; error?: { message?: string } };

async function shardRpc(
  env: LunoraRpcEnv,
  userId: string,
  functionPath: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const stub = resolveShard(env.SHARD, userId);
  const res = await stub.fetch(
    new Request("https://shard.internal/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lunora-userid": userId,
        // Trusted Worker→shard dispatch (same as compose cron/forward).
        "x-lunora-system": "1",
      },
      body: JSON.stringify({ functionPath, args }),
    }),
  );
  const json = (await res.json()) as RpcResult;
  if (!res.ok || json.error) {
    throw new Error(
      json.error?.message ??
        `lunora shard rpc ${functionPath} failed (${res.status})`,
    );
  }
  return json.result;
}

function wireNode(n: {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  isTask: boolean;
  completed: boolean;
  collapsed: boolean;
  bookmarkedAt: number | null;
  mirrorOf: string | null;
  createdAt: number;
  updatedAt: number;
  origin: string | null;
  kind: "paragraph" | null;
}): Node {
  return {
    id: n.id,
    parentId: n.parentId,
    prevSiblingId: n.prevSiblingId,
    text: n.text,
    isTask: n.isTask,
    completed: n.completed,
    collapsed: n.collapsed,
    bookmarkedAt: n.bookmarkedAt,
    mirrorOf: n.mirrorOf,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    origin: n.origin,
    kind: n.kind,
  };
}

/**
 * OutlineStore that reads/writes the Lunora shard for `userId`.
 * `userId` is the Better Auth id (shard key) — not resolveUserId('default').
 */
export function createLunoraOutlineStore(
  env: LunoraRpcEnv,
  userId: string,
): OutlineStore {
  return {
    async getNodes() {
      const rows = (await shardRpc(env, userId, "mcp:listNodes", {
        userId,
      })) as Array<Parameters<typeof wireNode>[0]>;
      return (rows ?? []).map(wireNode);
    },

    async applyBatch(ops: readonly ChangeOp[]) {
      if (ops.length === 0) return 0;
      await shardRpc(env, userId, "mcp:applyChangeOps", {
        userId,
        ops,
      });
      // Classic DO returns a seq; Lunora watermarks are internal. Tools ignore
      // the numeric return (commit() awaits applyBatch for side effects only).
      return ops.length;
    },

    async getKv(collection: string) {
      if (collection !== "daily-index") return [];
      const rows = (await shardRpc(env, userId, "mcp:listDailyIndex", {
        userId,
      })) as Array<{ key: string; nodeId: string }>;
      return rows ?? [];
    },

    async getOrCreateKv(collection: string, key: string, value: unknown) {
      if (collection !== "daily-index") {
        throw new Error(
          `lunora mcp store: unsupported kv collection ${collection}`,
        );
      }
      const candidate =
        value &&
        typeof value === "object" &&
        "nodeId" in value &&
        typeof (value as { nodeId: unknown }).nodeId === "string"
          ? (value as { nodeId: string }).nodeId
          : null;
      if (!candidate) {
        throw new Error("lunora mcp store: daily claim needs { nodeId }");
      }
      const result = (await shardRpc(
        env,
        userId,
        "mutators:claimDailyMapping",
        {
          userId,
          key,
          nodeId: candidate,
          touchedAt: Date.now(),
        },
      )) as { nodeId: string };
      return { key, nodeId: result.nodeId };
    },
  };
}

/** True when Worker MCP should use the Lunora shard (default OFF). */
export function isLunoraOutlineEnabled(env: {
  LUNORA_OUTLINE?: string;
}): boolean {
  return env.LUNORA_OUTLINE === "1" || env.LUNORA_OUTLINE === "true";
}
