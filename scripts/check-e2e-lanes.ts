#!/usr/bin/env bun
/**
 * Guards the app browser lanes.
 *
 * CI runs the app suite as separate lanes so a Chromium runner does not
 * install WebKit. Each lane is a package script that selects Playwright
 * projects by name. A project that matches no lane would stop running in CI
 * without any failure. This check lists the whole suite and every lane, and
 * requires each test to appear in exactly one lane.
 *
 * The Chromium lane is split again into shards that `scripts/e2e-shards.ts`
 * fills by recorded time. This check lists every shard the workflow runs and
 * requires each Chromium test to appear in exactly one shard.
 */
import { $ } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { shardFiles } from "./e2e-shards";

/** The lane scripts CI runs. Add a lane here and in `.github/workflows/ci.yml`. */
const LANES = ["test:e2e:app:chromium", "test:e2e:app:webkit"];

/** `playwright test --list` prints one `[project] › file:line:column › title` row per test. */
async function list(script: string, files: string[] = []): Promise<string[]> {
  const output = await $`bun run --silent ${script} ${files} --list`.text();
  const tests = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("["));
  if (tests.length === 0) {
    console.error(`${script} --list reported no tests`);
    process.exit(1);
  }
  return tests;
}

const all = await list("test:e2e:app");
const laneOf = new Map<string, string>();
const problems: string[] = [];

for (const lane of LANES) {
  for (const test of await list(lane)) {
    const earlier = laneOf.get(test);
    if (earlier) problems.push(`in both ${earlier} and ${lane}: ${test}`);
    laneOf.set(test, lane);
  }
}
for (const test of all) {
  if (!laneOf.has(test)) problems.push(`in no lane: ${test}`);
}
const known = new Set(all);
for (const test of laneOf.keys()) {
  if (!known.has(test)) problems.push(`not in the full suite: ${test}`);
}

if (problems.length > 0) {
  console.error(
    `App browser lanes do not cover the suite exactly once (${problems.length} problems):`,
  );
  for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
  process.exit(1);
}
// The shard numbers come from the workflow, so the check covers the shards CI
// runs, not the shards this script assumes.
const CHROMIUM = "test:e2e:app:chromium";
const workflow = readFileSync(
  join(import.meta.dir, "../.github/workflows/ci.yml"),
  "utf8",
);
const matrix = /^\s+shard: \[([\d, ]+)\]$/m.exec(workflow)?.[1];
const shards = matrix?.split(",").map((value) => Number(value.trim())) ?? [];
if (shards.length === 0 || shards.some((shard, i) => shard !== i + 1)) {
  console.error(
    `ci.yml must list the app shards as 1..N, found: ${matrix ?? "nothing"}`,
  );
  process.exit(1);
}
const shardOf = new Map<string, number>();
const listed = await Promise.all(
  (await shardFiles(shards.length)).map((files) => list(CHROMIUM, files)),
);
for (const [index, tests] of listed.entries()) {
  for (const test of tests) {
    const earlier = shardOf.get(test);
    if (earlier) {
      problems.push(`in shards ${earlier} and ${index + 1}: ${test}`);
    }
    shardOf.set(test, index + 1);
  }
}
const chromium = [...laneOf].filter(([, lane]) => lane === CHROMIUM);
for (const [test] of chromium) {
  if (!shardOf.has(test)) problems.push(`in no Chromium shard: ${test}`);
}
for (const test of shardOf.keys()) {
  if (laneOf.get(test) !== CHROMIUM) {
    problems.push(`in a Chromium shard but not the Chromium lane: ${test}`);
  }
}
if (problems.length > 0) {
  console.error(
    `Chromium shards do not cover the lane exactly once (${problems.length} problems):`,
  );
  for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `App browser lanes OK (${all.length} tests, each in exactly one of ${LANES.length} lanes; ${chromium.length} Chromium tests, each in exactly one of ${shards.length} shards).`,
);
