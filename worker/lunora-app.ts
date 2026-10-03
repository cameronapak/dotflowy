/// <reference types="@cloudflare/workers-types" />

/**
 * Retained Lunora shard composition for ADR 0061 retirement operations.
 * There is deliberately no public fetch delegation or identity bridge.
 */

import type { ShardNamespaceLike } from "lunorash/runtime";

import type { AuthEnv } from "./auth";

import { defineApp } from "../lunora/_generated/app";

export type LunoraEnv = AuthEnv & {
  SHARD: ShardNamespaceLike;
};

const app = defineApp<LunoraEnv>()
  .shard((env) => env.SHARD)
  // Owner shapes, including the retirement signal, require the shard changelog.
  .cdc()
  .build();

export const ShardDO = app.ShardDO;
