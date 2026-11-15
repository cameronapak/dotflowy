import { expect, test } from "bun:test";

import { assignShards } from "./e2e-shards";

const seconds = { "slow.spec.ts": 100, "a.spec.ts": 30, "b.spec.ts": 30 };
const files = [
  "slow.spec.ts",
  "a.spec.ts",
  "b.spec.ts",
  "new-one.spec.ts",
  "new-two.spec.ts",
];

test("every file lands in exactly one shard, with or without a timing", () => {
  for (const total of [1, 2, 3, 8]) {
    const shards = assignShards(files, seconds, total);
    expect(shards).toHaveLength(total);
    expect(shards.flat().sort()).toEqual([...files].sort());
  }
});

test("the split depends on the set of files, not their order", () => {
  const forward = assignShards(files, seconds, 3);
  const reversed = assignShards([...files].reverse(), seconds, 3);
  expect(reversed).toEqual(forward);
});

test("shards carry similar recorded time, not similar counts", () => {
  // Untimed files weigh the median, 30. A split by count would put the slow
  // file with two others; by time it runs alone.
  const shards = assignShards(files, seconds, 2);
  expect(shards).toContainEqual(["slow.spec.ts"]);
  expect(shards).toContainEqual([
    "a.spec.ts",
    "b.spec.ts",
    "new-one.spec.ts",
    "new-two.spec.ts",
  ]);
});

test("a shard total that is not a positive integer is an error", () => {
  expect(() => assignShards(files, seconds, 0)).toThrow();
  expect(() => assignShards(files, seconds, 1.5)).toThrow();
});
