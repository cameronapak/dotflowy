#!/usr/bin/env bun
/**
 * Guards the app browser lanes.
 *
 * CI runs the app suite as separate lanes so a Chromium runner does not
 * install WebKit. Each lane is a package script that selects Playwright
 * projects by name. A project that matches no lane would stop running in CI
 * without any failure. This check lists the whole suite and every lane, and
 * requires each test to appear in exactly one lane.
 */
import { $ } from "bun";

/** The lane scripts CI runs. Add a lane here and in `.github/workflows/ci.yml`. */
const LANES = ["test:e2e:app:chromium", "test:e2e:app:webkit"];

/** `playwright test --list` prints one `[project] › file:line:column › title` row per test. */
async function list(script: string): Promise<string[]> {
  const output = await $`bun run --silent ${script} --list`.text();
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
console.log(
  `App browser lanes OK (${all.length} tests, each in exactly one of ${LANES.length} lanes).`,
);
