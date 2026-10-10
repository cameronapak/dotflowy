import { expect, test } from "bun:test";

import {
  redactSpoilers,
  SPOILER_PATTERN,
  spoilerInterior,
  stripSpoilers,
} from "./spoiler";

test.each([
  ["the killer is ||Bob|| ok", ["||Bob||"]],
  ["||a|| ||b||", ["||a||", "||b||"]],
  ["||unclosed", []],
  ["||a|b||", []], // interior may not contain `|` (flat, like emphasis)
  ["||||", []], // interior must be non-empty
  ["a || b || c", ["|| b ||"]], // liberal edge spaces, like emphasis
])("SPOILER_PATTERN in %p matches %p", (text, expected) => {
  const runs = [...text.matchAll(new RegExp(SPOILER_PATTERN, "gu"))].map(
    (m) => m[0],
  );
  expect(runs).toEqual(expected);
});

test("spoilerInterior strips fences", () => {
  expect(spoilerInterior("||secret||")).toBe("secret");
});

// Strip (in-app) keeps the interior so your own search finds inside; redact
// (MCP egress) replaces the whole run with a fixed sentinel, so the interior
// and its length never leave.
test.each([
  [
    "the killer is ||Bob|| ok",
    "the killer is Bob ok",
    "the killer is [spoiler] ok",
  ],
  ["||a|| and ||b||", "a and b", "[spoiler] and [spoiler]"],
  ["||x||", "x", "[spoiler]"],
  ["||a much longer secret||", "a much longer secret", "[spoiler]"],
  ["plain text", "plain text", "plain text"],
])("%p strips to %p and redacts to %p", (text, stripped, redacted) => {
  expect(stripSpoilers(text)).toBe(stripped);
  expect(redactSpoilers(text)).toBe(redacted);
});
