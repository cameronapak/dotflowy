import { describe, expect, test } from "bun:test";

import { resolveDailyClaim } from "./claim-mapping";

describe("resolveDailyClaim", () => {
  test("empty existing → candidate wins", () => {
    expect(resolveDailyClaim(null, "cand")).toEqual({
      winner: "cand",
      won: true,
    });
    expect(resolveDailyClaim(undefined, "cand")).toEqual({
      winner: "cand",
      won: true,
    });
    expect(resolveDailyClaim("", "cand")).toEqual({
      winner: "cand",
      won: true,
    });
  });

  test("pre-existing mapping wins over a different candidate", () => {
    expect(resolveDailyClaim("first", "second")).toEqual({
      winner: "first",
      won: false,
    });
  });

  test("re-claim of the same id is idempotent and still won", () => {
    expect(resolveDailyClaim("first", "first")).toEqual({
      winner: "first",
      won: true,
    });
  });
});
