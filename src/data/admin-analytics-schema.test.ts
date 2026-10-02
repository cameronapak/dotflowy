import { expect, test } from "bun:test";

import { savedExperimentalPreference } from "./admin-analytics-schema";

test("preserves unset, explicit off, enabled, and unreadable preferences", () => {
  expect(savedExperimentalPreference(undefined)).toBe("unset");
  expect(
    savedExperimentalPreference('{"id":"lunora-beta","enabled":false}'),
  ).toBe("disabled");
  expect(
    savedExperimentalPreference('{"id":"lunora-beta","enabled":true}'),
  ).toBe("enabled");
  for (const malformed of [
    "null",
    "{}",
    '{"id":"other","enabled":true}',
    '{"id":"lunora-beta","enabled":"false"}',
    "{invalid json",
  ]) {
    expect(savedExperimentalPreference(malformed)).toBe("unknown");
  }
});
