#!/usr/bin/env bun
/**
 * Fills the Chromium app shards by recorded time.
 *
 * Playwright's `--shard` splits by test count, and the slow specs cluster: one
 * shard ran 157 seconds of tests while another ran 79. This script assigns
 * whole spec files to shards so each shard carries about the same recorded
 * time.
 *
 *   bun scripts/e2e-shards.ts files <shard> <total>   spec paths for one shard
 *   bun scripts/e2e-shards.ts record <dir>            rewrite the timings from
 *                                                     downloaded CI reports
 *
 * The timings in `e2e/shard-timings.json` only weigh the files. The files come
 * from Playwright's own listing, so a spec that has no timing yet still lands
 * in a shard. `check:e2e-lanes` proves the shards together run every Chromium
 * test exactly once.
 */
import { $ } from "bun";
import { Schema } from "effect";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TIMINGS = join(ROOT, "e2e/shard-timings.json");

/**
 * Splits `files` into `total` groups of similar recorded time: longest file
 * first, each into the lightest group so far. A file without a timing weighs
 * the median. The result depends only on the set of files, never their order,
 * because every runner must compute the same split.
 */
export function assignShards(
  files: readonly string[],
  seconds: Readonly<Record<string, number>>,
  total: number,
): string[][] {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`Shard total must be a positive integer, not ${total}`);
  }
  const known = files
    .map((file) => seconds[file])
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] ?? 1;
  const weighed = [...new Set(files)]
    .map((file) => ({ file, weight: seconds[file] ?? median }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  const shards = Array.from({ length: total }, () => {
    const files: string[] = [];
    return { files, weight: 0 };
  });
  for (const { file, weight } of weighed) {
    const lightest = shards.reduce((a, b) => (b.weight < a.weight ? b : a));
    lightest.files.push(file);
    lightest.weight += weight;
  }
  return shards.map((shard) => shard.files.sort());
}

const Timings = Schema.Record(Schema.String, Schema.Number);

/**
 * The spec files of the Chromium project, relative to `e2e/`, from Playwright.
 * `--list` prints one `[chromium] › file:line:column › title` row per test. The
 * JSON reporter is not used: CI points it at a file, and stdout stays empty.
 */
async function chromiumFiles(): Promise<string[]> {
  const output = await $`bun run --silent test:e2e:app:chromium --list`
    .cwd(ROOT)
    .text();
  const files = new Set<string>();
  for (const line of output.split("\n")) {
    const file = /^\[chromium\] › (.+?):\d+:\d+ › /.exec(line.trim())?.[1];
    if (file) files.add(file);
  }
  if (files.size === 0) throw new Error("Playwright listed no Chromium specs");
  return [...files];
}

function readTimings(): Record<string, number> {
  return Schema.decodeUnknownSync(Timings)(
    JSON.parse(readFileSync(TIMINGS, "utf8")),
  );
}

/**
 * Spec paths each shard passes to Playwright, relative to the repository root.
 * Playwright runs the whole project when it gets no file arguments, so an
 * empty shard is an error.
 */
export async function shardFiles(total: number): Promise<string[][]> {
  const shards = assignShards(await chromiumFiles(), readTimings(), total);
  const empty = shards.findIndex((files) => files.length === 0);
  if (empty !== -1) {
    throw new Error(`Shard ${empty + 1} of ${total} has no spec files`);
  }
  return shards.map((files) => files.map((file) => `e2e/${file}`));
}

type Suite = {
  readonly file: string;
  readonly suites?: readonly Suite[] | undefined;
  readonly specs?: readonly Spec[] | undefined;
};
const Spec = Schema.Struct({
  tests: Schema.Array(
    Schema.Struct({
      projectName: Schema.String,
      results: Schema.Array(Schema.Struct({ duration: Schema.Number })),
    }),
  ),
});
type Spec = typeof Spec.Type;
const Suite: Schema.Codec<Suite> = Schema.Struct({
  file: Schema.String,
  suites: Schema.optional(
    Schema.Array(Schema.suspend((): Schema.Codec<Suite> => Suite)),
  ),
  specs: Schema.optional(Schema.Array(Spec)),
});
const Report = Schema.Struct({ suites: Schema.Array(Suite) });

/** Sums each Chromium spec file's test time from Playwright JSON reports under `dir`. */
function record(dir: string): Record<string, number> {
  const milliseconds = new Map<string, number>();
  const visit = (suite: Suite, file: string) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        if (test.projectName !== "chromium") continue;
        const duration = test.results.at(-1)?.duration ?? 0;
        milliseconds.set(file, (milliseconds.get(file) ?? 0) + duration);
      }
    }
    for (const child of suite.suites ?? []) visit(child, file);
  };
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const entry = join(path, name);
      if (statSync(entry).isDirectory()) walk(entry);
      else if (name === "results.json") {
        const report = Schema.decodeUnknownSync(Report)(
          JSON.parse(readFileSync(entry, "utf8")),
        );
        for (const suite of report.suites) visit(suite, suite.file);
      }
    }
  };
  walk(dir);
  if (milliseconds.size === 0) {
    throw new Error(`No Chromium results.json reports under ${dir}`);
  }
  return Object.fromEntries(
    [...milliseconds]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, ms]) => [file, Math.round(ms / 100) / 10]),
  );
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "files" && args.length === 2) {
    const shard = Number(args[0]);
    const total = Number(args[1]);
    const shards = await shardFiles(total);
    const files = shards[shard - 1];
    if (!Number.isInteger(shard) || !files) {
      throw new Error(`Shard must be between 1 and ${total}, not ${args[0]}`);
    }
    console.log(files.join(" "));
  } else if (command === "record" && args.length === 1) {
    const timings = record(resolve(args[0] ?? ""));
    await Bun.write(TIMINGS, `${JSON.stringify(timings, null, 2)}\n`);
    console.log(`Recorded ${Object.keys(timings).length} spec files.`);
  } else {
    console.error(
      "usage: e2e-shards.ts files <shard> <total> | record <reports-dir>",
    );
    process.exit(2);
  }
}
