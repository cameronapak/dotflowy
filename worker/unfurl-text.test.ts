import { expect, test } from "bun:test";
import { Effect } from "effect";

import { unfurlTextE } from "./unfurl-text";

test("external authoring deduplicates requests, preserves misses, and skips old or labeled URLs", async () => {
  const requests: string[] = [];
  const before = "Old https://old.test";
  const text =
    before +
    " https://new.test https://new.test https://missing.test [Mine](https://custom.test) ||https://private.test||";
  const result = await Effect.runPromise(
    unfurlTextE(before, text, (url) =>
      Effect.sync(() => {
        requests.push(url);
        return url === "https://new.test" ? "New title" : null;
      }),
    ),
  );
  expect(requests.sort()).toEqual(["https://missing.test", "https://new.test"]);
  expect(result).toBe(
    "Old https://old.test [New title](https://new.test) [New title](https://new.test) https://missing.test [Mine](https://custom.test) ||https://private.test||",
  );
});
