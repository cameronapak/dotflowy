import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

interface CliPackageScripts {
  build?: unknown;
  changeset?: unknown;
  prepack?: unknown;
  test?: unknown;
  typecheck?: unknown;
  version?: unknown;
  install?: unknown;
  postinstall?: unknown;
  postuninstall?: unknown;
  preinstall?: unknown;
  preuninstall?: unknown;
  uninstall?: unknown;
}

export interface CliPackageManifest {
  author?: unknown;
  bin?: unknown;
  bugs?: unknown;
  bundledDependencies?: unknown;
  contributors?: unknown;
  cpu?: unknown;
  dependencies?: unknown;
  description?: unknown;
  version?: unknown;
  devDependencies?: unknown;
  engines?: unknown;
  exports?: unknown;
  files?: unknown;
  funding?: unknown;
  homepage?: unknown;
  keywords?: unknown;
  license?: unknown;
  main?: unknown;
  module?: unknown;
  name?: unknown;
  optionalDependencies?: unknown;
  os?: unknown;
  peerDependencies?: unknown;
  peerDependenciesMeta?: unknown;
  publishConfig?: unknown;
  repository?: unknown;
  scripts?: CliPackageScripts;
  type?: unknown;
  types?: unknown;
}

function publishedManifest(manifest: CliPackageManifest) {
  const {
    version: _version,
    devDependencies: _devDependencies,
    scripts,
    ...metadata
  } = manifest;
  const installedScripts = Object.fromEntries(
    [
      ["install", scripts?.install],
      ["postinstall", scripts?.postinstall],
      ["postuninstall", scripts?.postuninstall],
      ["preinstall", scripts?.preinstall],
      ["preuninstall", scripts?.preuninstall],
      ["uninstall", scripts?.uninstall],
    ].filter(([, command]) => command !== undefined),
  );
  return Object.keys(installedScripts).length
    ? { ...metadata, scripts: installedScripts }
    : metadata;
}

export function requiresCliChangeset(
  changed: readonly string[],
  previousManifest?: CliPackageManifest,
  currentManifest?: CliPackageManifest,
): boolean {
  if (
    changed.some(
      (path) =>
        path.startsWith("cli/src/") ||
        path === "cli/README.md" ||
        path === "cli/LICENSE",
    )
  ) {
    return true;
  }
  if (!changed.includes("cli/package.json")) return false;
  if (!previousManifest || !currentManifest) {
    throw new Error(
      "package manifests are required when cli/package.json changes",
    );
  }
  return !isDeepStrictEqual(
    publishedManifest(previousManifest),
    publishedManifest(currentManifest),
  );
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }
  return result.stdout.toString();
}

function parseManifest(source: string): CliPackageManifest {
  // SAFETY: Both inputs are repository-owned package.json objects; comparison uses own fields only.
  return JSON.parse(source) as CliPackageManifest;
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base)
    throw new Error("usage: bun scripts/require-changeset.ts <base-ref>");

  const changed = git("diff", "--name-only", `${base}...HEAD`)
    .trim()
    .split("\n")
    .filter(Boolean);
  const packageChanged = changed.includes("cli/package.json");
  const previous = packageChanged
    ? parseManifest(git("show", `${base}:cli/package.json`))
    : undefined;
  const current = packageChanged
    ? parseManifest(readFileSync("package.json", "utf8"))
    : undefined;

  if (!requiresCliChangeset(changed, previous, current)) {
    console.log("No packaged CLI behavior changed; no CLI changeset required.");
    process.exit(0);
  }

  const output = join(tmpdir(), `dotflowy-cli-changeset-${process.pid}.json`);
  const status = Bun.spawnSync(
    ["bunx", "changeset", "status", `--since=${base}`, `--output=${output}`],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (status.exitCode !== 0) process.exit(status.exitCode);

  // SAFETY: Changesets owns this output file; only the optional release names are read below.
  const report = JSON.parse(readFileSync(output, "utf8")) as {
    releases?: Array<{ name: string }>;
  };
  rmSync(output, { force: true });
  if (!report.releases?.some(({ name }) => name === "dotflowy")) {
    throw new Error(
      "Packaged CLI behavior changed without a CLI changeset. Run `bun run changeset` in cli/.",
    );
  }

  console.log("Packaged CLI behavior has a dotflowy changeset.");
}
