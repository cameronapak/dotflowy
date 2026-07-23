import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  isLunoraSyncEnabled,
  isMirrorsEnabled,
  LUNORA_SYNC_FLAG_KEY,
} from "./flags";

// bun test has no DOM — stub the surfaces flags.ts reads (see realtime.test.ts).
const store = new Map<string, string>();
const location = { href: "http://localhost/", search: "" };

beforeEach(() => {
  store.clear();
  location.href = "http://localhost/";
  location.search = "";
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
  delete (globalThis as { window?: unknown }).window;
});

describe("isLunoraSyncEnabled", () => {
  test("defaults ON", () => {
    expect(isLunoraSyncEnabled()).toBe(true);
  });

  test("localStorage on enables", () => {
    store.set(LUNORA_SYNC_FLAG_KEY, "on");
    expect(isLunoraSyncEnabled()).toBe(true);
  });

  test("localStorage off disables", () => {
    store.set(LUNORA_SYNC_FLAG_KEY, "off");
    expect(isLunoraSyncEnabled()).toBe(false);
  });

  test("URL ?lunora-sync=on wins over localStorage off", () => {
    store.set(LUNORA_SYNC_FLAG_KEY, "off");
    location.search = "?lunora-sync=on";
    expect(isLunoraSyncEnabled()).toBe(true);
  });

  test("URL ?lunora-sync=off wins over localStorage on", () => {
    store.set(LUNORA_SYNC_FLAG_KEY, "on");
    location.search = "?lunora-sync=off";
    expect(isLunoraSyncEnabled()).toBe(false);
  });
});

describe("isMirrorsEnabled (smoke)", () => {
  test("still defaults ON", () => {
    expect(isMirrorsEnabled()).toBe(true);
  });
});
