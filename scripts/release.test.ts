import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function run(dir: string, command: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(command, {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${dir}/.test-bin:${dirname(process.execPath)}:${process.env.PATH}`,
      HUSKY: "0",
      ...env,
    },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

function git(dir: string, ...args: string[]) {
  const result = run(dir, ["git", ...args]);
  if (result.code !== 0) throw new Error(result.err);
  return result.out;
}

function fixture(fragments: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dotflowy-release-"));
  fixtures.push(dir);
  for (const path of [
    "scripts",
    "src/data",
    ".changeset",
    "changelog/1.2.3",
    ".test-bin",
  ]) {
    mkdirSync(join(dir, path), { recursive: true });
  }
  for (const path of [
    "scripts/release.ts",
    "scripts/vite-plugin-changelog.ts",
    "src/data/changelog.ts",
    ".changeset/config.json",
  ]) {
    copyFileSync(join(ROOT, path), join(dir, path));
  }
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n.test-bin\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "dotflowy", version: "1.2.3", private: true }),
  );
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    "# dotflowy\n\n## 1.2.3\n\nInitial release.\n",
  );
  writeFileSync(
    join(dir, "changelog/1.2.3/initial.md"),
    '---\n"dotflowy": patch\n---\n\nInitial release.\n',
  );
  writeFileSync(
    join(dir, "changelog/manifest.json"),
    JSON.stringify({ releases: [{ version: "1.2.3", date: "2026-09-01" }] }),
  );
  for (const [name, source] of Object.entries(fragments)) {
    writeFileSync(join(dir, ".changeset", name), source);
  }
  // Never call real GitHub, even if the test's environment has credentials.
  writeFileSync(
    join(dir, ".test-bin/gh"),
    `#!/bin/sh
if [ "$1" = api ]; then
  case "$GH_TEST_STATUS" in
    published) echo '{"draft":false}'; exit 0 ;;
    draft) echo '{"draft":true}'; exit 0 ;;
    missing) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
    *) echo 'gh: Forbidden (HTTP 403)' >&2; exit 1 ;;
  esac
