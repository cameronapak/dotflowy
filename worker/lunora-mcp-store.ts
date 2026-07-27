/// <reference types="@cloudflare/workers-types" />

/**
 * MCP OutlineStore backed by the Lunora SHARD (ADR 0058).
 *
 * When `LUNORA_OUTLINE=1`, Worker MCP tools keep planning via outline-ops
 * (`ChangeOp[]`) but commit through `mutators:applyChangeOps` on the same
 * user shard the browser mutators use — not classic UserOutlineDO.applyBatch.
 *
 * Identity is Worker-trusted: the MCP bearer was already validated, so normal
 * calls run as that user. Only account deletion uses a pure system client.
 */

import { Schema } from "effect";
import { createShardClient, type ShardNamespaceLike } from "lunorash/runtime";

import type { OutlineStore } from "./mcp-tools";

import { internal } from "../lunora/_generated/api";
import { NodeSchema, type ChangeOp, type Node } from "../src/data/wire-schema";

type LunoraRpcEnv = {
  SHARD: ShardNamespaceLike;
};

const DailyIndexRowSchema = Schema.Struct({
  key: Schema.String,
  nodeId: Schema.String,
});

const ClaimDailyResultSchema = Schema.Struct({
  nodeId: Schema.String,
  won: Schema.Boolean,
});

const DailyClaimValueSchema = Schema.Struct({
  nodeId: Schema.String,
});

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

export function decodeClaimDailyResult(raw: unknown): {
  nodeId: string;
  won: boolean;
} {
  return Schema.decodeUnknownSync(ClaimDailyResultSchema)(raw);
}

export function decodeDailyClaimValue(raw: unknown): { nodeId: string } {
  return Schema.decodeUnknownSync(DailyClaimValueSchema)(raw);
}

function userShardClient(env: LunoraRpcEnv, userId: string) {
  return createShardClient(env.SHARD).as({ userId }).forShard(userId);
}

function systemShardClient(env: LunoraRpcEnv, userId: string) {
  return createShardClient(env.SHARD).asSystem().forShard(userId);
}

/**
 * OutlineStore that reads/writes the Lunora shard for `userId`.
 * `userId` is the Better Auth id (shard key) — not resolveUserId('default').
 */
export function createLunoraOutlineStore(
  env: LunoraRpcEnv,
  userId: string,
): OutlineStore {
  const client = userShardClient(env, userId);

  return {
    async getNodes() {
      return decodeMcpNodeList(
        await client.call(internal.mcp.listNodes, { userId }),
      );
    },

    async applyBatch(ops: readonly ChangeOp[]) {
      if (ops.length === 0) return 0;
      await client.call(internal.mcp.applyChangeOps, {
        userId,
        ops: [...ops],
      });
      // Classic DO returns a seq; Lunora watermarks are internal. Tools ignore
      // the numeric return (commit() awaits applyBatch for side effects only).
      return ops.length;
    },

    async getKv(collection: string) {
      if (collection !== "daily-index") return [];
      return decodeDailyIndexRows(
        await client.call(internal.mcp.listDailyIndex, { userId }),
      );
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
      const result = decodeClaimDailyResult(
        await client.call(internal.mcp.claimDailyMapping, {
          userId,
          key,
          nodeId: candidate,
          touchedAt: Date.now(),
        }),
      );
      return { key, nodeId: result.nodeId };
    },

    // ADR 0059 session kv lives on classic DO in v1; Lunora tables deferred.
    async upsertKv(
      collection: string,
      _rows: readonly { key: string; value: unknown }[],
    ) {
      throw new Error(
        `lunora mcp store: agent session kv (${collection}) is classic-DO only in v1`,
      );
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
 * Kill-switch pairing (ADR 0058): env force first; else synced
 * `account-prefs` on classic DO; browser reads mirrored localStorage after
 * {@link AccountPrefsController} sync.
 *
 * FAILS CLOSED TO CLASSIC. The preference lives on the classic DO, so reading
 * it is a round-trip on the `/mcp` hot path — and letting that reject would
 * abort the request before a store is even chosen, breaking MCP for every user
 * (including the ones not in the beta) whenever the DO hiccups. Classic is the
 * default for everyone anyway, so an unreadable preference is a downgrade, not
 * a failure. An explicit env force never reaches the read at all.
 */
export async function isLunoraOutlineEnabledForUser(
  env: LunoraOutlineEnv,
  getAccountPrefs: () => Promise<unknown[]>,
): Promise<boolean> {
  const forced = resolveLunoraOutlineEnvForce(env);
  if (forced !== null) return forced;
  try {
    return parseLunoraBetaPref(await getAccountPrefs());
  } catch {
    return false;
  }
}

/** Permanently erase this user's Lunora shard — account deletion (ADR 0051). */
export async function wipeLunoraUserShard(
  env: LunoraRpcEnv,
  userId: string,
): Promise<void> {
  await systemShardClient(env, userId).call(internal.mcp.wipeUserShard, {
    userId,
  });
}
