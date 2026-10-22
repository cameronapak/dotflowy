import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
// SAFETY: package.json is repository-owned; Changesets and npm require these string fields.
const manifest = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as { name: string; version: string };
const spec = `${manifest.name}@${manifest.version}`;
const tag = `${spec}`;
const checkOnly = process.argv[2] === "--check";

function run(command: string[], options: { allowFailure?: boolean } = {}) {
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  if (result.exitCode !== 0 && !options.allowFailure) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }
  return result;
}

const introducedCommit = run([
  "git",
  "log",
  "--first-parent",
  "--format=%H",
  "-S",
  `"version": "${manifest.version}"`,
  "--",
  "package.json",
])
  .stdout.toString()
  .trim()
  .split("\n")[0];
if (!introducedCommit) {
  throw new Error(
    `cannot find the commit that introduced dotflowy ${manifest.version}`,
  );
}

function publishedVersion(): string | undefined {
  const result = run(["npm", "view", spec, "version", "--json"], {
    allowFailure: true,
  });
  if (result.exitCode === 0) {
    // SAFETY: `npm view ... version --json` returns the package version as a JSON string.
    const version = JSON.parse(result.stdout.toString()) as string;
    if (version !== manifest.version) {
      throw new Error(
        `npm returned unexpected version ${JSON.stringify(version)} for ${spec}`,
      );
    }
    return version;
  }
  const error = result.stderr.toString();
  if (error.includes("E404")) return undefined;
  process.stderr.write(error);
  process.exit(result.exitCode);
}

let published = publishedVersion();
if (!published && manifest.version === "0.1.0") {
  console.log(
    "dotflowy@0.1.0 requires the documented one-time manual npm bootstrap; skipping automation.",
  );
  process.exit(0);
}

const remoteTag = run([
  "git",
  "ls-remote",
  "--tags",
  "origin",
  `refs/tags/${tag}`,
  `refs/tags/${tag}^{}`,
]).stdout.toString();
const remoteLines = remoteTag.trim() ? remoteTag.trim().split("\n") : [];
const peeled =
  remoteLines.find((line) => line.endsWith("^{}")) ?? remoteLines[0];
const taggedCommit = peeled?.split(/\s+/)[0];
const expectedCommit =
  manifest.version === "0.1.0"
    ? process.env.BOOTSTRAP_COMMIT || taggedCommit
    : introducedCommit;
if (!expectedCommit) {
  throw new Error(
    "BOOTSTRAP_COMMIT is required the first time dotflowy@0.1.0 metadata is reconciled",
  );
}
if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
  throw new Error(`invalid release commit ${JSON.stringify(expectedCommit)}`);
}
run(["git", "cat-file", "-e", `${expectedCommit}^{commit}`]);

if (checkOnly) {
  console.log(
    `checked ${spec}: release commit ${expectedCommit}; npm ${published ? "published" : "unpublished"}`,
  );
  process.exit(0);
}

if (remoteTag.trim()) {
  if (taggedCommit !== expectedCommit) {
    throw new Error(
      `${tag} already points to ${taggedCommit}; refusing to move it from the release commit ${expectedCommit}`,
    );
  }
  console.log(`${tag} already points to the release commit`);
} else {
  run(["git", "tag", "-a", tag, expectedCommit, "-m", tag]);
  run(["git", "push", "origin", `refs/tags/${tag}`]);
  console.log(`created immutable tag ${tag}`);
}

if (!published) {
  run(["npm", "publish", "--access", "public"]);
  published = manifest.version;
  console.log(`published ${spec}`);
} else {
  console.log(`${spec} is already published`);
}

const release = run(["gh", "release", "view", tag, "--json", "tagName"], {
  allowFailure: true,
});
if (release.exitCode === 0) {
  // SAFETY: `gh release view --json tagName` returns this selected string field.
  const found = JSON.parse(release.stdout.toString()) as { tagName: string };
  if (found.tagName !== tag)
    throw new Error(`GitHub returned conflicting release ${found.tagName}`);
  console.log(`GitHub Release ${tag} already exists`);
  process.exit(0);
}
if (!release.stderr.toString().toLowerCase().includes("release not found")) {
  process.stderr.write(release.stderr);
  process.exit(release.exitCode);
}

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const heading = `## ${manifest.version}`;
const start = changelog.indexOf(heading);
if (start === -1) throw new Error(`CHANGELOG.md has no ${heading} section`);
const bodyStart = start + heading.length;
const next = changelog.indexOf("\n## ", bodyStart);
const notes = changelog.slice(bodyStart, next === -1 ? undefined : next).trim();
if (!notes) throw new Error(`${heading} has no release notes`);
const notesFile = join(tmpdir(), `dotflowy-cli-${manifest.version}.md`);
writeFileSync(notesFile, `${notes}\n`);
run([
  "gh",
  "release",
  "create",
  tag,
  "--verify-tag",
  "--title",
  tag,
  "--notes-file",
  notesFile,
]);
console.log(`created GitHub Release ${tag}`);
