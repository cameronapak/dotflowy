import type { D1Migration } from "@cloudflare/vitest-plugin";

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

/** Bindings vitest.config.ts injects into the workerd pool: wrangler.jsonc's
 * DB plus the test-only TEST_MIGRATIONS array. `cloudflare:workers`'s Env is
 * not worker/index.ts's Env, so name the bindings locally instead of
 * augmenting a module two tsconfigs resolve differently. */
interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

// Applied once per test file: the workers plugin runs each file in isolated
// storage, so migrations must run in setup, not once globally.
export default function applyMigrations() {
  // SAFETY: vitest.config.ts binds DB and TEST_MIGRATIONS on this pool; the
  // cast only names those bindings, it asserts nothing about runtime shape.
  const testEnv = env as TestEnv;
  return applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
}
