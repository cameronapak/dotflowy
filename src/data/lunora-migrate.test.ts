import { afterEach, describe, expect, test } from "bun:test";

import type { OutlineStore } from "./lunora-outline-store";

import {
  fetchClassicKvBundles,
  forceHealClassicKv,
  forceRemigrateFromClassic,
  migrateClassicToLunora,
} from "./lunora-migrate";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function installKvFetch(
  handlers: Record<string, () => Response | Promise<Response>>,
): void {
  globalThis.fetch = ((url: string) => {
    const u = String(url);
    const collection = new URL(u, "http://local").searchParams.get(
      "collection",
    );
    if (!collection || !(collection in handlers)) {
      return Promise.reject(new Error(`unexpected fetch ${u}`));
    }
    return Promise.resolve(handlers[collection]!());
  }) as unknown as typeof fetch;
}

function installClassicFetch(opts: {
  nodes?: unknown;
  kv?: Record<string, unknown>;
}): void {
  globalThis.fetch = ((url: string) => {
    const u = String(url);
    if (u.includes("/api/nodes")) {
      return Promise.resolve(jsonOk(opts.nodes ?? []));
    }
    const collection = new URL(u, "http://local").searchParams.get(
      "collection",
    );
    if (collection && opts.kv && collection in opts.kv) {
      return Promise.resolve(jsonOk(opts.kv[collection]));
    }
    if (collection) return Promise.resolve(jsonOk([]));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  }) as unknown as typeof fetch;
}

function readyCollection(rows: unknown[]) {
  return {
    toArray: rows,
    toArrayWhenReady: () => Promise.resolve(rows),
  };
}

type MutatorCall = { ref: string; args: Record<string, unknown> };
type ImportCall = { kind: "nodes" | "kv"; count: number };

/** Minimal store stub for migrateClassicToLunora unit tests. */
function stubStore(opts: {
  nodes?: unknown[];
  tagColors?: unknown[];
  savedQueries?: unknown[];
  dailyIndex?: unknown[];
  migrateState?: { nodesAt: number | null; kvAt: number | null } | null;
  onMutator?: (call: MutatorCall) => void;
  onImport?: (call: ImportCall) => void;
}): OutlineStore {
  let migrateState = opts.migrateState ?? null;
  return {
    client: {
      callMutator: async (ref: string, args: Record<string, unknown>) => {
        opts.onMutator?.({ ref, args });
        if (ref === "mutators:getMigrateState") {
          return { result: migrateState };
        }
        if (ref === "mutators:setMigrateState") {
          migrateState = {
            nodesAt:
              args.nodesAt === undefined
                ? (migrateState?.nodesAt ?? null)
                : (args.nodesAt as number | null),
            kvAt:
              args.kvAt === undefined
                ? (migrateState?.kvAt ?? null)
                : (args.kvAt as number | null),
          };
          return { result: migrateState };
        }
        throw new Error(`unexpected mutator ${ref}`);
      },
      importRows: async (
        _ref: unknown,
        rows: unknown[],
        options: { toArgs: (chunk: unknown[]) => { nodes?: unknown[] } },
      ) => {
        const args = options.toArgs(rows);
        const kind = Array.isArray(args.nodes) ? "nodes" : "kv";
        opts.onImport?.({ kind, count: rows.length });
        return { imported: rows.length };
      },
    },
    collection: readyCollection(opts.nodes ?? [{ _id: "n1" }]),
    tagColors: readyCollection(opts.tagColors ?? []),
    savedQueries: readyCollection(opts.savedQueries ?? []),
    dailyIndex: readyCollection(opts.dailyIndex ?? []),
    mutators: {},
  } as unknown as OutlineStore;
}

function classicNode(id: string, prev: string | null = null) {
  return {
    id,
    parentId: null,
    prevSiblingId: prev,
    text: id,
    isTask: false,
    completed: false,
    collapsed: false,
    bookmarkedAt: null,
    mirrorOf: null,
    createdAt: 1,
    updatedAt: 1,
    origin: null,
    kind: null,
  };
}

describe("fetchClassicKvBundles", () => {
  test("count 0 only when every GET succeeds with []", async () => {
    installKvFetch({
      "tag-colors": () => jsonOk([]),
      "saved-queries": () => jsonOk([]),
      "daily-index": () => jsonOk([]),
    });
    const bundles = await fetchClassicKvBundles();
    expect(bundles.count).toBe(0);
    expect(bundles.tagColors).toEqual([]);
    expect(bundles.savedQueries).toEqual([]);
    expect(bundles.dailyIndex).toEqual([]);
  });

  test("rejects when any /api/kv GET fails (never treats failure as empty)", async () => {
    installKvFetch({
      "tag-colors": () => jsonOk([]),
      "saved-queries": () =>
        new Response("boom", { status: 500, statusText: "Internal" }),
      "daily-index": () => jsonOk([{ key: "container", nodeId: "d" }]),
    });
    await expect(fetchClassicKvBundles()).rejects.toThrow(
      /GET \/api\/kv saved-queries 500/,
    );
  });

  test("rejects on network failure for a collection", async () => {
    installKvFetch({
      "tag-colors": () => {
        throw new Error("network down");
      },
      "saved-queries": () => jsonOk([]),
      "daily-index": () => jsonOk([]),
    });
    await expect(fetchClassicKvBundles()).rejects.toThrow("network down");
  });

  test("rejects malformed 200 body (non-array) — never treats as empty", async () => {
    installKvFetch({
      "tag-colors": () => jsonOk([]),
      "saved-queries": () => jsonOk({ not: "an-array" }),
      "daily-index": () => jsonOk([]),
    });
    await expect(fetchClassicKvBundles()).rejects.toThrow(
      /GET \/api\/kv saved-queries returned a non-array body/,
    );
  });
});

