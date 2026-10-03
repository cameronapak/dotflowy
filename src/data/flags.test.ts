import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isMirrorsEnabled } from "./flags";

// bun test has no DOM — stub the surfaces flags.ts reads (see realtime.test.ts).
const store = new Map<string, string>();
const location = { href: "http://localhost/", search: "" };

beforeEach(() => {
  store.clear();
  location.href = "http://localhost/";
  location.search = "";
  // SAFETY: test stub for the browser window flags.ts reads; bun test has no DOM, so this is the only window in scope.
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
    location,
  };
});

afterEach(() => {
  // SAFETY: the property was assigned by the beforeEach stub above, so delete removes exactly that stub.
  delete (globalThis as { window?: unknown }).window;
});

describe("isMirrorsEnabled (smoke)", () => {
  test("still defaults ON", () => {
    expect(isMirrorsEnabled()).toBe(true);
  });
});
