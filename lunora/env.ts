/**
 * Typed Worker env for Lunora function `ctx.env` (codegen wires this).
 * D1 `DB` is required for the inline `@agent` paid-plan gate (`getPlan`).
 */
import { defineEnv, v } from "lunorash/server";

export const env = defineEnv({
  /** Better Auth / billing D1 (subscription table). */
  DB: v.any(),
});
