/**
 * Compile `changelog/**` into the bundle, and refuse to build without it.
 *
 * Three jobs, all at build time (ADR 0046):
 *
 * 1. **The invariant.** `changelog/<package.json version>/` must exist and must be
 *    the newest entry in the manifest. Skipping the archive is thereby impossible,
 *    not merely discouraged — a convention loses to a tired human at 11pm and to an
 *    agent that reasons its way to `changeset version`; a failed build does not.
 * 2. **The data.** The archived fragments are parsed and Effect-Schema-validated
 *    (`src/data/changelog.ts`) and served as the virtual module the app imports.
 *    A malformed entry fails the build, never production.
 * 3. **The asset.** The same array is emitted as `changelog.json`, so a branded
 *    public page later is a pure renderer rather than a rewrite.
 *
 * The parse/validate half is pure and lives in `src/data/changelog.ts` (unit-tested
 * under `bun test`); this file is its filesystem shell.
 */

import type { Plugin } from "vite";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Release, ReleaseInput } from "../src/data/changelog";

import { buildReleases } from "../src/data/changelog";

const VIRTUAL_ID = "virtual:dotflowy-changelog";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/** `bun run release` is the only supported path to a version bump. Every failure
 *  below says so, because every failure below means someone took another one. */
const RELEASE_HINT =
  "Releases are cut with `bun run release` (never `changeset version` directly), which archives the fragments before changesets deletes them. See docs/adr/0046-changelog-and-release-versioning.md.";

interface ManifestEntry {
  version: string;
  date: string;
}

function readManifest(dir: string): ManifestEntry[] | Error {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return new Error(`${path} is missing`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return new Error(`${path} is not valid JSON: ${String(e)}`);
  }
  const releases = (raw as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(releases)) {
    return new Error(`${path} must be {"releases": [{version, date}, ...]}`);
  }
  // Shape is checked properly by `buildReleases`; this only gets us to strings.
  for (const entry of releases) {
    const e = entry as Partial<ManifestEntry>;
    if (typeof e?.version !== "string" || typeof e?.date !== "string") {
      return new Error(`${path} has an entry without a string version + date`);
    }
  }
  return releases as ManifestEntry[];
}

/** Read one release's archived fragments, in stable (filename) order. */
function readFragments(dir: string, version: string): string[] | Error {
  const releaseDir = join(dir, version);
  if (!existsSync(releaseDir)) {
    return new Error(
      `changelog/${version}/ is missing, but manifest.json lists ${version}`,
    );
  }
  const files = readdirSync(releaseDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (files.length === 0) {
    return new Error(`changelog/${version}/ holds no .md fragments`);
  }
  return files.map((f) => readFileSync(join(releaseDir, f), "utf8"));
}

/** The whole changelog, newest first — or the build failure that explains why not. */
export function loadChangelog(
  dir: string,
  packageVersion: string,
): Release[] | Error {
  const manifest = readManifest(dir);
  if (manifest instanceof Error) return manifest;
  if (manifest.length === 0)
    return new Error("changelog/manifest.json is empty");

  // THE INVARIANT. Two distinct failures, because they have different causes:
  // a missing directory means the archive step was skipped; a stale manifest tail
  // means package.json was bumped some other way entirely.
  if (!existsSync(join(dir, packageVersion))) {
    return new Error(
      `changelog/${packageVersion}/ does not exist, but package.json is at ${packageVersion}. ${RELEASE_HINT}`,
    );
  }
  const newest = manifest[manifest.length - 1]!.version;
  if (newest !== packageVersion) {
    return new Error(
      `changelog/manifest.json ends at ${newest}, but package.json is at ${packageVersion}. ${RELEASE_HINT}`,
    );
  }

  const inputs: ReleaseInput[] = [];
  for (const { version, date } of manifest) {
    const fragments = readFragments(dir, version);
    if (fragments instanceof Error) return fragments;
    inputs.push({ version, date, fragments });
  }
  return buildReleases(inputs);
}

export function changelogPlugin(opts: {
  /** Absolute path to `changelog/`. */
  dir: string;
  /** `package.json`'s `version` — the release this build claims to be. */
  packageVersion: string;
}): Plugin {
  let releases: Release[] = [];

  const reload = () => {
    const loaded = loadChangelog(opts.dir, opts.packageVersion);
    if (loaded instanceof Error) throw loaded;
    releases = loaded;
  };

  return {
    name: "dotflowy:changelog",
    // Enforced in `dev` too, not just `build`: the only way to reach a broken
    // archive is to have bypassed `bun run release`, and finding that out at
    // deploy time rather than on the next `bun run dev` is strictly worse.
    buildStart: reload,
    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : null),
    load(id) {
      if (id !== RESOLVED_ID) return null;
      return `export const releases = ${JSON.stringify(releases)};`;
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "changelog.json",
        source: `${JSON.stringify({ releases }, null, 2)}\n`,
      });
    },
  };
}
