import type { ShardNamespaceLike } from "lunorash/runtime";

import { defineApp } from "../lunora/_generated/app.js";

interface Env extends Record<string, unknown> {
  SHARD: ShardNamespaceLike;
}

const app = defineApp<Env>()
  .shard((env) => env.SHARD)
  .build();

export const ShardDO = app.ShardDO;
export default app;
