/**
 * Pure-logic tests for the link-unfurl endpoint's security-critical helpers
 * (worker/unfurl.ts) -- the SSRF target guard, the http(s) param check, and the
 * server-side title sanitizer. These are the parts that decide what the Worker
 * will and won't fetch and what it returns, so they're worth pinning here in the
 * `bun test` pure tier. The hardened fetch + HTMLRewriter extraction need the CF
 * runtime and aren't unit-tested (they import Workers globals). See docs/adr/0016.
 */

import { describe, expect, it } from "bun:test";

import {
  isAllowedUnfurlTarget,
  isHttpUrlString,
  sanitizeServerTitle,
} from "./unfurl-core";

describe("isHttpUrlString", () => {
  it("accepts well-formed http(s)", () => {
    expect(isHttpUrlString("http://example.com")).toBe(true);
    expect(isHttpUrlString("https://example.com/a?b=1")).toBe(true);
  });

  it("rejects other schemes and junk (the only 400 path)", () => {
    expect(isHttpUrlString("ftp://example.com")).toBe(false);
    expect(isHttpUrlString("file:///etc/passwd")).toBe(false);
    expect(isHttpUrlString("javascript:alert(1)")).toBe(false);
    expect(isHttpUrlString("not a url")).toBe(false);
    expect(isHttpUrlString("")).toBe(false);
  });
});

describe("isAllowedUnfurlTarget (SSRF guard)", () => {
  it("allows ordinary public http(s) URLs", () => {
    expect(isAllowedUnfurlTarget("https://anthropic.com")).toBe(true);
    expect(isAllowedUnfurlTarget("http://example.com/path")).toBe(true);
  });

  it("blocks non-http(s) schemes", () => {
    expect(isAllowedUnfurlTarget("ftp://example.com")).toBe(false);
    expect(isAllowedUnfurlTarget("file:///etc/passwd")).toBe(false);
  });

  it("blocks localhost and internal-suffix hostnames", () => {
    expect(isAllowedUnfurlTarget("http://localhost/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://app.localhost/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://printer.local/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://db.internal/")).toBe(false);
  });

  it("blocks private / loopback / link-local IPv4 literals", () => {
    expect(isAllowedUnfurlTarget("http://127.0.0.1/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://10.0.0.5/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://192.168.1.1/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://172.16.0.1/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://172.31.255.255/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://169.254.169.254/")).toBe(false); // cloud metadata
    expect(isAllowedUnfurlTarget("http://0.0.0.0/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://100.64.0.1/")).toBe(false); // CGNAT
  });

  it("allows a public IPv4 that is not in a private range", () => {
    expect(isAllowedUnfurlTarget("http://8.8.8.8/")).toBe(true);
    expect(isAllowedUnfurlTarget("http://172.32.0.1/")).toBe(true); // just outside 172.16/12
  });

  it("blocks IPv6 loopback / link-local / ULA", () => {
    expect(isAllowedUnfurlTarget("http://[::1]/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://[fe80::1]/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://[fd00::1]/")).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 that smuggles a private target (#232)", () => {
    // WHATWG canonicalizes the dotted form to hex, so both spellings resolve to
    // the same host the guard sees — assert the raw inputs anyway.
    expect(isAllowedUnfurlTarget("http://[::ffff:127.0.0.1]/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://[::ffff:7f00:1]/")).toBe(false); // canonical hex
    expect(isAllowedUnfurlTarget("http://[::ffff:10.0.0.1]/")).toBe(false);
    expect(isAllowedUnfurlTarget("http://[::ffff:169.254.169.254]/")).toBe(
      false,
    ); // mapped cloud metadata
  });

  it("still allows an IPv4-mapped IPv6 pointing at a public address", () => {
    expect(isAllowedUnfurlTarget("http://[::ffff:8.8.8.8]/")).toBe(true);
  });

  it("rejects unparseable input", () => {
    expect(isAllowedUnfurlTarget("not a url")).toBe(false);
    expect(isAllowedUnfurlTarget("")).toBe(false);
  });
});

describe("sanitizeServerTitle", () => {
  it("decodes entities, collapses whitespace, trims", () => {
    expect(sanitizeServerTitle("  Tom &amp; Jerry\n  Show ")).toBe(
      "Tom & Jerry Show",
    );
    expect(sanitizeServerTitle("Caf&#233; &#x2014; Menu")).toBe("Café — Menu");
  });

  it("returns null for empty / whitespace-only / nullish", () => {
    expect(sanitizeServerTitle(null)).toBeNull();
    expect(sanitizeServerTitle(undefined)).toBeNull();
    expect(sanitizeServerTitle("")).toBeNull();
    expect(sanitizeServerTitle("   \n\t ")).toBeNull();
  });

  it("caps very long titles", () => {
    const long = "x".repeat(500);
    const out = sanitizeServerTitle(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(300);
  });

  it("leaves unknown entities intact", () => {
    expect(sanitizeServerTitle("A &weird; B")).toBe("A &weird; B");
  });
});