describe("migrateClassicToLunora", () => {
  test("both watermarks set → skipped-complete without classic fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.reject(new Error("classic fetch must not run"));
    }) as unknown as typeof fetch;

    const result = await migrateClassicToLunora(
      stubStore({
        nodes: [{ _id: "a" }, { _id: "b" }],
        migrateState: { nodesAt: 100, kvAt: 200 },
      }),
      "user-1",
    );

    expect(result).toEqual({ status: "skipped-complete", nodes: 2 });
    expect(fetchCalls).toBe(0);
  });

  test("partial Lunora nodes + classic remainder → imports missing ids before nodesAt", async () => {
    const imports: ImportCall[] = [];
    const patches: MutatorCall[] = [];
    installClassicFetch({
      nodes: [classicNode("a"), classicNode("b", "a"), classicNode("c", "b")],
      kv: {
        "tag-colors": [],
        "saved-queries": [],
        "daily-index": [{ key: "container", nodeId: "daily" }],
      },
    });

    const result = await migrateClassicToLunora(
      stubStore({
        // Partial prior import: only `a` landed.
        nodes: [{ _id: "a" }],
        migrateState: { nodesAt: null, kvAt: null },
        onImport: (c) => imports.push(c),
        onMutator: (c) => {
          if (c.ref === "mutators:setMigrateState") patches.push(c);
        },
      }),
      "user-1",
    );

    expect(result.status).toBe("migrated");
    if (result.status !== "migrated") return;
    expect(result.nodes).toBe(2); // b + c only
    expect(imports.filter((i) => i.kind === "nodes")).toEqual([
      { kind: "nodes", count: 2 },
    ]);
    // nodesAt stamped before/with kv — never skipped over a partial set.
    expect(patches[0]?.args.nodesAt).toEqual(expect.any(Number));
    expect(patches[0]?.args.kvAt).toBeUndefined();
    expect(patches.some((p) => typeof p.args.kvAt === "number")).toBe(true);
  });

  test("forceHealClassicKv clears false-complete kvAt and re-imports KV", async () => {
    const imports: ImportCall[] = [];
    installClassicFetch({
      nodes: [classicNode("a")],
      kv: {
        "tag-colors": [],
        "saved-queries": [],
        "daily-index": [
          { key: "container", nodeId: "daily" },
          { key: "2026-07-26", nodeId: "today" },
        ],
      },
    });

    const store = stubStore({
      nodes: [{ _id: "a" }],
      // Stuck after a bad prior pass — migrate alone would skipped-complete.
      migrateState: { nodesAt: 100, kvAt: 200 },
      onImport: (c) => imports.push(c),
    });

    expect(await migrateClassicToLunora(store, "user-1")).toEqual({
      status: "skipped-complete",
      nodes: 1,
    });

    const healed = await forceHealClassicKv(store, "user-1");
    expect(healed.status).toBe("migrated");
    if (healed.status !== "migrated") return;
    expect(healed.kv).toBe(2);
    expect(imports.filter((i) => i.kind === "kv")).toEqual([
      { kind: "kv", count: 2 },
    ]);
  });

  test("forceRemigrateFromClassic clears watermarks and syncs all classic nodes", async () => {
    const imports: ImportCall[] = [];
    installClassicFetch({
      nodes: [classicNode("a"), classicNode("b", "a")],
      kv: {
        "tag-colors": [],
        "saved-queries": [],
        "daily-index": [],
      },
    });

    const result = await forceRemigrateFromClassic(
      stubStore({
        nodes: [{ _id: "a" }],
        migrateState: { nodesAt: 100, kvAt: 200 },
        onImport: (c) => imports.push(c),
      }),
      "user-1",
    );

    expect(result.status).toBe("migrated");
    if (result.status !== "migrated") return;
    // Structure sync sends every classic row (a + b), not only missing b.
    expect(result.nodes).toBe(2);
    expect(imports.some((i) => i.kind === "nodes" && i.count === 2)).toBe(true);
  });

  test("malformed KV 200 → failed migrate, no kvAt stamp", async () => {
    const patches: MutatorCall[] = [];
    installClassicFetch({
      nodes: [classicNode("a")],
      kv: {
        "tag-colors": [],
        "saved-queries": { bad: true },
        "daily-index": [],
      },
    });

    const result = await migrateClassicToLunora(
      stubStore({
        nodes: [],
        migrateState: null,
        onMutator: (c) => {
          if (c.ref === "mutators:setMigrateState") patches.push(c);
        },
      }),
      "user-1",
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(String(result.error)).toMatch(/non-array body/);
    expect(patches).toEqual([]);
  });
});
