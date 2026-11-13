import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { readFileSync } from "node:fs";

import {
  CaptureBody,
  ApiKeyCreateBody,
  captureKeyExpiration,
  normalizeCapture,
} from "./capture-input";

const input = {
  attemptId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  date: "2024-02-29",
  text: "",
};

test("capture preserves Markdown structure and authored links for intake", () => {
  expect(
    normalizeCapture({ ...input, text: "  First\r\n- second\n  third  " }),
  ).toEqual({
    text: "  First\r\n- second\n  third  ",
    unfurlUrl: null,
  });
  expect(
    normalizeCapture({
      ...input,
      text: "Read https://example.com/story",
      title: "Ignore this",
    }),
  ).toEqual({
    text: "Read https://example.com/story",
    unfurlUrl: null,
  });
  expect(normalizeCapture({ ...input, text: " \r\n " })).toBeNull();
  expect(
    normalizeCapture({ ...input, date: "2023-02-29", text: "invalid day" }),
  ).toBeNull();
});

test("standalone URLs save clickable placeholders, while supplied titles prevent unfurl", () => {
  expect(
    normalizeCapture({ ...input, text: "https://example.com/a(b)" }),
  ).toEqual({
    text: "[https://example.com/a(b)](https://example.com/a%28b%29)",
    unfurlUrl: "https://example.com/a(b)",
  });
  expect(
    normalizeCapture({
      ...input,
      text: "https://example.com/a(b)",
      title: "  A]\npage  ",
    }),
  ).toEqual({
    text: "[A page](https://example.com/a%28b%29)",
    unfurlUrl: null,
  });
  expect(normalizeCapture({ ...input, text: "https://" })).toEqual({
    text: "https://",
    unfurlUrl: null,
  });
});

test("capture text boundary rejects overflow, not the exact maximum", () => {
  const decode = Schema.decodeUnknownSync(CaptureBody);
  expect(decode({ ...input, text: "x".repeat(10_000) }).text.length).toBe(
    10_000,
  );
  expect(() => decode({ ...input, text: "x".repeat(10_001) })).toThrow();
});

test("expiry defaults to 30 elapsed days and permits only 30 or 90 days", () => {
  const leapDay = Date.UTC(2024, 1, 29, 13, 45);
  expect(captureKeyExpiration(undefined, leapDay)).toBe(
    Date.UTC(2024, 2, 30, 13, 45),
  );
  expect(captureKeyExpiration("30d", leapDay)).toBe(
    Date.UTC(2024, 2, 30, 13, 45),
  );
  expect(captureKeyExpiration("90d", leapDay)).toBe(
    Date.UTC(2024, 4, 29, 13, 45),
  );
  const decode = Schema.decodeUnknownSync(ApiKeyCreateBody);
  for (const expiry of ["never", "1y", "91d", null, 90])
    expect(() => decode({ name: "test", expiry })).toThrow();
  expect(() => decode({ name: "test", permission: "admin" })).toThrow();
});

test("legacy keys retain capture scope and shorter expiry with a rollout-relative grace period", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      'CREATE TABLE "user" (id TEXT PRIMARY KEY); INSERT INTO "user" VALUES (\'owner\');',
    );
    db.exec(
      readFileSync(
        new URL("../migrations/0014_capture_keys.sql", import.meta.url),
        "utf8",
      ),
    );
    const now = db
      .query<{ now: number }, []>("SELECT unixepoch('now') * 1000 AS now")
      .get()!.now;
    const insert = db.prepare(
      "INSERT INTO capture_key (id,userId,name,suffix,hash,credentialVersion,createdAt,expiresAt) VALUES (?,'owner',?,'1234',?,'version',1,?)",
    );
    for (const [id, expiry] of [
      ["never", null],
      ["short", now + 10 * 86400000],
      ["long", now + 365 * 86400000],
      ["expired", now - 1000],
    ] as const)
      insert.run(id, id, `hash-${id}`, expiry);
    db.exec(
      readFileSync(
        new URL("../migrations/0015_scoped_api_keys.sql", import.meta.url),
        "utf8",
      ),
    );
    const rows = db
      .query<
        { id: string; permission: string; expiresAt: number; hash: string },
        []
      >("SELECT id,permission,expiresAt,hash FROM capture_key ORDER BY id")
      .all();
    expect(rows.map((r) => [r.id, r.permission, r.hash])).toEqual([
      ["expired", "capture", "hash-expired"],
      ["long", "capture", "hash-long"],
      ["never", "capture", "hash-never"],
      ["short", "capture", "hash-short"],
    ]);
    expect(rows.find((r) => r.id === "expired")!.expiresAt).toBe(now - 1000);
    expect(rows.find((r) => r.id === "short")!.expiresAt).toBe(
      now + 10 * 86400000,
    );
    for (const id of ["never", "long"]) {
      expect(rows.find((r) => r.id === id)!.expiresAt).toBeGreaterThanOrEqual(
        now + 90 * 86400000,
      );
      expect(rows.find((r) => r.id === id)!.expiresAt).toBeLessThanOrEqual(
        now + 90 * 86400000 + 1000,
      );
    }
  } finally {
    db.close();
  }
});
