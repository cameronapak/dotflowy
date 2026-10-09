/**
 * Pure-logic tests for the link-unfurl endpoint's security-critical helpers
 * (worker/unfurl.ts) -- the SSRF target guard, the http(s) param check, and the
 * server-side title sanitizer. These are the parts that decide what the Worker
 * will and won't fetch and what it returns, so they're worth pinning here in the
 * `bun test` pure tier. The hardened fetch + HTMLRewriter extraction need the CF
 * runtime and aren't unit-tested (they import Workers globals). See docs/adr/0016.
 */

import { expect, test } from "bun:test";

import {
  canonicalYouTubeVideoUrl,
  isAllowedUnfurlTarget,
  isHttpUrlString,
  sanitizeServerTitle,
} from "./unfurl-core";

test.each([
  ["http://example.com", true],
  ["https://example.com/a?b=1", true],
  ["ftp://example.com", false],
  ["file:///etc/passwd", false],
  ["javascript:alert(1)", false],
  ["not a url", false],
  ["", false],
])(
  "isHttpUrlString(%p) is %p (only http(s) passes the 400 check)",
  (url, ok) => {
    expect(isHttpUrlString(url)).toBe(ok);
  },
);

test.each([
  // Ordinary public http(s) URLs and public IPs pass.
  ["https://anthropic.com", true],
  ["http://example.com/path", true],
  ["http://8.8.8.8/", true],
  ["http://172.32.0.1/", true], // just outside 172.16/12
  ["http://[::ffff:8.8.8.8]/", true], // IPv4-mapped IPv6 to a public address
  // Non-http(s) schemes and unparseable input.
  ["ftp://example.com", false],
  ["file:///etc/passwd", false],
  ["not a url", false],
  ["", false],
  // localhost and internal-suffix hostnames.
  ["http://localhost/", false],
  ["http://app.localhost/", false],
  ["http://printer.local/", false],
  ["http://db.internal/", false],
  // Private, loopback, link-local, and CGNAT IPv4 literals.
  ["http://127.0.0.1/", false],
  ["http://10.0.0.5/", false],
  ["http://192.168.1.1/", false],
  ["http://172.16.0.1/", false],
  ["http://172.31.255.255/", false],
  ["http://169.254.169.254/", false], // cloud metadata
  ["http://0.0.0.0/", false],
  ["http://100.64.0.1/", false], // CGNAT
  // IPv6 loopback, link-local, and ULA.
  ["http://[::1]/", false],
  ["http://[fe80::1]/", false],
  ["http://[fd00::1]/", false],
  // IPv4-mapped IPv6 smuggling a private target (#232), dotted and hex spellings.
  ["http://[::ffff:127.0.0.1]/", false],
  ["http://[::ffff:7f00:1]/", false],
  ["http://[::ffff:10.0.0.1]/", false],
  ["http://[::ffff:169.254.169.254]/", false],
])("isAllowedUnfurlTarget(%p) is %p (SSRF guard)", (url, ok) => {
  expect(isAllowedUnfurlTarget(url)).toBe(ok);
});

test("sanitizeServerTitle decodes known entities, collapses whitespace, caps length, and nulls empties", () => {
  expect(sanitizeServerTitle("  Tom &amp; Jerry\n  Show ")).toBe(
    "Tom & Jerry Show",
  );
  expect(sanitizeServerTitle("Caf&#233; &#x2014; Menu")).toBe("Café — Menu");
  expect(sanitizeServerTitle("A &weird; B")).toBe("A &weird; B");
  expect(sanitizeServerTitle("x".repeat(500))).toBe("x".repeat(300));
  for (const empty of [null, undefined, "", "   \n\t "])
    expect(sanitizeServerTitle(empty)).toBeNull();
});

test.each([
  "https://www.youtube.com/watch?v=BsJGo1wFTvQ&t=1s",
  "https://youtube.com/watch?list=abc&v=BsJGo1wFTvQ",
  "https://m.youtube.com/watch?v=BsJGo1wFTvQ",
  "https://music.youtube.com/watch?v=BsJGo1wFTvQ",
  "https://youtu.be/BsJGo1wFTvQ?t=1",
  "https://www.youtube.com/v/BsJGo1wFTvQ",
  "https://www.youtube.com/shorts/BsJGo1wFTvQ?feature=share",
  "https://www.youtube.com/embed/BsJGo1wFTvQ",
  "https://www.youtube.com/live/BsJGo1wFTvQ",
])("canonicalYouTubeVideoUrl(%p) strips presentation params", (url) => {
  expect(canonicalYouTubeVideoUrl(url)).toBe(
    "https://www.youtube.com/watch?v=BsJGo1wFTvQ",
  );
});

test.each([
  "https://youtube.com.evil.example/watch?v=BsJGo1wFTvQ",
  "https://youtu.be.evil.example/BsJGo1wFTvQ",
  "https://notyoutube.com/watch?v=BsJGo1wFTvQ",
  "https://www.youtube-nocookie.com/embed/BsJGo1wFTvQ",
  "https://www.youtube.com/playlist?list=PL123",
  "https://www.youtube.com/channel/UC123",
  "https://www.youtube.com/results?search_query=dotflowy",
  "https://www.youtube.com/watch",
  "https://www.youtube.com/watch?v=too-short",
  "https://youtu.be/BsJGo1wFTvQ/extra",
  "https://www.youtube.com:8443/watch?v=BsJGo1wFTvQ",
  "ftp://www.youtube.com/watch?v=BsJGo1wFTvQ",
  "not a url",
])(
  "canonicalYouTubeVideoUrl(%p) rejects lookalikes and non-video pages",
  (url) => {
    expect(canonicalYouTubeVideoUrl(url)).toBeNull();
  },
);
