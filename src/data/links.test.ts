import { expect, test } from "bun:test";

import {
  bareHttpUrl,
  encodeUrlForMarkdown,
  hasLink,
  isHttpUrl,
  linkUrlAtOffset,
  sanitizeLinkLabel,
  stripLinks,
  swapLinkLabel,
} from "./links";

test.each([
  ["[label](url)", true],
  ["before [x](y) after", true],
  ["plain text", false],
  ["[label]", false],
  ["(url)", false],
])("hasLink(%p) -> %p", (text, expected) => {
  expect(hasLink(text)).toBe(expected);
});

test.each([
  ["[label](http://x)", "label"],
  ["a [x](y) b [z](w) c", "a x b z c"],
  ["a[](http://x)c", "ac"], // an empty label collapses to nothing
  ["no links here", "no links here"],
])("stripLinks(%p) -> %p", (text, expected) => {
  expect(stripLinks(text)).toBe(expected);
});

test("linkUrlAtOffset returns the url anywhere in a complete token, null outside", () => {
  const text = "see [Example](https://example.com) now";
  const url = "https://example.com";
  expect(linkUrlAtOffset(text, text.indexOf("Example"))).toBe(url); // label
  expect(linkUrlAtOffset(text, text.indexOf("]"))).toBe(url);
  expect(linkUrlAtOffset(text, text.indexOf("example.com"))).toBe(url); // url
  expect(linkUrlAtOffset(text, text.indexOf(")") + 1)).toBe(url); // behind ")"
  expect(linkUrlAtOffset(text, 0)).toBeNull();
  expect(linkUrlAtOffset("[partial]", 3)).toBeNull();
});

test.each([
  ["http://x.com", true],
  ["https://x.com", true],
  ["HTTPS://X.COM", true], // case-insensitive
  ["  https://x.com  ", true], // trimmed
  ["ftp://x.com", false],
  ["mailto:a@b.com", false],
  ["not a url", false],
])("isHttpUrl(%p) -> %p", (text, expected) => {
  expect(isHttpUrl(text)).toBe(expected);
});

test.each([
  ["https://x.com", "https://x.com"],
  ["  https://x.com  ", "https://x.com"],
  ["see https://x.com", null],
  ["https://x.com extra", null],
  ["not-a-url", null],
  ["", null],
])("bareHttpUrl(%p) -> %p", (text, expected) => {
  expect(bareHttpUrl(text)).toBe(expected);
});

test.each([
  // Only the chars that break the (url) parser are encoded.
  ["http://x.com/a b?q=(1)", "http://x.com/a%20b?q=%281%29"],
  ["http://x.com/path?a=1&b=2", "http://x.com/path?a=1&b=2"],
])("encodeUrlForMarkdown(%p) -> %p", (url, expected) => {
  expect(encodeUrlForMarkdown(url)).toBe(expected);
});

test.each([
  ["Foo ] bar", "Foo bar"], // `]` is fatal to the label grammar
  ["a]b]c", "abc"],
  ["  Hello   \n  World  ", "Hello World"], // collapses whitespace, trims
  ["Foo [bar] (baz)", "Foo [bar (baz)"], // only `]` breaks a label
  // An all-junk title collapses to empty (the caller keeps the placeholder).
  ["   \n\t ", ""],
  ["]]]", ""],
])("sanitizeLinkLabel(%p) -> %p", (title, expected) => {
  expect(sanitizeLinkLabel(title)).toBe(expected);
});

test("swapLinkLabel swaps the first placeholder label, or returns null once edited", () => {
  const url = "https://anthropic.com";
  expect(swapLinkLabel(`see [${url}](${url}) now`, url, url, "Anthropic")).toBe(
    "see [Anthropic](https://anthropic.com) now",
  );
  // Only the first placeholder is touched when the url repeats.
  expect(
    swapLinkLabel(`[${url}](${url}) and [${url}](${url})`, url, url, "A"),
  ).toBe(`[A](${url}) and [${url}](${url})`);
  // The user already renamed the label, so the exact `[url](url)` is absent.
  expect(swapLinkLabel(`[My link](${url}) `, url, url, "Anthropic")).toBeNull();
});

test("swapLinkLabel matches against the ENCODED url half (parens case)", () => {
  const raw = "https://en.wikipedia.org/wiki/Foo_(bar)";
  const enc = "https://en.wikipedia.org/wiki/Foo_%28bar%29";
  expect(swapLinkLabel(`[${raw}](${enc}) tail`, enc, raw, "Foo (bar)")).toBe(
    `[Foo (bar)](${enc}) tail`,
  );
});
