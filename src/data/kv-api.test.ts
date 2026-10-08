import { expect, test } from "bun:test";

import { toKvKeys, toKvRows } from "./kv-api";

// The transaction shape these read is structural: { mutations: [{ key, modified }] }.
test("a transaction maps to stringified-key upsert rows and delete keys", () => {
  const tx = {
    mutations: [
      { key: "work", modified: { tag: "work", color: "blue" } },
      { key: 42, modified: { tag: "urgent", color: "red" } },
    ],
  };
  expect(toKvRows(tx)).toEqual([
    { key: "work", value: { tag: "work", color: "blue" } },
    { key: "42", value: { tag: "urgent", color: "red" } },
  ]);
  expect(toKvKeys(tx)).toEqual(["work", "42"]);
});
