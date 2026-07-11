import { describe, expect, it } from "bun:test";

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

describe("normalizeQuery", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeQuery("  #work is:todo  ")).toBe("#work is:todo");
  });
  it("leaves interior spacing untouched", () => {
    expect(normalizeQuery("#a  #b")).toBe("#a  #b");
  });
});

describe("defaultQueryName", () => {
  it("is the trimmed query text", () => {
    expect(defaultQueryName("  #work  ")).toBe("#work");
  });
});

describe("sortSavedNewestFirst", () => {
  it("orders by createdAt descending", () => {
    const rows = [
      row({ id: "a", createdAt: 1 }),
      row({ id: "b", createdAt: 3 }),
      row({ id: "c", createdAt: 2 }),
    ];
    expect(sortSavedNewestFirst(rows).map((r) => r.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
  it("breaks ties on id for determinism", () => {
    const rows = [
      row({ id: "y", createdAt: 5 }),
      row({ id: "x", createdAt: 5 }),
    ];
    expect(sortSavedNewestFirst(rows).map((r) => r.id)).toEqual(["x", "y"]);
  });
  it("does not mutate the input", () => {
    const rows = [
      row({ id: "a", createdAt: 1 }),
      row({ id: "b", createdAt: 2 }),
    ];
    sortSavedNewestFirst(rows);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("findSavedQuery / isQuerySaved", () => {
  const rows = [
    row({ id: "1", query: "#work" }),
    row({ id: "2", query: "is:todo -done" }),
  ];
  it("matches ignoring surrounding whitespace", () => {
    expect(findSavedQuery(rows, "  #work ")?.id).toBe("1");
    expect(isQuerySaved(rows, "#work")).toBe(true);
  });
  it("does not match a different query", () => {
    expect(findSavedQuery(rows, "#home")).toBeUndefined();
    expect(isQuerySaved(rows, "#home")).toBe(false);
  });
  it("never treats an empty query as saved", () => {
    expect(isQuerySaved(rows, "   ")).toBe(false);
    expect(findSavedQuery(rows, "")).toBeUndefined();
  });
});

describe("matchSavedQuery", () => {
  const r = row({ name: "Work todos", query: "#work is:todo" });
  it("matches every whitespace token against name or query", () => {
    expect(matchSavedQuery("work", r)).toBe(true);
    expect(matchSavedQuery("todos", r)).toBe(true);
    expect(matchSavedQuery("is:todo", r)).toBe(true);
    expect(matchSavedQuery("work todo", r)).toBe(true);
  });
  it("requires ALL tokens to appear", () => {
    expect(matchSavedQuery("work personal", r)).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(matchSavedQuery("WORK", r)).toBe(true);
  });
});
