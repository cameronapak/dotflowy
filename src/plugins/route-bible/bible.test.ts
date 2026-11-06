import { expect, test } from "bun:test";

import {
  bibleRefsToMarkdownLinks,
  bibleRefUrlAtOffset,
  formatStructuredBibleRef,
  normalizeBibleRef,
  resolveBibleRef,
  suggestBibleRefs,
} from "./bible";

test.each([
  ["John 3:16", "https://route.bible/jhn.3.16?src=dotflowy"],
  ["1 John 2:1", "https://route.bible/1jn.2.1?src=dotflowy"],
  ["Genesis 1", "https://route.bible/gen.1?src=dotflowy"],
  ["Jhon 3:16", "https://route.bible/jhn.3.16?src=dotflowy"],
  ["II Kngs 25:30", "https://route.bible/2ki.25.30?src=dotflowy"],
  ["REV.22.21", "https://route.bible/rev.22.21?src=dotflowy"],
  ["REV.22.22", null],
  ["REV.23.1", null],
  ["1 Jhon 6:1", null],
  ["I Kigs 23:1", null],
  ["John 3:0", null],
  ["John 3:18-16", null],
  ["John 3:16,18", null], // chips represent one contiguous passage
  // grab-bcv is the strict parser behind the liberal regex.
  ["Hello 3", null], // not a book
  ["Revelation 99:99", null], // out of range
  ["just some plain text", null],
  ["", null],
])("resolveBibleRef(%p) url -> %p", (ref, url) => {
  expect(resolveBibleRef(ref)?.url ?? null).toBe(url);
});

test("normalizeBibleRef rewrites the label, suggestBibleRefs completes partial input", () => {
  expect(normalizeBibleRef("rom 8:28")).toEqual({
    label: "Romans 8:28",
    url: "https://route.bible/rom.8.28?src=dotflowy",
  });
  expect(suggestBibleRefs("rom 8").map((s) => s.label)).toContain("Romans 8");
  expect(suggestBibleRefs("II Kngs 1:", 1)).toEqual([
    {
      label: "2 Kings 1:1",
      insertText: "2 Kings 1:1",
      canonical: "2KI.1.1",
      kind: "verse",
    },
  ]);
});

test.each<[Parameters<typeof formatStructuredBibleRef>[0], string]>([
  [{ book: "JHN", chapter: 3, startVerse: 16, endVerse: 18 }, "John 3:16-18"],
  [{ book: "PRO", chapter: 4, startVerse: null, endVerse: null }, "Proverbs 4"],
])("formatStructuredBibleRef(%p) -> %p", (selection, expected) => {
  expect(formatStructuredBibleRef(selection)).toBe(expected);
});

const JOHN_URL = "https://route.bible/jhn.3.16?src=dotflowy";

test.each([
  // The caret touching either edge of the reference resolves it.
  ["Read John 3:16 today", "Read ".length, JOHN_URL],
  ["Read John 3:16 today", "Read John 3:16".length, JOHN_URL],
  ["Read John 3:16 today", 0, null],
  ["Hello 3", "Hello 3".length, null],
  // Refs inside link and code tokens never chip, so they never resolve.
  ["`see John 3:16` after", "`see John".length, null],
  ["read [John 3:16](https://example.com) now", "read [John".length, null],
])("bibleRefUrlAtOffset(%p, %p) -> %p", (text, offset, expected) => {
  expect(bibleRefUrlAtOffset(text, offset)).toBe(expected);
});

test.each([
  ["Read John 3:16 today", `Read [John 3:16](${JOHN_URL}) today`],
  // Invalid candidates and existing markdown or code stay put.
  [
    "Hello 3 [John 3:16](https://example.com) `Romans 8:28`",
    "Hello 3 [John 3:16](https://example.com) `Romans 8:28`",
  ],
])("bibleRefsToMarkdownLinks(%p)", (text, expected) => {
  expect(bibleRefsToMarkdownLinks(text)).toBe(expected);
});
