import { expect, test } from "bun:test";

import {
  defaultQueryName,
  findSavedQuery,
  isQuerySaved,
  matchSavedQuery,
  normalizeQuery,
  type SavedQueryRow,
  sortSavedNewestFirst,
} from "./saved-queries-core";

const row = (over: Partial<SavedQueryRow>): SavedQueryRow => ({
  id: "id",
  name: "name",
  query: "query",
  createdAt: 0,
  ...over,
});

test("normalizeQuery trims the edges and leaves interior spacing", () => {
  expect(normalizeQuery("  #a  #b  ")).toBe("#a  #b");
  expect(defaultQueryName("  #work  ")).toBe("#work");
});

test("sortSavedNewestFirst: createdAt descending, ties on id, input untouched", () => {
  const rows = [
    row({ id: "a", createdAt: 1 }),
    row({ id: "y", createdAt: 3 }),
    row({ id: "c", createdAt: 2 }),
    row({ id: "x", createdAt: 3 }),
  ];
  expect(sortSavedNewestFirst(rows).map((r) => r.id)).toEqual([
    "x",
    "y",
    "c",
    "a",
  ]);
  expect(rows.map((r) => r.id)).toEqual(["a", "y", "c", "x"]);
});

test("findSavedQuery / isQuerySaved match on the trimmed query, never on empty", () => {
  const rows = [
    row({ id: "1", query: "#work" }),
    row({ id: "2", query: "is:todo -done" }),
    // A blank stored query would match an empty search without the guard.
    row({ id: "3", query: " " }),
  ];
  expect(findSavedQuery(rows, "  #work ")?.id).toBe("1");
  expect(isQuerySaved(rows, "#work")).toBe(true);
  expect(findSavedQuery(rows, "#home")).toBeUndefined();
  expect(isQuerySaved(rows, "#home")).toBe(false);
  expect(isQuerySaved(rows, "   ")).toBe(false);
  expect(findSavedQuery(rows, "")).toBeUndefined();
});

test.each<[string, boolean]>([
  ["work", true], // name or query
  ["todos", true], // name only
  ["is:todo", true], // query only
  ["work todo", true],
  ["WORK", true], // case-insensitive
  ["work personal", false], // every token must appear
])("matchSavedQuery(%p) is %p", (q, expected) => {
  expect(
    matchSavedQuery(q, row({ name: "Work todos", query: "#work is:todo" })),
  ).toBe(expected);
});
