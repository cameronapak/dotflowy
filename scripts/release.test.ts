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

function workflowStep(file: string, job: string, name: string) {
  // SAFETY: Checked-in workflow structure; actionlint validates the YAML.
  const workflow = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github/workflows", file), "utf8"),
  ) as { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };
  const step = workflow.jobs[job]?.steps.find((step) => step.name === name);
  if (!step?.run) throw new Error(`Missing ${file}: ${name}`);
  return step.run;
}

function candidateFixture(news = true) {
  const dir = fixture(
    news ? { "news.md": '---\n"dotflowy": minor\n---\n\nNews.\n' } : {},
  );
  const remote = join(dir, ".test-bin/origin.git");
  git(dir, "init", "--bare", remote);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "tag", "-a", "v1.2.3", "-m", "previous release");
  git(dir, "push", "origin", "main", "v1.2.3");
  const base = git(dir, "rev-parse", "HEAD");
  const prepared = release(dir, "--ci");
  expect(prepared.code, prepared.err).toBe(0);
  const sha = git(dir, "rev-parse", "HEAD");
  const branch = "release-candidate/42-3";
  const env = {
    RELEASE_BASE: base,
    GITHUB_REPOSITORY: "example/dotflowy",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "3",
    GITHUB_ENV: join(dir, ".test-bin/candidate.env"),
    GITHUB_STEP_SUMMARY: join(dir, ".test-bin/summary"),
  };
  const validation = {
    head_sha: sha,
    head_branch: branch,
    repository: { full_name: "example/dotflowy" },
    head_repository: { full_name: "example/dotflowy" },
    path: ".github/workflows/cli.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    run_attempt: 2,
  };
  const jobs = [
    "test (ubuntu-latest, 22)",
    "test (ubuntu-latest, 24)",
    "test (macos-latest, 22)",
    "test (macos-latest, 24)",
    "test (windows-latest, 22)",
    "test (windows-latest, 24)",
    "changeset",
  ].map((name) => ({
    name,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
  }));
  // A fixture boundary for GitHub only. Every push targets the real local bare
  // origin; no test can publish a tag or branch to GitHub.
  writeFileSync(
    join(dir, ".test-bin/gh"),
    `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const endpoint = args.find(arg => arg.startsWith("repos/"));
let reply;
if (endpoint?.endsWith("/dispatches")) {
  const input = JSON.parse(await Bun.stdin.text());
  if (input.ref !== "release-candidate/42-3" || input.inputs.base_sha !== process.env.RELEASE_BASE) process.exit(1);
  reply = JSON.parse(readFileSync(".test-bin/dispatch.json", "utf8"));
} else if (endpoint?.endsWith("/attempts/2/jobs?per_page=100")) {
  reply = JSON.parse(readFileSync(".test-bin/jobs.json", "utf8"));
} else if (endpoint?.endsWith("/runs/171/cancel")) {
  const run = JSON.parse(readFileSync(".test-bin/run.json", "utf8"));
  await Bun.write(".test-bin/run.json", JSON.stringify({ ...run, status: "completed", conclusion: "cancelled" }));
  reply = {};
} else if (endpoint?.endsWith("/runs/171")) {
  reply = JSON.parse(readFileSync(".test-bin/run.json", "utf8"));
} else process.exit(1);
process.stdout.write(args.includes("--jq") ? reply.status : JSON.stringify(reply));
`,
  );
  writeFileSync(
    join(dir, ".test-bin/dispatch.json"),
    '{"workflow_run_id":171}',
  );
  writeFileSync(join(dir, ".test-bin/run.json"), JSON.stringify(validation));
  writeFileSync(
    join(dir, ".test-bin/jobs.json"),
    JSON.stringify({ total_count: jobs.length, jobs }),
  );
  return { dir, base, sha, branch, env, validation, jobs };
}

