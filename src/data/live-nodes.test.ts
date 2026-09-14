import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Node } from "./schema";

import { LUNORA_SYNC_FLAG_KEY } from "./flags";
import { getLiveNodes } from "./live-nodes";
import { createNode } from "./tree";

/**
 * Branch selection in `getLiveNodes()` — the seam that decides WHICH store a
 * live read comes from. The classic collection is ready-and-empty for the whole
 * session while the Lunora flag is ON (ADR 0058), so a caller that reads it
 * directly sees a legitimately-looking empty outline. These tests pin the three
 * branches: flag OFF, flag ON with a Lunora context, flag ON without one.
 */

/** Shared mutable state the vi.mock factories read. `vi.mock` factories are
 * hoisted above every import, so they may only close over `vi.hoisted` values,
 * never module-level bindings (TDZ). */
const state = vi.hoisted(() => ({
  // SAFETY: fixtures start empty; tests assign fully-typed rows before any read.
  classicRows: [] as Node[],
  // SAFETY: null models "flag on, sync host not mounted" until a test sets it.
  lunoraContext: null as {
    userId: string;
    store: { collection: { toArray: unknown[] } };
  } | null,
}));

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

// Spread the real module so the ONE export we swap keeps
// `siblingChainRepairs` etc. working for collection.test.ts in the same run.
// oxlint-disable-next-line anti-slop/no-module-mocking -- seam test (ADR 0058): the store-selection branch in live-nodes.ts is the unit under test; a faithful fake of the two stores IS the test.
vi.mock("./collection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./collection")>()),
  nodesCollection: {
    get toArray() {
      return state.classicRows;
    },
  },
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- seam test (ADR 0058): same justification as the collection mock above.
vi.mock("./lunora-sync", () => ({
  getLunoraOutlineContext: () => state.lunoraContext,
}));

// The node pool has no DOM — stub the surfaces flags.ts reads (see flags.test.ts).
const flagStore = new Map<string, string>();
const location = { href: "http://localhost/", search: "" };

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
  state.lunoraContext = {
    userId: "u1",
    store: {
      collection: {
        get toArray() {
          return rows;
        },
      },
    },
  };
}

beforeEach(() => {
  flagStore.clear();
  location.href = "http://localhost/";
  location.search = "";
  state.classicRows = [];
  state.lunoraContext = null;
  // SAFETY: test stub for the browser window flags.ts reads; the node pool has no DOM, so this is the only window in scope.
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
    state.classicRows = [createNode({ id: "a", text: "Alpha" })];
    setLunoraRows([lunoraRow("z", "Zulu")]);

    expect(getLiveNodes().map((n) => n.id)).toEqual(["a"]);
  });

  test("flag ON with a Lunora context reads the Lunora collection", () => {
    state.classicRows = [createNode({ id: "a", text: "Alpha" })];
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
    state.classicRows = [createNode({ id: "a", text: "Alpha" })];
    flagStore.set(LUNORA_SYNC_FLAG_KEY, "on");
    state.lunoraContext = null;

    expect(getLiveNodes().map((n) => n.id)).toEqual(["a"]);
  });

  test("the empty classic collection is what the Lunora path would have read", () => {
    // The bug this seam exists for: with the flag ON the classic collection is
    // ready-and-empty, so a direct read returns [] while the outline is full.
    state.classicRows = [];
    setLunoraRows([lunoraRow("z", "Zulu"), lunoraRow("y", "Yankee")]);
    flagStore.set(LUNORA_SYNC_FLAG_KEY, "on");

    expect(getLiveNodes()).toHaveLength(2);
  });
});
