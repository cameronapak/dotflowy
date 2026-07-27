import { describe, expect, test } from "bun:test";

import {
  clampWebSearchLimit,
  formatWebSearchResults,
  WEB_SEARCH_MAX_RESULTS,
} from "./agent-web-search";

describe("formatWebSearchResults", () => {
  test("empty hits", () => {
    const out = JSON.parse(formatWebSearchResults([])) as {
      results: unknown[];
      note: string;
    };
    expect(out.results).toEqual([]);
    expect(out.note).toBe("No results");
  });

  test("includes title url description + cite hint", () => {
    const out = JSON.parse(
      formatWebSearchResults([
        {
          title: "Dotflowy",
          url: "https://dotflowy.com",
          description: "Outline app",
        },
      ]),
    ) as {
      results: { title: string; url: string; description: string }[];
      citeAs: string;
    };
    expect(out.results[0]).toEqual({
      title: "Dotflowy",
      url: "https://dotflowy.com",
      description: "Outline app",
    });
    expect(out.citeAs).toContain("[title](url)");
  });
});

describe("clampWebSearchLimit", () => {
  test("defaults and clamps", () => {
    expect(clampWebSearchLimit(undefined)).toBe(WEB_SEARCH_MAX_RESULTS);
    expect(clampWebSearchLimit(0)).toBe(1);
    expect(clampWebSearchLimit(99)).toBe(WEB_SEARCH_MAX_RESULTS);
    expect(clampWebSearchLimit(3.7)).toBe(3);
  });
});
