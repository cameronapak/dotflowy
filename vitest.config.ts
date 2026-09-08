import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Two pools, one runner (ADR 0061):
//   - "worker": tests execute inside real workerd via @cloudflare/vitest-plugin,
//     with bindings (D1, DOs, R2) loaded from wrangler.jsonc.
//   - "src": pure-logic tests on a plain node pool.
// Custom Vitest environments/runners are unsupported inside the workers
// plugin, so the split is per-project, never per-root.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "src",
          include: ["src/**/*.test.{ts,tsx}"],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => {
            // wrangler.jsonc points assets at ./dist/client. A fresh clone has
            // not built yet and Miniflare fails on a missing assets directory,
            // so ensure it exists before the workerd pool boots.
            mkdirSync(path.resolve("dist/client"), { recursive: true });
            // D1 migrations are applied per test file by the setup file below
            // (isolated storage), via a test-only binding.
            const migrations = await readD1Migrations(
              path.resolve("migrations"),
            );
            return {
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            };
          }),
        ],
        test: {
          name: "worker",
          include: ["worker/**/*.test.ts"],
          setupFiles: ["./worker/test/apply-migrations.ts"],
        },
      },
    ],
  },
});
