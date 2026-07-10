import { describe, expect, test } from "bun:test";

import {
  buildSpoiler,
  hasSpoiler,
  redactSpoilers,
  SPOILER_PATTERN,
  SPOILER_SENTINEL,
  spoilerInterior,
  stripSpoilers,
} from "./spoiler";

const matches = (text: string): string[] =>
  [...text.matchAll(new RegExp(SPOILER_PATTERN, "gu"))].map((m) => m[0]);

describe("SPOILER_PATTERN", () => {
  test("matches a run", () => {
    expect(matches("the killer is ||Bob|| ok")).toEqual(["||Bob||"]);
  });

  test("back-to-back runs both match", () => {
    expect(matches("||a|| ||b||")).toEqual(["||a||", "||b||"]);
  });

  test("an unclosed fence stays literal", () => {
    expect(matches("||unclosed")).toEqual([]);
  });

  test("interior may not contain `|` (flat, like emphasis/highlight)", () => {
    expect(matches("||a|b||")).toEqual([]);
  });

  test("interior must be non-empty", () => {
    expect(matches("||||")).toEqual([]);
  });

  test("liberal edge spaces, mirroring the emphasis/highlight patterns", () => {
    expect(matches("a || b || c")).toEqual(["|| b ||"]);
  });
});

describe("hasSpoiler", () => {
  test("true with a complete run, false without", () => {
    expect(hasSpoiler("x ||y|| z")).toBe(true);
    expect(hasSpoiler("no spoiler here")).toBe(false);
    expect(hasSpoiler("||unclosed")).toBe(false);
  });
});

describe("spoilerInterior / buildSpoiler", () => {
  test("interior strips the fences", () => {
    expect(spoilerInterior("||secret||")).toBe("secret");
  });

  test("build wraps in fences (round-trips)", () => {
    expect(buildSpoiler("secret")).toBe("||secret||");
    expect(spoilerInterior(buildSpoiler("x"))).toBe("x");
  });
});

describe("stripSpoilers (in-app: fences off, interior KEPT)", () => {
  test("keeps the interior so your own search finds inside", () => {
    expect(stripSpoilers("the killer is ||Bob|| ok")).toBe(
      "the killer is Bob ok",
    );
  });

  test("strips every run", () => {
    expect(stripSpoilers("||a|| and ||b||")).toBe("a and b");
  });

  test("markup-free text passes through, and the `|` fast path bails", () => {
    expect(stripSpoilers("plain text")).toBe("plain text");
  });
});

describe("redactSpoilers (MCP egress: whole run -> sentinel, interior GONE)", () => {
  test("replaces the run with the fixed sentinel", () => {
    expect(redactSpoilers("the killer is ||Bob|| ok")).toBe(
      `the killer is ${SPOILER_SENTINEL} ok`,
    );
  });

  test("sentinel is interior-length-independent (no char-count leak)", () => {
    expect(redactSpoilers("||x||")).toBe(SPOILER_SENTINEL);
    expect(redactSpoilers("||a much longer secret||")).toBe(SPOILER_SENTINEL);
  });

  test("redacts every run in a line", () => {
    expect(redactSpoilers("||a|| mid ||b||")).toBe(
      `${SPOILER_SENTINEL} mid ${SPOILER_SENTINEL}`,
    );
  });

  test("the interior never survives -- a term inside cannot be substring-matched", () => {
    const redacted = redactSpoilers("the killer is ||Bob||").toLowerCase();
    expect(redacted.includes("bob")).toBe(false);
  });

  test("markup-free text passes through", () => {
    expect(redactSpoilers("plain text")).toBe("plain text");
  });
});

describe("strip vs redact are OPPOSITE operations", () => {
  test("strip keeps the interior, redact destroys it", () => {
    const text = "answer: ||42||";
    expect(stripSpoilers(text)).toBe("answer: 42");
    expect(redactSpoilers(text)).toBe(`answer: ${SPOILER_SENTINEL}`);
  });
});
