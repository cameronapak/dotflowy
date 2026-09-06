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

import type { ArgsOf } from "lunorash/client";

import { Schema } from "effect";
import { createShardClient, type ShardNamespaceLike } from "lunorash/runtime";

import type { OutlineStore } from "./mcp-tools";
import type { KvClaim } from "./outline-do";

import { internal } from "../lunora/_generated/api";
import { NodeSchema, type ChangeOp, type Node } from "../src/data/wire-schema";

/** Generated applyChangeOps ops input — codegen drops .nullable() to non-null. */
type GeneratedApplyChangeOps = ArgsOf<
  typeof internal.mcp.applyChangeOps
>["ops"];

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

/** Unvalidated Lunora RPC replies: the shard's typed surface is trusted only
 *  after a Schema decode at this boundary (codegen also collapses nullability). */
export function decodeMcpNodeList(raw: readonly unknown[]): Node[] {
  return [...Schema.decodeUnknownSync(Schema.Array(NodeSchema))(raw ?? [])];
}

export function decodeDailyIndexRows(
  raw: readonly unknown[],
): Array<{ key: string; nodeId: string }> {
  return [
    ...Schema.decodeUnknownSync(Schema.Array(DailyIndexRowSchema))(raw ?? []),
  ];
}

export function decodeClaimDailyResult(raw: {
  nodeId?: unknown;
  won?: unknown;
}): {
  nodeId: string;
  won: boolean;
} {
  return Schema.decodeUnknownSync(ClaimDailyResultSchema)(raw);
}

export function decodeDailyClaimValue(raw: { nodeId?: unknown }): {
  nodeId: string;
} {
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
        // lunorash alpha.166 codegen collapses v.string().nullable() to string on
        // FunctionReference inputs; wire validators still accept null at runtime.
        // SAFETY: the wire validators accept the full nullable ChangeOp shape this cast erases.
        ops: [...ops] as GeneratedApplyChangeOps,
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

    async getOrCreateKv(
      collection: string,
      key: string,
      value: KvClaim,
    ): Promise<KvClaim> {
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

/** A synced account-prefs row as the classic DO returns it: only the fields
 *  the beta check reads, both unvalidated until this decode. */
const AccountPrefsRowSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Unknown),
});

/** Parse synced `account-prefs` rows for Lunora beta opt-in. */
export function parseLunoraBetaPref(rows: unknown[]): boolean {
  const decoded = rows.flatMap((r) => {
    const row = Schema.decodeUnknownOption(AccountPrefsRowSchema)(r);
    return row._tag === "Some" ? [row.value] : [];
  });
  const row = decoded.find((r) => r.id === LUNORA_BETA_PREF_ID);
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
