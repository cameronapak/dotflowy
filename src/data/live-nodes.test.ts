import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Node } from "./schema";

import * as realCollection from "./collection";
import { LUNORA_SYNC_FLAG_KEY } from "./flags";
import { createNode } from "./tree";

/**
 * Branch selection in `getLiveNodes()` — the seam that decides WHICH store a
 * live read comes from. The classic collection is ready-and-empty for the whole
 * session while the Lunora flag is ON (ADR 0058), so a caller that reads it
 * directly sees a legitimately-looking empty outline. These tests pin the three
 * branches: flag OFF, flag ON with a Lunora context, flag ON without one.
 */

// bun test has no DOM — stub the surfaces flags.ts reads (see flags.test.ts).
const flagStore = new Map<string, string>();
const location = { href: "http://localhost/", search: "" };

/** A `wholeOutline` row as the fixtures shape it: the `_id` key plus the node
 *  columns (and the shard `userId`) Lunora stores. */
interface FakeLunoraRow {
  _id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  isTask: boolean;
  completed: boolean;
  collapsed: boolean;
  bookmarkedAt: number | null;
  mirrorOf: string | null;
  createdAt: number;
  updatedAt: number;
  origin: string | null;
  kind: string | null;
  userId: string;
}

/** Rows the FAKE classic collection serves (the real one never syncs here). */
let classicRows: Node[] = [];

/** Rows the FAKE Lunora `wholeOutline` collection serves, `_id`-shaped. */
let lunoraRows: FakeLunoraRow[] = [];

/** Null models "flag ON but the sync host hasn't mounted yet". */
let lunoraContext: {
  userId: string;
  store: { collection: { toArray: FakeLunoraRow[] } };
} | null = null;

// Spread the real module so the ONE export we swap doesn't strip
// `siblingChainRepairs` etc. from collection.test.ts in the same bun process.
mock.module("./collection", () => ({
  ...realCollection,
  nodesCollection: {
    get toArray() {
      return classicRows;
    },
  },
}));

mock.module("./lunora-sync", () => ({
  getLunoraOutlineContext: () => lunoraContext,
}));

const { getLiveNodes } = await import("./live-nodes");

/** A `wholeOutline` row as Lunora stores it: `_id` key plus the shard `userId`. */
function lunoraRow(id: string, text: string): FakeLunoraRow {
  return {
    _id: id,
    parentId: null,
    prevSiblingId: null,
    text,
    isTask: false,
    completed: false,
    collapsed: false,
    bookmarkedAt: null,
    mirrorOf: null,
    createdAt: 1,
    updatedAt: 1,
    origin: null,
    kind: null,
    userId: "u1",
  };
}

function setLunoraRows(rows: FakeLunoraRow[]): void {
  lunoraRows = rows;
  lunoraContext = {
    userId: "u1",
    store: {
      collection: {
        get toArray() {
          return lunoraRows;
        },
      },
    },
  };
}

beforeEach(() => {
  flagStore.clear();
  location.href = "http://localhost/";
  location.search = "";
  classicRows = [];
  lunoraRows = [];
  lunoraContext = null;
  // SAFETY: test stub for the browser window flags.ts reads; bun test has no DOM, so this is the only window in scope.
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => flagStore.get(k) ?? null,
      setItem: (k: string, v: string) => {
        flagStore.set(k, v);
      },
      removeItem: (k: string) => {
        flagStore.delete(k);
      },
    },
    location,
  };
});

afterEach(() => {
  // SAFETY: the property was assigned by the beforeEach stub above, so delete removes exactly that stub.
  delete (globalThis as { window?: unknown }).window;
});

describe("getLiveNodes", () => {
  test("flag OFF reads the classic collection", () => {
    classicRows = [createNode({ id: "a", text: "Alpha" })];
    setLunoraRows([lunoraRow("z", "Zulu")]);

    expect(getLiveNodes().map((n) => n.id)).toEqual(["a"]);
  });

  test("flag ON with a Lunora context reads the Lunora collection", () => {
    classicRows = [createNode({ id: "a", text: "Alpha" })];
    setLunoraRows([lunoraRow("z", "Zulu")]);
    flagStore.set(LUNORA_SYNC_FLAG_KEY, "on");

    expect(getLiveNodes().map((n) => n.id)).toEqual(["z"]);
  });

  test("flag ON maps rows to wire nodes without the shard userId", () => {
    setLunoraRows([lunoraRow("z", "Zulu")]);
    flagStore.set(LUNORA_SYNC_FLAG_KEY, "on");

    const [node] = getLiveNodes();
    expect(node?.text).toBe("Zulu");
    expect("userId" in (node ?? {})).toBe(false);
  });

  test("flag ON with no Lunora context falls back to the classic collection", () => {
    classicRows = [createNode({ id: "a", text: "Alpha" })];
    flagStore.set(LUNORA_SYNC_FLAG_KEY, "on");
    lunoraContext = null;

    expect(getLiveNodes().map((n) => n.id)).toEqual(["a"]);
  });

  test("the empty classic collection is what the Lunora path would have read", () => {
    // The bug this seam exists for: with the flag ON the classic collection is
    // ready-and-empty, so a direct read returns [] while the outline is full.
    classicRows = [];
    setLunoraRows([lunoraRow("z", "Zulu"), lunoraRow("y", "Yankee")]);
    flagStore.set(LUNORA_SYNC_FLAG_KEY, "on");

    expect(getLiveNodes()).toHaveLength(2);
  });
});
