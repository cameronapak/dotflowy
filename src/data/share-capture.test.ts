import { expect, test } from "bun:test";

import { shareToCapture } from "./share-capture";

test.each([
  // Android Chrome: page title in title, link alone in text, no url.
  [
    { title: "Example Domain", text: "https://example.com/a" },
    { text: "https://example.com/a", title: "Example Domain" },
  ],
  // Desktop and ChromeOS: link in url.
  [
    { title: "Example Domain", url: "https://example.com/a" },
    { text: "https://example.com/a", title: "Example Domain" },
  ],
  // Apps that put the title before the link in text: prose, no title label.
  [
    { text: "Example Domain https://example.com/a" },
    { text: "Example Domain https://example.com/a" },
  ],
  // A link already present in text is not appended twice.
  [
    { text: "See https://example.com/a", url: "https://example.com/a" },
    { text: "See https://example.com/a" },
  ],
  // Text and a separate link: the link is appended once.
  [
    { text: "Worth reading", url: "https://example.com/a" },
    { text: "Worth reading https://example.com/a" },
  ],
  // Plain text keeps its Markdown, untouched apart from outer whitespace.
  [
    { text: "  - [ ] call Sam\n  - agenda  " },
    { text: "- [ ] call Sam\n  - agenda" },
  ],
  // Only a title arrived.
  [{ title: "Just a subject" }, { text: "Just a subject" }],
  // Nothing nonblank arrived.
  [{ title: " ", text: "\n" }, null],
])("shareToCapture(%j)", (share, expected) => {
  expect(shareToCapture(share)).toEqual(expected);
});

test("a long page title is cut to the server's 300-character label limit", () => {
  const capture = shareToCapture({
    title: "t".repeat(301),
    text: "https://example.com",
  });
  expect(capture?.title).toHaveLength(300);
});