fi
printf '%s\\n' "$*" >> .test-bin/created
`,
  );
  chmodSync(join(dir, ".test-bin/gh"), 0o755);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "Release Test");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fixture");
  return dir;
}

function release(dir: string, mode: string, env: Record<string, string> = {}) {
  return run(dir, [process.execPath, "scripts/release.ts", mode], env);
}

test("CI skips absent and empty changesets without a commit or version bump", () => {
  const cases: Record<string, string>[] = [{}, { "empty.md": "---\n---\n" }];
  for (const fragments of cases) {
    const dir = fixture(fragments);
    const head = git(dir, "rev-parse", "HEAD");
    expect(release(dir, "--ci").code).toBe(0);
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "tag")).toBe("");
    expect(
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version,
    ).toBe("1.2.3");
  }
});

test("CI validates fragments before consuming them, including beside real news", () => {
  const malformed = "This is not a changeset.\n";
  const dir = fixture({
    "bad.md": malformed,
    "news.md": '---\n"dotflowy": minor\n---\n\nA capability.\n',
  });
  const head = git(dir, "rev-parse", "HEAD");
  expect(release(dir, "--ci").code).not.toBe(0);
  expect(readFileSync(join(dir, ".changeset/bad.md"), "utf8")).toBe(malformed);
  expect(git(dir, "rev-parse", "HEAD")).toBe(head);
});

test("mixed news archives every fragment, uses the highest bump, and retries without another release", () => {
  const fragments = {
    "minor.md": '---\n"dotflowy": minor\n---\n\nA new capability.\n',
    "patch.md": '---\n"dotflowy": patch\n---\n\nA separate fix.\n',
    "empty.md": "---\n---\n",
  };
  const dir = fixture(fragments);
  const result = release(dir, "--ci");
  expect(result.code, result.err).toBe(0);
  expect(
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version,
  ).toBe("1.3.0");
  for (const [name, source] of Object.entries(fragments)) {
    expect(readFileSync(join(dir, "changelog/1.3.0", name), "utf8")).toBe(
      source,
    );
    expect(existsSync(join(dir, ".changeset", name))).toBe(false);
  }
  const manifest = JSON.parse(
    readFileSync(join(dir, "changelog/manifest.json"), "utf8"),
  );
  expect(
    manifest.releases.map((entry: { version: string }) => entry.version),
  ).toEqual(["1.2.3", "1.3.0"]);
  expect(git(dir, "cat-file", "-t", "v1.3.0")).toBe("tag");
  const head = git(dir, "rev-parse", "HEAD");
  expect(release(dir, "--ci").code).toBe(0);
  expect(git(dir, "rev-parse", "HEAD")).toBe(head);
  expect(git(dir, "rev-parse", "v1.3.0^{}")).toBe(head);
}, 30000);

test("publish is idempotent but only creates after a confirmed 404", () => {
  const dir = fixture();
  expect(release(dir, "--publish", { GH_TEST_STATUS: "published" }).code).toBe(
    0,
  );
  expect(existsSync(join(dir, ".test-bin/created"))).toBe(false);
  for (const status of ["forbidden", "draft"]) {
    expect(release(dir, "--publish", { GH_TEST_STATUS: status }).code).not.toBe(
      0,
    );
    expect(existsSync(join(dir, ".test-bin/created"))).toBe(false);
  }
  expect(release(dir, "--publish", { GH_TEST_STATUS: "missing" }).code).toBe(0);
  const call = readFileSync(join(dir, ".test-bin/created"), "utf8");
  expect(call).toContain("release create v1.2.3");
  expect(call).toContain("--verify-tag");
});

test("a concurrent merge rejects the release commit AND tag atomically", () => {
  const dir = fixture();
  const remote = join(dir, ".test-bin/remote.git");
  git(dir, "init", "--bare", remote);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "origin", "main");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "new-merge.txt"), "a newer merge\n");
  git(dir, "add", "new-merge.txt");
  git(dir, "commit", "-m", "newer merge");
  const newer = git(dir, "rev-parse", "HEAD");
  git(dir, "push", "origin", "main");
  git(dir, "checkout", "-b", "release-candidate", base);
  writeFileSync(join(dir, "release.txt"), "older release candidate\n");
  git(dir, "add", "release.txt");
  git(dir, "commit", "-m", "release candidate");
  git(dir, "tag", "-a", "v1.3.0", "-m", "v1.3.0");
  expect(
    run(dir, [
      "git",
      "push",
      "--atomic",
      "origin",
      "HEAD:refs/heads/main",
      "refs/tags/v1.3.0:refs/tags/v1.3.0",
    ]).code,
  ).not.toBe(0);
  expect(git(dir, "--git-dir", remote, "rev-parse", "main")).toBe(newer);
  expect(git(dir, "--git-dir", remote, "tag")).toBe("");
});

test("deployment uses validated main and stops at each failed release/deploy step", () => {
  // SAFETY: This is the checked-in workflow validated by actionlint. The
  // assertions below fail if its job/step contract changes.
  const workflow = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8"),
  ) as {
    concurrency: { "cancel-in-progress": boolean };
    jobs: {
      select: { steps: { with?: { ref: string } }[] };
      quality: { needs: string; with: { ref: string } };
      deploy: {
        needs: string[];
        steps: {
          name?: string;
          run?: string;
          "working-directory"?: string;
          if?: string;
          "continue-on-error"?: boolean;
        }[];
      };
    };
  };
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  expect(workflow.jobs.select.steps[0]?.with?.ref).toBe("main");
  expect(workflow.jobs.quality.needs).toBe("select");
  expect(workflow.jobs.quality.with.ref).toBe(
    "${{ needs.select.outputs.ref }}",
  );
  expect(workflow.jobs.deploy.needs).toContain("quality");
  const expected = [
    "Build app",
    "Build landing",
    "Push release commit and tag atomically",
    "Publish GitHub Release",
    "Deploy landing",
    "Deploy app",
  ];
  const steps = workflow.jobs.deploy.steps.filter((step) =>
    expected.includes(step.name ?? ""),
  );
  expect(steps.map((step) => step.name)).toEqual(expected);
  for (const failure of [undefined, ...expected]) {
    const dir = fixture();
    mkdirSync(join(dir, "landing"));
    const calls = join(dir, ".test-bin/calls");
    for (const tool of ["bun", "bunx", "git"]) {
      const path = join(dir, ".test-bin", tool);
      writeFileSync(
        path,
        `#!/bin/sh
if [ "$1" = -p ]; then echo 1.2.3; exit 0; fi
printf '%s\\n' "$TEST_STEP" >> "$TEST_CALLS"
if [ "$TEST_STEP" = "$TEST_FAILURE" ]; then exit 1; fi
`,
      );
      chmodSync(path, 0o755);
    }
    for (const step of steps) {
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).not.toBe(true);
      const result = run(
        join(dir, step["working-directory"] ?? "."),
        ["bash", "-e", "-o", "pipefail", "-c", step.run!],
        {
          PATH: `${dir}/.test-bin:${process.env.PATH}`,
          TEST_STEP: step.name!,
          TEST_FAILURE: failure ?? "",
          TEST_CALLS: calls,
        },
      );
      if (result.code !== 0) {
        expect(step.name).toBe(failure);
        break;
      }
    }
    const completed = readFileSync(calls, "utf8").trim().split("\n");
    expect(completed).toEqual(
      failure ? expected.slice(0, expected.indexOf(failure) + 1) : expected,
    );
  }
});
