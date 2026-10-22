/// <reference types="@cloudflare/workers-types" />

/** Worker-internal Lunora clients retained for retirement and account deletion. */

import { Schema } from "effect";
import { createShardClient, type ShardNamespaceLike } from "lunorash/runtime";

import { internal } from "../lunora/_generated/api";
import {
  LunoraRetirementArchiveSchema,
  type LunoraRetirementArchive,
} from "./lunora-retirement";

type LunoraRpcEnv = {
  SHARD: ShardNamespaceLike;
};

function systemShardClient(env: LunoraRpcEnv, userId: string) {
  return createShardClient(env.SHARD).asSystem().forShard(userId);
}

/** Temporary ADR 0061 operator surface. All calls stay Worker-internal. */
export function createLunoraRetirementClient(
  env: LunoraRpcEnv,
  userId: string,
) {
  const client = systemShardClient(env, userId);
  return {
    inspect: () => client.call(internal.mcp.inspectRetirement, { userId }),
    freezeAndExport: (migrationId: string, now: number) =>
      client.call(internal.mcp.freezeAndExportRetirement, {
        userId,
        migrationId,
        now,
      }),
    freezeAndExportArchive: async (
      migrationId: string,
      now: number,
    ): Promise<LunoraRetirementArchive> => {
      const decoded = Schema.decodeUnknownOption(LunoraRetirementArchiveSchema)(
        await client.call(internal.mcp.freezeAndExportArchiveRetirement, {
          userId,
          migrationId,
          now,
        }),
      );
      if (decoded._tag === "None")
        throw new Error("experimental retirement archive schema rejected");
      return decoded.value;
    },
    releaseFreeze: (migrationId: string) =>
      client.call(internal.mcp.releaseRetirementFreeze, {
        userId,
        migrationId,
      }),
    markRetired: (migrationId: string, now: number) =>
      client.call(internal.mcp.markRetirementVerified, {
        userId,
        migrationId,
        now,
      }),
  };
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
