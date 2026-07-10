/**
 * Cut a release (ADR 0046).
 *
 * `bun run release` — the ONLY supported way to bump the version:
 *
 *   1. read the `.changeset/` fragments into memory and validate them
 *   2. `changeset version` — bumps package.json, regenerates CHANGELOG.md, and
 *      DELETES the fragments (which is why step 1 comes first)
 *   3. write the fragments to `changelog/<newVersion>/` + append the manifest line
 *   4. re-run the build-time invariant, so a bad archive fails here, not in CI
 *   5. commit + tag
 *
 * `bun run release:publish` — push the tag and open the GitHub Release, whose
 * notes are the CHANGELOG.md section for the current version, verbatim. That
 * markdown is written for humans; the app reads `changelog/**`, never this.
 *
 * Split in two on purpose: step 5 leaves a commit to read before anything
 * becomes public, and publishing is separately re-runnable if `gh` hiccups.
 */

import { $ } from "bun";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFragment } from "../src/data/changelog";
import { loadChangelog } from "./vite-plugin-changelog";

const ROOT = new URL("..", import.meta.url).pathname;
const CHANGESET_DIR = join(ROOT, ".changeset");
const CHANGELOG_DIR = join(ROOT, "changelog");
const MANIFEST = join(CHANGELOG_DIR, "manifest.json");

function die(message: string): never {
  console.error(`\nrelease: ${message}\n`);
  process.exit(1);
}

function packageVersion(): string {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

/** The local calendar day. Never `toISOString` — that is UTC, and a release cut
 *  at 6pm Pacific would be dated tomorrow (the daily-notes rule). */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function version() {
  if ((await $`git status --porcelain`.text()).trim()) {
    die("the working tree is dirty. Commit or stash first.");
  }

  const files = readdirSync(CHANGESET_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();
  if (files.length === 0) {
    die(
      "no changesets to release. Every PR adds one (`bunx changeset`, or `bunx changeset --empty` when it isn't news).",
    );
  }

  // Read + validate BEFORE `changeset version` deletes them.
  const fragments = files.map((f) => ({
    name: f,
    source: readFileSync(join(CHANGESET_DIR, f), "utf8"),
  }));
  let entries = 0;
  for (const { name, source } of fragments) {
    const parsed = parseFragment(source);
    if (parsed instanceof Error) die(`.changeset/${name}: ${parsed.message}`);
    if (parsed) entries += 1;
  }
  if (entries === 0) {
    die(
      `${files.length} changeset(s), all empty — there is nothing to tell anyone, and no version to bump.`,
    );
  }

  const before = packageVersion();
  await $`bunx changeset version`;
  const after = packageVersion();
  if (after === before) {
    // Unreachable given the all-empty guard above, but `changeset version` has
    // already eaten the fragments by this point, so say how to get them back
    // rather than leaving a half-consumed tree.
    die(
      `changeset version left the version at ${before}, and nothing was archived.\n` +
        `  The fragments it deleted are recoverable: git restore --staged --worktree .`,
    );
  }

  const releaseDir = join(CHANGELOG_DIR, after);
  if (existsSync(releaseDir)) die(`changelog/${after}/ already exists.`);
  mkdirSync(releaseDir, { recursive: true });
  for (const { name, source } of fragments) {
    writeFileSync(join(releaseDir, name), source);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  manifest.releases.push({ version: after, date: today() });
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  // The same function `vite build` runs. A bad archive fails here, before the
  // commit, rather than in CI on a branch that already claims to be a release.
  const loaded = loadChangelog(CHANGELOG_DIR, after);
  if (loaded instanceof Error) die(loaded.message);

  await $`git add -A`;
  await $`git commit -m ${`chore(release): v${after}`}`;
  await $`git tag ${`v${after}`}`;

  console.log(`
release: v${before} -> v${after}  (${entries} entr${entries === 1 ? "y" : "ies"})

  Review:  git show HEAD
  Publish: git push --follow-tags && bun run release:publish
  Deploy:  bun run deploy
`);
}

/** The CHANGELOG.md section for `version`, verbatim — the GitHub Release body.
 *  This is the ONLY place CHANGELOG.md is read, and it never becomes app data. */
function releaseNotes(version: string): string {
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const start = changelog.indexOf(`\n## ${version}\n`);
  if (start === -1) die(`CHANGELOG.md has no "## ${version}" section.`);
  const from = start + `\n## ${version}\n`.length;
  const next = changelog.indexOf("\n## ", from);
  const body = (
    next === -1 ? changelog.slice(from) : changelog.slice(from, next)
  ).trim();
  if (!body) die(`CHANGELOG.md's "## ${version}" section is empty.`);
  return body;
}

async function publish() {
  const v = packageVersion();
  const notes = releaseNotes(v);
  const tmp = join(tmpdir(), `dotflowy-release-notes-v${v}.md`);
  writeFileSync(tmp, `${notes}\n`);
  await $`gh release create ${`v${v}`} --title ${`v${v}`} --notes-file ${tmp} --verify-tag`;
  console.log(
    `\nrelease: published v${v}. The Atom feed picks it up automatically.\n`,
  );
}

const mode = process.argv[2];
if (mode === "--publish") await publish();
else if (mode === undefined) await version();
else die(`unknown argument "${mode}" (expected nothing, or --publish)`);
