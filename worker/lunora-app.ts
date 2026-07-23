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
   * Default ON when unset — browser + MCP share the Lunora SHARD. Set
   * `"0"` / `"false"` / `"off"` to route MCP through classic UserOutlineDO.
   */
  LUNORA_OUTLINE?: string;
  /**
   * Extra origins for Lunora CSRF/CORS (comma-separated). Vite `:3000` /
   * e2e `:3210` are always included — see `lunoraTrustedOrigins`.
   */
  LUNORA_TRUSTED_ORIGINS?: string;
  /** Same comma-list as `.dev.vars.example` for Better Auth CSRF (optional). */
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
};

// defineApp requires `Record<string, unknown>`; AuthEnv is a closed interface.
type LunoraAppEnv = LunoraEnv & Record<string, unknown>;

/**
 * Origins the SPA may use when talking to Lunora through the Vite/dev proxy.
 *
 * Lunora's CSRF guard compares `Origin` to `new URL(request.url).origin`. In
 * `bun run dev`, the browser Origin is Vite (`:3000`) while the Worker URL
 * (after `changeOrigin`) is wrangler (`:8787`) — without these trusted, cookie
 * WS upgrades return `FORBIDDEN_ORIGIN` 403 and the outline never leaves
 * "Loading outline". Mirrors Better Auth's `trustedOrigins` in `auth.ts`.
 */
function lunoraTrustedOrigins(env: LunoraEnv): string[] {
  const fromEnv = [
    ...(env.LUNORA_TRUSTED_ORIGINS ?? "").split(","),
    ...(env.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(","),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  const fromBase = env.BETTER_AUTH_URL
    ? (() => {
        try {
          return [new URL(env.BETTER_AUTH_URL).origin];
        } catch {
          return [];
        }
      })()
    : [];
  return [
    ...new Set([
      "http://localhost:3000",
      "http://localhost:3210",
      ...fromBase,
      ...fromEnv,
    ]),
  ];
}

const app = defineApp<LunoraAppEnv>()
  .shard((env) => env.SHARD)
  .extend((env) => {
    const trustedOrigins = lunoraTrustedOrigins(env);
    return {
      adminToken: env.LUNORA_ADMIN_TOKEN,
      security: {
        // CORS allowlist also feeds CSRF `isTrustedOrigin` (see @lunora/runtime).
        cors: {
          allowedOrigins: trustedOrigins,
          allowCredentials: true,
        },
        csrf: { trustedOrigins },
      },
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
    };
  })
  .build();

export const ShardDO = app.ShardDO;
export const lunoraApp = app;
