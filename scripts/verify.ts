/**
 * `bun run verify` - the whole gate in one command (ADR 0061): a fresh clone
 * (post `bun install`) to full proof, the exact bar CI runs. No device in
 * the loop: setup provisions .dev.vars + local D1, Vitest runs unit tests
 * (worker/ inside real workerd), and e2e boots its own wrangler dev serving
 * the built SPA with a unique-per-run user.
 *
 * Sequential and fail-fast, with a one-line-per-step summary at the end.
 * `changeset` is deliberately NOT here: it's a disclosure a human (or agent)
 * decides, not a mechanical check - CI enforces its presence separately.
 */
const ROOT = import.meta.dir.replace(/\/scripts$/, "");

const log = (msg: string) => console.log(`\x1b[36m[verify]\x1b[0m ${msg}`);

const STEPS: Array<[name: string, cmd: string[], docs: string]> = [
  ["setup", ["bun", "run", "setup"], "provision .dev.vars + local D1"],
  ["fmt:check", ["bun", "run", "fmt:check"], "oxfmt"],
  ["lint", ["bun", "run", "lint"], "oxlint over src + worker"],
  ["typecheck", ["bun", "run", "typecheck"], "tsc over the app"],
  ["typecheck:worker", ["bun", "run", "typecheck:worker"], "tsc over worker/"],
  ["typecheck:test", ["bun", "run", "typecheck:test"], "tsc over the tests"],
  [
    "test",
    ["bun", "run", "test"],
    "vitest: src node pool + worker workerd pool",
  ],
  ["check:docs", ["bun", "run", "check:docs"], "every doc pointer resolves"],
  [
    "test:e2e",
    ["bun", "run", "test:e2e"],
    "playwright against self-booted wrangler dev",
  ],
];

const results: Array<[string, string]> = [];
const startedAt = Date.now();

for (const [name, cmd, docs] of STEPS) {
  log(`${name} - ${docs}`);
  const stepStart = Date.now();
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  const secs = ((Date.now() - stepStart) / 1000).toFixed(1);
  results.push([
    name,
    code === 0 ? `passed (${secs}s)` : `FAILED (exit ${code})`,
  ]);
  if (code !== 0) break;
}

console.log("");
log(`summary (${((Date.now() - startedAt) / 1000).toFixed(1)}s total):`);
for (const [name, outcome] of results) {
  console.log(
    `  ${outcome.startsWith("passed") ? "✔" : "✖"} ${name}: ${outcome}`,
  );
}

if (results.some(([, o]) => !o.startsWith("passed"))) process.exit(1);
