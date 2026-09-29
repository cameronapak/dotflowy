import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const result = Bun.spawnSync(
  ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: root, stdout: "pipe", stderr: "pipe" },
);

if (result.exitCode !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

// SAFETY: `npm pack --json` owns this documented report shape; all consumed fields are checked below.
const reports = JSON.parse(result.stdout.toString()) as Array<{
  name: string;
  version: string;
  files: Array<{ path: string }>;
}>;
const report = reports[0];
// SAFETY: package.json is repository-owned and these required string fields are validated by npm pack.
const manifest = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as { name: string; version: string };

if (
  !report ||
  report.name !== manifest.name ||
  report.version !== manifest.version
) {
  throw new Error(
    "npm pack reported package metadata that does not match package.json",
  );
}

const files = new Set(report.files.map(({ path }) => path));
for (const required of [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/main.js",
]) {
  if (!files.has(required))
    throw new Error(`npm package is missing ${required}`);
}

for (const path of files) {
  if (
    path.startsWith("src/") ||
    path.startsWith("test/") ||
    path.startsWith("scripts/") ||
    path.startsWith(".changeset/") ||
    path.startsWith("tsconfig")
  ) {
    throw new Error(`npm package unexpectedly includes ${path}`);
  }
}

console.log(
  `checked ${manifest.name}@${manifest.version}: ${files.size} files`,
);
