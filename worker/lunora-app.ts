/// <reference types="@cloudflare/workers-types" />

/**
 * Lunora outline plane composed beside the product Worker (ADR 0058 Phase 2).
 *
 * - No `@lunora/auth` / dual signup — product Better Auth stays session authority.
 * - `resolveIdentity` bridges the existing Better Auth session into Lunora.
 * - Product fetch routes `/_lunora/*` here; everything else stays on UserOutlineDO.
 */

import type { ShardNamespaceLike } from "lunorash/runtime";

import { memoizeIdentityPerRequest } from "lunorash/runtime";

import type { AuthEnv } from "./auth";

import { defineApp } from "../lunora/_generated/app";
import { createAuth } from "./auth";

export type LunoraEnv = AuthEnv & {
  SHARD: ShardNamespaceLike;
  /** Workers AI binding for inline `@agent` (ADR 0059). */
  AI: Ai;
  /** Optional Studio / admin bearer (unset = admin routes stay closed). */
  LUNORA_ADMIN_TOKEN?: string;
  /**
   * Optional force for local dogfood. Production follows the synced beta flag.
   */
  LUNORA_OUTLINE?: string;
  /**
   * Extra origins for Lunora CSRF/CORS (comma-separated). Vite `:3000` /
   * e2e `:3210` are always included — see `lunoraTrustedOrigins`.
   */
  LUNORA_TRUSTED_ORIGINS?: string;
  /** Same comma-list as `.dev.vars.example` for Better Auth CSRF (optional). */
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
  /** Optional AI Gateway (Cloudflare account id) — see `@lunora/ai` resolveAiGateway. */
  LUNORA_AI_GATEWAY_ACCOUNT_ID?: string;
  /** Optional AI Gateway id/slug. */
  LUNORA_AI_GATEWAY_ID?: string;
  /** Optional AI Gateway auth token (authenticated gateways only). */
  LUNORA_AI_GATEWAY_TOKEN?: string;
};

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

const app = defineApp<LunoraEnv>()
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
      resolveIdentity: memoizeIdentityPerRequest(async (request) => {
        const url = new URL(request.url);
        const auth = createAuth(env, url.origin);
        const session = await auth.api.getSession({ headers: request.headers });
        const userId = session?.user?.id;
        if (!userId) return null;
        return {
          userId,
          email: session.user.email ?? undefined,
        };
      }),
      authorizeShard: (identity, shardKey) => identity?.userId === shardKey,
    };
  })
  .build();

export const ShardDO = app.ShardDO;
export const lunoraApp = app;
