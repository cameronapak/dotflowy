import { expect, test } from "bun:test";
import { Schema } from "effect";

import {
  CaptureBody,
  captureKeyExpiration,
  normalizeCapture,
} from "./capture-input";

const input = {
  attemptId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  date: "2024-02-29",
  text: "",
};

test("capture flattens lines without importing bullets or rewriting embedded links", () => {
  expect(
    normalizeCapture({ ...input, text: "  First\r\n- second\n  third  " }),
  ).toEqual({
    text: "First - second   third",
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

test("expiry uses elapsed days and clamps leap-day annual expiry", () => {
  const leapDay = Date.UTC(2024, 1, 29, 13, 45);
  expect(captureKeyExpiration("never", leapDay)).toBeNull();
  expect(captureKeyExpiration("30d", leapDay)).toBe(
    Date.UTC(2024, 2, 30, 13, 45),
  );
  expect(captureKeyExpiration("90d", leapDay)).toBe(
    Date.UTC(2024, 4, 29, 13, 45),
  );
  expect(captureKeyExpiration("1y", leapDay)).toBe(
    Date.UTC(2025, 1, 28, 13, 45),
  );
});
