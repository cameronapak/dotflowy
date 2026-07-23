/// <reference types="@cloudflare/workers-types" />

/**
 * Lunora outline plane composed beside the product Worker (ADR 0055 Phase 2).
 *
 * - No `@lunora/auth` / dual signup — product Better Auth stays session authority.
 * - `resolveIdentity` bridges the existing Better Auth session into Lunora.
 * - Product fetch routes `/_lunora/*` here; everything else stays on UserOutlineDO.
 */

import type { ShardNamespaceLike } from "lunorash/runtime";

import type { AuthEnv } from "./auth";

import { defineApp } from "../lunora/_generated/app";
import { createAuth } from "./auth";

export type LunoraEnv = AuthEnv & {
  SHARD: ShardNamespaceLike;
  /** Optional Studio / admin bearer (unset = admin routes stay closed). */
  LUNORA_ADMIN_TOKEN?: string;
  /**
   * When `"1"` / `"true"`, MCP outline tools read/write the Lunora SHARD
   * (mutators:applyChangeOps + queries:listNodes) instead of UserOutlineDO.
   * Default unset/off — mirrors client `dotflowy:flag:lunora-sync` for local/dev.
   */
  LUNORA_OUTLINE?: string;
};

// defineApp requires `Record<string, unknown>`; AuthEnv is a closed interface.
type LunoraAppEnv = LunoraEnv & Record<string, unknown>;

const app = defineApp<LunoraAppEnv>()
  .shard((env) => env.SHARD)
  .extend((env) => ({
    adminToken: env.LUNORA_ADMIN_TOKEN,
    resolveIdentity: async (request) => {
      const url = new URL(request.url);
      const auth = createAuth(env, url.origin);
      const session = await auth.api.getSession({ headers: request.headers });
      const userId = session?.user?.id;
      if (!userId) return null;
      return {
        userId,
        email: session.user.email ?? undefined,
      };
    },
    authorizeShard: (identity, shardKey) => identity?.userId === shardKey,
  }))
  .build();

export const ShardDO = app.ShardDO;
export const lunoraApp = app;