function promote(dir: string, env: Record<string, string>) {
  return run(
    dir,
    [
      "bash",
      "-e",
      "-o",
      "pipefail",
      "-c",
      `${workflowStep("deploy.yml", "deploy", "Validate exact release candidate")}
set -a
source "$GITHUB_ENV"
set +a
${workflowStep("deploy.yml", "deploy", "Push release commit and tag atomically")}`,
    ],
    env,
  );
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

test("deployment builds validated main before atomic push, publishing, and deployment", () => {
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
          with?: { ref: string };
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
  expect(workflow.jobs.deploy.steps[0]?.with?.ref).toBe(
    "${{ needs.select.outputs.ref }}",
  );
  const expected = [
    "Build app",
    "Build landing",
    "Validate exact release candidate",
    "Push release commit and tag atomically",
    "Publish GitHub Release",
    "Deploy landing",
    "Deploy app",
  ];
  const steps = workflow.jobs.deploy.steps.filter((step) =>
    expected.includes(step.name ?? ""),
  );
  expect(steps.map((step) => step.name)).toEqual(expected);
  expect(steps[3]?.run).toContain(
    'git push --atomic origin HEAD:refs/heads/main "refs/tags/$tag:refs/tags/$tag"',
  );
  expect(steps[4]?.run).toBe("bun run release:publish");
  expect(steps[5]?.["working-directory"]).toBe("landing");
  const dir = mkdtempSync(join(tmpdir(), "dotflowy-deploy-"));
  fixtures.push(dir);
  mkdirSync(join(dir, ".test-bin"));
  mkdirSync(join(dir, "landing"));
  for (const tool of ["bun", "bunx", "git"]) {
    const path = join(dir, ".test-bin", tool);
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$1" = -p ]; then echo 1.2.3; exit 0; fi
exit 23
`,
    );
    chmodSync(path, 0o755);
  }
  for (const step of steps) {
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).not.toBe(true);
    // Candidate validation/promotion use real Git origins in the tests below.
    if (
      step.name === "Validate exact release candidate" ||
      step.name === "Push release commit and tag atomically"
    )
      continue;
    const result = run(
      join(dir, step["working-directory"] ?? "."),
      ["bash", "-e", "-o", "pipefail", "-c", step.run!],
      { PATH: `${dir}/.test-bin:${process.env.PATH}` },
    );
    expect(result.code, step.name).toBe(23);
  }
});

test("only the checked SHA is promoted, including no-news retries, and its temporary branch is cleaned up", () => {
  for (const news of [true, false]) {
    const { dir, base, sha, branch, env } = candidateFixture(news);
    const result = promote(dir, env);
    expect(result.code, result.err).toBe(0);
    expect(git(dir, "ls-remote", "origin", "refs/heads/main")).toBe(
      `${sha}\trefs/heads/main`,
    );
    const version = news ? "1.3.0" : "1.2.3";
    expect(git(dir, "ls-remote", "origin", `refs/tags/v${version}^{}`)).toBe(
      `${sha}\trefs/tags/v${version}^{}`,
    );
    expect(sha === base).toBe(!news);
    const cleanup = run(
      dir,
      [
        "bash",
        "-e",
        "-o",
        "pipefail",
        "-c",
        `set -a; source "$GITHUB_ENV"; set +a\n${workflowStep("deploy.yml", "deploy", "Clean up release candidate")}`,
      ],
      env,
    );
    expect(cleanup.code, cleanup.err).toBe(0);
    expect(git(dir, "ls-remote", "origin", `refs/heads/${branch}`)).toBe("");
    expect(git(dir, "rev-parse", "HEAD")).toBe(sha);
  }
}, 30000);

test("failed or misattributed validation never promotes main or publishes the local release tag", () => {
  const cases = [
    "failed",
    "wrong-sha",
    "wrong-workflow",
    "missing-job",
    "skipped-job",
    "wrong-job-sha",
    "lost-dispatch",
  ];
  for (const scenario of cases) {
    const { dir, base, env, validation, jobs } = candidateFixture();
    if (scenario === "failed") validation.conclusion = "failure";
    if (scenario === "wrong-sha") validation.head_sha = base;
    if (scenario === "wrong-workflow")
      validation.path = ".github/workflows/other.yml";
    if (scenario === "missing-job") jobs.splice(3, 1);
    if (scenario === "skipped-job") jobs[6]!.conclusion = "skipped";
    if (scenario === "wrong-job-sha") jobs[0]!.head_sha = base;
    if (scenario === "lost-dispatch")
      writeFileSync(join(dir, ".test-bin/dispatch.json"), "{}");
    writeFileSync(join(dir, ".test-bin/run.json"), JSON.stringify(validation));
    writeFileSync(
      join(dir, ".test-bin/jobs.json"),
      JSON.stringify({ total_count: jobs.length, jobs }),
    );
    expect(promote(dir, env).code, scenario).not.toBe(0);
    expect(git(dir, "ls-remote", "origin", "refs/heads/main"), scenario).toBe(
      `${base}\trefs/heads/main`,
    );
    expect(git(dir, "ls-remote", "origin", "refs/tags/v1.3.0"), scenario).toBe(
      "",
    );
  }
}, 30000);

test("a concurrent merge or conflicting tag rejects promotion without publishing either ref", () => {
  for (const conflict of ["main", "late-main", "tag"]) {
    const { dir, base, env } = candidateFixture();
    let main = base;
    if (conflict !== "tag") {
      git(dir, "checkout", "-b", "concurrent", base);
      git(dir, "commit", "--allow-empty", "-m", "concurrent merge");
      main = git(dir, "rev-parse", "HEAD");
      if (conflict === "main") {
        git(dir, "push", "origin", "HEAD:refs/heads/main");
      } else {
        // Advance the remote after ls-remote has passed, during the actual
        // promotion push. Git must reject both main and the new tag atomically.
        git(dir, "push", "origin", "HEAD:refs/heads/concurrent");
        git(dir, "config", "core.hooksPath", ".git/hooks");
        const hook = join(dir, ".git/hooks/pre-push");
        writeFileSync(
          hook,
          `#!/bin/sh
while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = refs/heads/main ]; then
    git --git-dir=.test-bin/origin.git update-ref refs/heads/main ${main} ${base} || exit 1
  fi
done
`,
        );
        chmodSync(hook, 0o755);
      }
      git(dir, "checkout", "main");
    } else {
      git(dir, "push", "origin", `${base}:refs/tags/v1.3.0`);
    }
    const result = promote(dir, env);
    expect(result.code, `${conflict}: ${result.err}`).not.toBe(0);
    expect(
      git(dir, "ls-remote", "origin", "refs/heads/main"),
      `${conflict}: ${result.err}`,
    ).toBe(`${main}\trefs/heads/main`);
    expect(git(dir, "ls-remote", "origin", "refs/tags/v1.3.0")).toBe(
      conflict === "tag" ? `${base}\trefs/tags/v1.3.0` : "",
    );
  }
}, 30000);

test("queued validation expires without promotion", () => {
  const { dir, base, env, validation } = candidateFixture();
  writeFileSync(
    join(dir, ".test-bin/run.json"),
    JSON.stringify({ ...validation, status: "queued", conclusion: null }),
  );
  const result = run(
    dir,
    [
      "bash",
      "-e",
      "-o",
      "pipefail",
      "-c",
      `
# Advance Bash's elapsed clock at the polling boundary, without a real wait.
sleep() { SECONDS=10000; }
${workflowStep("deploy.yml", "deploy", "Validate exact release candidate")}
set -a; source "$GITHUB_ENV"; set +a
${workflowStep("deploy.yml", "deploy", "Push release commit and tag atomically")}`,
    ],
    env,
  );
  expect(result.code).not.toBe(0);
  expect(git(dir, "ls-remote", "origin", "refs/heads/main")).toBe(
    `${base}\trefs/heads/main`,
  );
  expect(git(dir, "ls-remote", "origin", "refs/tags/v1.3.0")).toBe("");
});

test("cleanup cancels known unfinished validation but retains a branch when dispatch outcome is unknown", () => {
  for (const known of [true, false]) {
    const { dir, sha, branch, env, validation } = candidateFixture(false);
    git(dir, "push", "origin", `${sha}:refs/heads/${branch}`);
    git(
      dir,
      "push",
      "origin",
      `${sha}:refs/heads/release-candidate/another-attempt`,
    );
    writeFileSync(
      join(dir, ".test-bin/run.json"),
      JSON.stringify({
        ...validation,
        status: "in_progress",
        conclusion: null,
      }),
    );
    const result = run(
      dir,
      [
        "bash",
        "-e",
        "-o",
        "pipefail",
        "-c",
        workflowStep("deploy.yml", "deploy", "Clean up release candidate"),
      ],
      {
        ...env,
        CANDIDATE_SHA: sha,
        CANDIDATE_BRANCH: branch,
        CANDIDATE_RUN: known ? "171" : "",
      },
    );
    expect(result.code, result.err).toBe(0);
    expect(git(dir, "ls-remote", "origin", `refs/heads/${branch}`)).toBe(
      known ? "" : `${sha}\trefs/heads/${branch}`,
    );
    expect(
      git(
        dir,
        "ls-remote",
        "origin",
        "refs/heads/release-candidate/another-attempt",
      ),
    ).toBe(`${sha}\trefs/heads/release-candidate/another-attempt`);
  }
});

test("the CLI changeset gate checks real content on PRs and validates the dispatched comparison base", () => {
  const { dir } = candidateFixture(false);
  for (const path of ["cli/scripts", "cli/src", "cli/.changeset"])
    mkdirSync(join(dir, path), { recursive: true });
  copyFileSync(
    join(ROOT, "cli/scripts/require-changeset.ts"),
    join(dir, "cli/scripts/require-changeset.ts"),
  );
  copyFileSync(
    join(ROOT, "cli/.changeset/config.json"),
    join(dir, "cli/.changeset/config.json"),
  );
  const manifest = {
    name: "dotflowy",
    version: "0.1.0",
    scripts: { "check:changeset": "bun scripts/require-changeset.ts" },
  };
  writeFileSync(join(dir, "cli/package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "cli/src/main.ts"), 'console.log("original");\n');
  git(dir, "add", "cli");
  git(dir, "commit", "-m", "CLI fixture");
  git(dir, "push", "origin", "main");
  const base = git(dir, "rev-parse", "HEAD");
  const cases = [
    ["docs", "pull_request", true],
    ["source", "pull_request", false],
    ["source-with-fragment", "pull_request", true],
    ["version", "pull_request", true],
    ["no-news", "workflow_dispatch", true],
    ["app-version", "workflow_dispatch", true],
    ["source", "workflow_dispatch", false],
    ["self-base", "workflow_dispatch", false],
    ["two-commits", "workflow_dispatch", false],
  ] as const;
  for (const [scenario, event, accepted] of cases) {
    git(dir, "reset", "--hard", base);
    if (scenario === "version")
      writeFileSync(
        join(dir, "cli/package.json"),
        JSON.stringify({ ...manifest, version: "0.2.0" }),
      );
    else if (scenario.startsWith("source") || scenario === "self-base")
      writeFileSync(join(dir, "cli/src/main.ts"), 'console.log("changed");\n');
    else if (scenario === "docs")
      writeFileSync(join(dir, "README.md"), "Repository docs.\n");
    else if (scenario !== "no-news")
      writeFileSync(
        join(dir, "package.json"),
        '{"name":"dotflowy","version":"1.2.4","private":true}',
      );
    if (scenario === "source-with-fragment")
      writeFileSync(
        join(dir, "cli/.changeset/change.md"),
        '---\n"dotflowy": patch\n---\n\nA CLI behavior change.\n',
      );
    if (scenario === "two-commits")
      git(dir, "commit", "--allow-empty", "-m", "extra ancestor");
    if (scenario !== "no-news") {
      git(dir, "add", ".");
      git(dir, "commit", "-m", scenario);
    }
    const result = run(
      join(dir, "cli"),
      [
        "bash",
        "-e",
        "-o",
        "pipefail",
        "-c",
        workflowStep(
          "cli.yml",
          "changeset",
          "Require a CLI changeset for packaged behavior",
        ),
      ],
      {
        GITHUB_EVENT_NAME: event,
        GITHUB_BASE_REF: "main",
        GITHUB_HEAD_REF: "changeset-release/main",
        CANDIDATE_BASE:
          scenario === "self-base" ? git(dir, "rev-parse", "HEAD") : base,
      },
    );
    expect(result.code === 0, `${scenario}: ${result.err}`).toBe(accepted);
  }
}, 30000);
