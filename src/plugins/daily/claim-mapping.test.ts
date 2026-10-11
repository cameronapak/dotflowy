import { expect, test } from "bun:test";

import { resolveDailyClaim } from "./claim-mapping";

test.each([
  // An empty existing mapping -> the candidate wins.
  [null, "cand", { winner: "cand", won: true }],
  [undefined, "cand", { winner: "cand", won: true }],
  ["", "cand", { winner: "cand", won: true }],
  // A pre-existing mapping wins over a different candidate.
  ["first", "second", { winner: "first", won: false }],
  // A re-claim of the same id is idempotent and still won.
  ["first", "first", { winner: "first", won: true }],
])("resolveDailyClaim(%p, %p)", (existing, candidate, expected) => {
  expect(resolveDailyClaim(existing, candidate)).toEqual(expected);
});
