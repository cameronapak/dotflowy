import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

// Canary (ADR 0061): proves the workerd pool boots with bindings from
// wrangler.jsonc and D1 answers after migrations. If this fails, the pool
// config is broken - not the feature under test.
test("D1 binding answers inside real workerd", async () => {
  // SAFETY: vitest.config.ts binds DB on this pool; the cast only names the
  // binding, it asserts nothing about runtime shape.
  const testEnv = env as { DB: D1Database };
  expect(testEnv.DB).toBeDefined();
  const row = await testEnv.DB.prepare("SELECT 1 AS one").first<{
    one: number;
  }>();
  expect(row?.one).toBe(1);
});
