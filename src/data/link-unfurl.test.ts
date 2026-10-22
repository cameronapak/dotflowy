import { describe, expect, test } from "bun:test";

import { applyUnfurlTitle, newUnfurlLinks, unfurlLinks } from "./link-unfurl";

describe("new URL unfurling", () => {
  test("finds multiple prose URLs without swallowing sentence punctuation", () => {
    const text = "Read https://example.com/a_(b), then (https://other.test/c).";
    expect(unfurlLinks(text).map((link) => link.url)).toEqual([
      "https://example.com/a_%28b%29",
      "https://other.test/c",
    ]);
  });

  test("skips labels, code, spoilers, and credentials", () => {
    expect(
      unfurlLinks(
        "[My https://label.test](https://custom.test) `https://code.test` ||https://private.test|| https://user:pass@secret.test [https://fresh.test](https://fresh.test)",
      ).map((link) => link.url),
    ).toEqual(["https://fresh.test"]);
  });

  test("does not backfill old URLs when another part of the node changes", () => {
    const before = "https://old.test [Custom](https://named.test)";
    expect(
      newUnfurlLinks(before, before + " https://new.test").map(
        (link) => link.url,
      ),
    ).toEqual(["https://new.test"]);
    expect(
      newUnfurlLinks(
        "https://old.test/a_(b)",
        "[https://old.test/a_(b)](https://old.test/a_%28b%29)",
      ),
    ).toEqual([]);
  });

  test("late titles preserve edits and never touch code or spoilers", () => {
    const [link] = unfurlLinks("https://fresh.test");
    const current =
      "More text: https://fresh.test `https://fresh.test` ||https://fresh.test|| [Mine](https://fresh.test)";
    expect(applyUnfurlTitle(current, link!, " Page]  title ")).toBe(
      "More text: [Page title](https://fresh.test) `https://fresh.test` ||https://fresh.test|| [Mine](https://fresh.test)",
    );
    expect(
      applyUnfurlTitle("Changed URL https://changed.test", link!, "Late"),
    ).toBe("Changed URL https://changed.test");
  });
});
