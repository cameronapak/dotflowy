import type { LunoraAuthOptions } from "@lunora/auth";
import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "../lunora/_generated/app.js";

interface Env extends Record<string, unknown> {
  AUTH_SECRET: string;
  AUTH_URL?: string;
  DB: unknown;
  SHARD: ShardNamespaceLike;
}

const authOptions = (env: Env): LunoraAuthOptions => {
  if (!env.AUTH_SECRET) {
    throw new Error("AUTH_SECRET is required");
  }

  return {
    appName: "Lunora Outline Spike",
    baseURL: env.AUTH_URL,
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ url, user }) => {
        // Dev-only: log reset link (never commit real mail secrets).
        console.log(`[auth] password reset for ${user.email}: ${url}`);
      },
    },
    secret: env.AUTH_SECRET,
  };
};

const app = defineApp<Env>()
  .shard((env) => env.SHARD)
  .auth({ d1: (env) => env.DB, options: authOptions })
  .extend(() => ({
    authorizeShard: (identity, shardKey) => identity?.userId === shardKey,
  }))
  .build();

export const ShardDO = app.ShardDO;
export default app;
