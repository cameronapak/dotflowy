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

import { Schema } from "effect";
import { resolveShard, type ShardNamespaceLike } from "lunorash/runtime";

import type { OutlineStore } from "./mcp-tools";

import { NodeSchema, type ChangeOp, type Node } from "../src/data/wire-schema";

type LunoraRpcEnv = {
  SHARD: ShardNamespaceLike;
};

const RpcEnvelopeSchema = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.optional(Schema.String),
    }),
  ),
});

const DailyIndexRowSchema = Schema.Struct({
  key: Schema.String,
  nodeId: Schema.String,
});

const ClaimDailyResultSchema = Schema.Struct({
  nodeId: Schema.String,
});

const DailyClaimValueSchema = Schema.Struct({
  nodeId: Schema.String,
});

/** Decode unknown JSON at the Worker→shard trust boundary (ADR 0014 twin). */
export function decodeShardRpcEnvelope(raw: unknown): {
  result?: unknown;
  error?: { message?: string };
} {
  return Schema.decodeUnknownSync(RpcEnvelopeSchema)(raw);
}

export function decodeMcpNodeList(raw: unknown): Node[] {
  return [...Schema.decodeUnknownSync(Schema.Array(NodeSchema))(raw ?? [])];
}

export function decodeDailyIndexRows(
  raw: unknown,
): Array<{ key: string; nodeId: string }> {
  return [
    ...Schema.decodeUnknownSync(Schema.Array(DailyIndexRowSchema))(raw ?? []),
  ];
}

export function decodeClaimDailyResult(raw: unknown): { nodeId: string } {
  return Schema.decodeUnknownSync(ClaimDailyResultSchema)(raw);
}

export function decodeDailyClaimValue(raw: unknown): { nodeId: string } {
  return Schema.decodeUnknownSync(DailyClaimValueSchema)(raw);
}

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
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(
      `lunora shard rpc ${functionPath}: non-JSON response (${res.status})`,
    );
  }
  let envelope: { result?: unknown; error?: { message?: string } };
  try {
    envelope = decodeShardRpcEnvelope(json);
  } catch (err) {
    // Failed HTTP with a non-envelope body → status error, not a Schema dump.
    if (!res.ok) {
      throw new Error(
        `lunora shard rpc ${functionPath} failed (${res.status})`,
      );
    }
    throw err instanceof Error
      ? err
      : new Error(`lunora shard rpc ${functionPath}: invalid response`);
  }
  if (!res.ok || envelope.error) {
    throw new Error(
      envelope.error?.message ??
        `lunora shard rpc ${functionPath} failed (${res.status})`,
    );
  }
  return envelope.result;
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
      const raw = await shardRpc(env, userId, "mcp:listNodes", { userId });
      return decodeMcpNodeList(raw);
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
      const raw = await shardRpc(env, userId, "mcp:listDailyIndex", {
        userId,
      });
      return decodeDailyIndexRows(raw);
    },

    async getOrCreateKv(collection: string, key: string, value: unknown) {
      if (collection !== "daily-index") {
        throw new Error(
          `lunora mcp store: unsupported kv collection ${collection}`,
        );
      }
      let candidate: string;
      try {
        candidate = decodeDailyClaimValue(value).nodeId;
      } catch {
        throw new Error("lunora mcp store: daily claim needs { nodeId }");
      }
      const raw = await shardRpc(env, userId, "mutators:claimDailyMapping", {
        userId,
        key,
        nodeId: candidate,
        touchedAt: Date.now(),
      });
      const result = decodeClaimDailyResult(raw);
      return { key, nodeId: result.nodeId };
    },
  };
}

export type LunoraOutlineEnv = { LUNORA_OUTLINE?: string };

export const LUNORA_BETA_PREF_ID = "lunora-beta";

/** Env force: ON, OFF, or unset (use synced account preference). */
export function resolveLunoraOutlineEnvForce(
  env: LunoraOutlineEnv,
): boolean | null {
  const raw = env.LUNORA_OUTLINE?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  return false;
}

/** Parse synced `account-prefs` rows for Lunora beta opt-in. */
export function parseLunoraBetaPref(rows: unknown[]): boolean {
  const row = rows.find(
    (r) =>
      r &&
      typeof r === "object" &&
      (r as { id?: string }).id === LUNORA_BETA_PREF_ID,
  ) as { enabled?: unknown } | undefined;
  return row?.enabled === true;
}

/**
 * Sync helper: env force only. Unset env → false (classic DO default).
 * MCP uses {@link isLunoraOutlineEnabledForUser} for preference lookup.
 */
export function isLunoraOutlineEnabledSync(env: LunoraOutlineEnv): boolean {
  const forced = resolveLunoraOutlineEnvForce(env);
  if (forced !== null) return forced;
  return false;
}

/**
 * Whether Worker MCP should use the Lunora shard for this user.
 *
 * Kill-switch pairing (ADR 0055): env force first; else synced
 * `account-prefs` on classic DO; browser reads mirrored localStorage after
 * {@link AccountPrefsController} sync.
 */
export async function isLunoraOutlineEnabledForUser(
  env: LunoraOutlineEnv,
  getAccountPrefs: () => Promise<unknown[]>,
): Promise<boolean> {
  const forced = resolveLunoraOutlineEnvForce(env);
  if (forced !== null) return forced;
  const rows = await getAccountPrefs();
  return parseLunoraBetaPref(rows);
}

/** Permanently erase this user's Lunora shard — account deletion (ADR 0051). */
export async function wipeLunoraUserShard(
  env: LunoraRpcEnv,
  userId: string,
): Promise<void> {
  await shardRpc(env, userId, "mcp:wipeUserShard", { userId });
}
