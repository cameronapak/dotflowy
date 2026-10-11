/**
 * The MCP endpoint (worker/mcp.ts + worker/mcp-tools.ts) against an in-memory
 * `OutlineStore` fake — the same seam the DO stub satisfies in production.
 * Unit-tested here because the whole surface is request/response-pure below
 * auth: JSON-RPC dispatch, the Effect-Schema tool-input gate (ADR 0014 — the
 * published schema and the enforcing decoder are one value), and the tool
 * handlers' plan->applyBatch flow. e2e can't reach any of it (`seedOutline`
 * mocks the Worker, and MCP has no browser caller).
 */

import { describe, expect, test } from "bun:test";
import { Clock, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

import type { ChangeOp, Node } from "../src/data/wire-schema";
import type { OutlineStore } from "./mcp-tools";

import { createNode } from "../src/data/tree";
import { handleMcp } from "./mcp";
import { SearchPage } from "./search";

// --- In-memory store fake -----------------------------------------------------

interface FakeStore {
  store: OutlineStore;
  nodes: Map<string, Node>;
  kv: Map<string, { key: string; nodeId: string }>;
  batches: ChangeOp[][];
  expectedWeekStarts: Array<"sunday" | "monday" | undefined>;
}

function makeStore(
  seed: Node[] = [],
  kvRows: Array<{ key: string; nodeId: string }> = [],
  weekStart?: "sunday" | "monday",
): FakeStore {
  const nodes = new Map(seed.map((n) => [n.id, n]));
  const kv = new Map(kvRows.map((r) => [r.key, r]));
  const batches: ChangeOp[][] = [];
  const expectedWeekStarts: Array<"sunday" | "monday" | undefined> = [];
  const store: OutlineStore = {
    getNodes: () => [...nodes.values()],
    applyBatch: (ops, expectedWeekStart) => {
      expectedWeekStarts.push(expectedWeekStart);
      batches.push([...ops]);
      for (const op of ops) {
        if (op.op === "delete") nodes.delete(op.key);
        else nodes.set(op.value.id, op.value);
      }
      return batches.length;
    },
    getKv: (collection) => {
      if (collection === "daily-index") return [...kv.values()];
      if (collection === "account-prefs" && weekStart) {
        return [{ key: "daily:week-start", weekStart }];
      }
      return [];
    },
    getOrCreateKv: (collection, key, value) => {
      if (collection !== "daily-index")
        throw new Error(`unexpected kv collection ${collection}`);
      const existing = kv.get(key);
      if (existing) return existing;
      // SAFETY: this fake only serves the daily-index collection, whose values are always the { nodeId } claim.
      kv.set(key, value as { key: string; nodeId: string });
      return value;
    },
    canonicalizeWeekStart: () => ({
      weekStart: weekStart ?? "monday",
      seq: batches.length,
    }),
  };
  return { store, nodes, kv, batches, expectedWeekStarts };
}

// --- Request plumbing -----------------------------------------------------------

/** A JSON-RPC params payload the tests send (raw JSON shapes). */
type RpcParams = { readonly [key: string]: Schema.Json };

/** The JSON-RPC request body the tests serialize. */
interface RpcRequestBody {
  jsonrpc: "2.0";
  method: string;
  id?: number | null;
  params?: RpcParams;
}

// Each test request is its own stateless HTTP exchange, so a fixed id is fine.
async function rpc(
  store: OutlineStore,
  method: string,
  params?: RpcParams,
  id: number | null = 1,
  // The provenance stamp the Worker resolves from the bearer token in prod; a
  // fixed harness name here so the stamping assertions have something to check.
  origin: string | null = "TestAgent",
  agentAccess = true,
  // Pins "now" through Effect's TestClock; omit for the real clock.
  now?: number,
) {
  const body: RpcRequestBody = { jsonrpc: "2.0", method };
  if (id !== null) body.id = id;
  if (params !== undefined) body.params = params;
  const request = new Request("http://test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const program = handleMcp(request, store, origin, agentAccess);
  if (now === undefined) return Effect.runPromise(program);
  return Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(now);
      return yield* program.pipe(Effect.provideService(Clock.Clock, clock));
    }).pipe(Effect.scoped),
  );
}

async function callTool(
  store: OutlineStore,
  name: string,
  args: RpcParams,
  now?: number,
) {
  const res = await rpc(
    store,
    "tools/call",
    { name, arguments: args },
    1,
    "TestAgent",
    true,
    now,
  );
  // SAFETY: parsed from the JSON-RPC body our own handleMcp serializes; fields verified by the expects below.
  const json = (await res.json()) as {
    result?: {
      content: Array<{ type: string; text: string }>;
      structuredContent?: SearchPage;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  };
  return json;
}

function toolText(json: Awaited<ReturnType<typeof callTool>>): string {
  return json.result?.content[0]?.text ?? "";
}

function inserts(ops: ChangeOp[]): Node[] {
  return ops.flatMap((op) => (op.op === "insert" ? [op.value] : []));
}

/** a -> b (top level), a1 under a. */
function fixture(): Node[] {
  return [
    createNode({ id: "a", text: "alpha" }),
    createNode({ id: "b", text: "bravo", prevSiblingId: "a" }),
    createNode({ id: "a1", text: "alpha one", parentId: "a" }),
  ];
}

// --- Protocol level -------------------------------------------------------------

/** POST (or any method) a raw body straight at the handler. */
function raw(store: OutlineStore, init: RequestInit) {
  return Effect.runPromise(
    handleMcp(new Request("http://test/api/mcp", init), store, null, true),
  );
}

describe("MCP transport", () => {
  test("the handshake negotiates a version, acknowledges notifications, and pongs", async () => {
    const { store } = makeStore();
    // SAFETY: parsed from the initialize response our own handler serializes; fields checked by the expects below.
    const init = (await (
      await rpc(store, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      })
    ).json()) as any;
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.serverInfo.name).toBe("dotflowy");

    // An unknown requested version is countered with the latest supported one.
    // SAFETY: parsed from the initialize response our own handler serializes; field checked by the expect below.
    const counter = (await (
      await rpc(store, "initialize", { protocolVersion: "1999-01-01" })
    ).json()) as any;
    expect(counter.result.protocolVersion).toBe("2025-06-18");

    const note = await rpc(store, "notifications/initialized", undefined, null);
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");

    // SAFETY: parsed from the ping response our own handler serializes; field checked by the expect below.
    const ping = (await (await rpc(store, "ping")).json()) as any;
    expect(ping.result).toEqual({});
  });

  test("tools/list publishes the Effect Schema inputs agents rely on", async () => {
    const { store } = makeStore();
    // SAFETY: parsed from the tools/list response our own handler serializes; fields checked by the expects below.
    const json = (await (await rpc(store, "tools/list")).json()) as any;
    const tool = (name: string) =>
      json.result.tools.find((t: any) => t.name === name);

    expect(tool("add_node").inputSchema.type).toBe("object");
    expect(tool("add_node").inputSchema.required).toEqual(["text"]);
    expect(tool("add_node").annotations.readOnlyHint).toBe(false);
    expect(tool("get_outline").annotations.readOnlyHint).toBe(true);

    // Creation tools take `kind: "paragraph"`; none of them REQUIRE it.
    for (const name of ["add_node", "add_to_today"]) {
      expect(JSON.stringify(tool(name).inputSchema.properties.kind)).toContain(
        "paragraph",
      );
      expect(tool(name).inputSchema.required).not.toContain("kind");
    }
    // update_node names the reset explicitly rather than overloading null.
    const updateKind = JSON.stringify(
      tool("update_node").inputSchema.properties.kind,
    );
    expect(updateKind).toContain("paragraph");
    expect(updateKind).toContain("bullet");

    // The recursive SubtreeNode shape is emitted as a referenced $def, and it
    // carries `kind` so a whole forest can land as prose (ADR 0028).
    const addSubtree = tool("add_subtree").inputSchema;
    expect(addSubtree.required).toEqual(["nodes"]);
    expect(JSON.stringify(addSubtree.$defs.SubtreeNode)).toContain("paragraph");
    expect(JSON.stringify(addSubtree)).toContain("#/$defs/SubtreeNode");

    // search_nodes publishes both its input bounds and its output contract.
    const search = tool("search_nodes");
    expect(search.inputSchema.required).toEqual(["query"]);
    expect(search.inputSchema.properties.limit).toMatchObject({
      minimum: 1,
      maximum: 100,
    });
    expect(search.inputSchema.properties.nodeId).toBeDefined();
    expect(search.inputSchema.properties.cursor).toBeDefined();
    expect(search.outputSchema.required).toEqual(["nodes", "nextCursor"]);
  });

  test("protocol faults map to their JSON-RPC codes and GET is declined", async () => {
    const { store } = makeStore();
    // SAFETY: parsed from the error body our own handler serializes; field checked by the expect below.
    expect(
      ((await (await rpc(store, "resources/list")).json()) as any).error.code,
    ).toBe(-32601);
    expect((await callTool(store, "not_a_tool", {})).error?.code).toBe(-32602);
    expect((await callTool(store, "add_node", { text: 42 })).error?.code).toBe(
      -32602,
    );

    const bad = await raw(store, { method: "POST", body: "{nope" });
    // SAFETY: parsed from the error body our own handler serializes; field checked by the expect below.
    expect(((await bad.json()) as any).error.code).toBe(-32700);

    const batch = await raw(store, { method: "POST", body: "[]" });
    // SAFETY: parsed from the error body our own handler serializes; field checked by the expect below.
    expect(((await batch.json()) as any).error.code).toBe(-32600);

    // Stateless: no server stream.
    expect((await raw(store, { method: "GET" })).status).toBe(405);
  });

  test("a free plan (no agent access) refuses tools/call but keeps discovery open (#170)", async () => {
    const { store, batches } = makeStore(fixture());
    const free = async (method: string, params: RpcParams) =>
      // SAFETY: parsed from the JSON-RPC body our own handler serializes; fields checked by the expects below.
      (await (
        await rpc(store, method, params, 1, "TestAgent", false)
      ).json()) as any;

    // tools/call, the only entitlement-gated method, is refused, and no write
    // reaches the store.
    const read = await free("tools/call", {
      name: "get_outline",
      arguments: {},
    });
    expect(read.error.code).toBe(-32001);
    expect(read.result).toBeUndefined();
    const write = await free("tools/call", {
      name: "add_node",
      arguments: { text: "nope" },
    });
    expect(write.error.code).toBe(-32001);
    expect(batches.length).toBe(0);

    // initialize / ping / tools/list stay open, so a free connection can still
    // handshake and see WHY every call is refused.
    for (const method of ["initialize", "ping", "tools/list"]) {
      const ok = await free(method, {});
      expect(ok.result).toBeDefined();
      expect(ok.error).toBeUndefined();
    }
  });
});

// --- Tools over the fake store ----------------------------------------------------

describe("MCP tools", () => {
  test("get_outline renders lines with ids and indentation", async () => {
    const { store } = makeStore(fixture());
    const outline = toolText(await callTool(store, "get_outline", {}));
    expect(outline).toContain("- alpha (id: a)");
    expect(outline).toContain("  - alpha one (id: a1)");
  });

  test("DQL search returns validated structured pages and explicit continuation", async () => {
    const fake = makeStore([
      createNode({
        id: "p",
        text: "Project ||hidden-parent||",
        collapsed: true,
      }),
      ...Array.from({ length: 3 }, (_, i) =>
        createNode({
          id: `t${i}`,
          parentId: "p",
          prevSiblingId: i === 0 ? null : `t${i - 1}`,
          text: `Ship ${i} #dotflowy ||secret-${i}||`,
          isTask: true,
        }),
      ),
      createNode({
        id: "done",
        parentId: "p",
        prevSiblingId: "t2",
        text: "Done #dotflowy",
        isTask: true,
        completed: true,
      }),
    ]);
    const input = {
      query: "is:todo -is:complete #dotflowy",
      nodeId: "p",
      limit: 2,
    };
    const first = await callTool(fake.store, "search_nodes", input);
    const data = Schema.decodeUnknownSync(SearchPage)(
      first.result?.structuredContent,
    );
    expect(first.error).toBeUndefined();
    expect(data.nodes.map((node) => node.id)).toEqual(["t0", "t1"]);
    expect(data.nodes[0]?.path).toEqual(["Project [spoiler]"]);
    expect(toolText(first)).toContain("Ship 0 #dotflowy [spoiler]");
    // A partial page carries a second, continuation content block.
    expect(first.result?.content).toHaveLength(2);
    expect(JSON.stringify(first)).not.toContain("secret-");
    expect(JSON.stringify(first)).not.toContain("hidden-parent");
    if (!data.nextCursor) throw new Error("Expected continuation");
    const second = await callTool(fake.store, "search_nodes", {
      ...input,
      cursor: data.nextCursor,
    });
    expect(
      second.result?.structuredContent?.nodes.map((node) => node.id),
    ).toEqual(["t2"]);
    expect(second.result?.structuredContent?.nextCursor).toBeNull();
    expect(second.result?.content).toHaveLength(1);
    const changed = fake.nodes.get("t2");
    if (!changed) throw new Error("Missing fixture node");
    fake.nodes.set("t2", { ...changed, completed: true });
    const stale = await callTool(fake.store, "search_nodes", {
      ...input,
      cursor: data.nextCursor,
    });
    expect(stale.result?.isError).toBe(true);
    expect(stale.result?.structuredContent).toBeUndefined();
    expect(fake.batches).toEqual([]);
  });

  test("DQL search rejects invalid page bounds and reports empty and missing scopes", async () => {
    const { store } = makeStore(fixture());
    for (const limit of [0, 101, 2.5]) {
      expect(
        (await callTool(store, "search_nodes", { query: "alpha", limit })).error
          ?.code,
      ).toBe(-32602);
    }
    const empty = await callTool(store, "search_nodes", { query: "unmatched" });
    expect(empty.result?.structuredContent).toEqual({
      nodes: [],
      nextCursor: null,
    });
    const missing = await callTool(store, "search_nodes", {
      query: "alpha",
      nodeId: "missing",
    });
    expect(missing.result?.isError).toBe(true);
  });

  test("add_node writes one atomic batch, stamps origin, and reports the new id", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "add_node", {
      text: "new bullet",
      parentId: "a",
    });
    expect(json.result?.isError).toBeUndefined();
    expect(fake.batches).toHaveLength(1);
    const insert = inserts(fake.batches[0]!)[0]!;
    expect(insert.parentId).toBe("a");
    // Provenance: the resolved harness name is stamped onto the created node, so
    // the editor can mark an agent's edit apart from the user's own (write-once).
    expect(insert.origin).toBe("TestAgent");
    expect(toolText(json)).toContain(insert.id);
  });

  test("write receipts redact spoilers without changing stored text", async () => {
    const parent = createNode({
      id: "secret-parent",
      text: "parent ||answer||",
      prevSiblingId: "b",
    });
    const unclosed = createNode({
      id: "unmatched-parent",
      text: "parent ||",
      prevSiblingId: parent.id,
    });
    const fake = makeStore([...fixture(), parent, unclosed]);
    const stored = (text: string) =>
      [...fake.nodes.values()].find((n) => n.text === text)?.text;

    const added = toolText(
      await callTool(fake.store, "add_node", {
        text: "child ||twist||",
        parentId: parent.id,
      }),
    );
    expect(added).toContain("child [spoiler]");
    expect(added).toContain("parent [spoiler]");
    expect(added).not.toContain("answer");
    expect(added).not.toContain("twist");
    expect(stored("child ||twist||")).toBe("child ||twist||");

    // Child and parent redact independently: two unclosed fences must not pair
    // up across the receipt into one spoiler run.
    const unmatched = toolText(
      await callTool(fake.store, "add_node", {
        text: "child ||",
        parentId: unclosed.id,
      }),
    );
    expect(unmatched).toContain("child ||");
    expect(unmatched).toContain("parent ||");
    expect(unmatched).not.toContain("[spoiler]");

    const mirrored = toolText(
      await callTool(fake.store, "mirror_node", {
        nodeId: "a1",
        parentId: parent.id,
      }),
    );
    expect(mirrored).toContain("parent [spoiler]");
    expect(mirrored).not.toContain("answer");

    const subtree = toolText(
      await callTool(fake.store, "add_subtree", {
        nodes: [{ text: "root ||hidden||" }],
      }),
    );
    expect(subtree).toContain("root [spoiler]");
    expect(subtree).not.toContain("hidden");

    const moved = toolText(
      await callTool(fake.store, "move_nodes", {
        nodeIds: ["b"],
        newParentId: parent.id,
      }),
    );
    expect(moved).toContain("parent [spoiler]");
    expect(moved).not.toContain("answer");

    const today = toolText(
      await callTool(fake.store, "add_to_today", {
        text: "today ||private||",
        date: "2026-07-03",
      }),
    );
    expect(today).toContain("today [spoiler]");
    expect(today).not.toContain("private");
    expect(stored("today ||private||")).toBe("today ||private||");

    const imported = toolText(
      await callTool(fake.store, "import_opml", {
        opml: '<opml version="2.0"><body><outline text="import ||secret||"/></body></opml>',
      }),
    );
    expect(imported).toContain("import [spoiler]");
    expect(imported).not.toContain("secret");
  });

  test("add_subtree inserts a nested forest as ONE atomic batch, stamping origin on all", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "add_subtree", {
      parentId: "a",
      nodes: [
        { text: "one", children: [{ text: "one-a" }, { text: "one-b" }] },
        { text: "two" },
      ],
    });
    expect(json.result?.isError).toBeUndefined();
    expect(fake.batches).toHaveLength(1);
    const created = inserts(fake.batches[0]!);
    // 2 roots + 2 grandchildren = 4 fresh nodes, all agent-stamped.
    expect(created).toHaveLength(4);
    expect(created.every((n) => n.origin === "TestAgent")).toBe(true);
    const roots = created.filter((n) => n.parentId === "a");
    expect(roots).toHaveLength(2);
    // The reply names the created bullets by id.
    expect(toolText(json)).toContain(roots[0]!.id);
  });

  test("add_subtree onto the daily note claims the day and appends the forest", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "add_subtree", {
      date: "2026-07-03",
      nodes: [{ text: "research", children: [{ text: "finding" }] }],
    });
    expect(json.result?.isError).toBeUndefined();
    expect(fake.batches).toHaveLength(1);
    expect(fake.kv.has("container")).toBe(true);
    const dayId = fake.kv.get("2026-07-03")!.nodeId;
    const research = [...fake.nodes.values()].find(
      (n) => n.text === "research",
    );
    expect(research?.parentId).toBe(dayId);
  });

  test("add_subtree and import_opml refuse bad targets without writing or claiming", async () => {
    const fake = makeStore(fixture());
    const opml = '<opml version="2.0"><body><outline text="x" /></body></opml>';
    const refusals = [
      // Both selectors at once.
      callTool(fake.store, "add_subtree", {
        parentId: "a",
        date: "2026-07-03",
        nodes: [{ text: "x" }],
      }),
      callTool(fake.store, "import_opml", {
        opml,
        parentId: "a",
        date: "2026-07-03",
      }),
      // A missing parent.
      callTool(fake.store, "add_subtree", {
        parentId: "ghost",
        nodes: [{ text: "x" }],
      }),
      callTool(fake.store, "import_opml", { opml, parentId: "ghost" }),
      // An empty forest onto a day: the size guard runs before the kv claims,
      // so no orphan container/day mapping is left behind (ADR 0028).
      callTool(fake.store, "add_subtree", { date: "2026-07-03", nodes: [] }),
      // A truncated document.
      callTool(fake.store, "import_opml", {
        opml: '<opml version="2.0"><body><outline text="x"',
      }),
    ];
    for (const json of await Promise.all(refusals)) {
      expect(json.error).toBeUndefined();
      expect(json.result?.isError).toBe(true);
    }
    expect(fake.batches).toHaveLength(0);
    expect(fake.kv.size).toBe(0);
  });

  test("update_node and delete_node edit, cascade, and refuse as tool errors", async () => {
    const fake = makeStore([
      ...fixture(),
      createNode({
        id: "m",
        text: "alpha",
        mirrorOf: "a1",
        prevSiblingId: "b",
      }),
    ]);
    await callTool(fake.store, "update_node", {
      nodeId: "a1",
      completed: true,
    });
    expect(fake.nodes.get("a1")?.completed).toBe(true);

    // No fields to change, and a missing node, are tool errors, not crashes or
    // protocol errors.
    const noop = await callTool(fake.store, "update_node", { nodeId: "a1" });
    expect(noop.result?.isError).toBe(true);
    const ghost = await callTool(fake.store, "delete_node", {
      nodeId: "ghost",
    });
    expect(ghost.error).toBeUndefined();
    expect(ghost.result?.isError).toBe(true);

    // Deleting an ancestor of a surviving mirror is refused (ADR 0022 v1).
    const orphan = await callTool(fake.store, "delete_node", { nodeId: "a" });
    expect(orphan.result?.isError).toBe(true);
    expect(fake.nodes.has("a")).toBe(true);

    // Once the mirror is gone, the delete cascades.
    await callTool(fake.store, "delete_node", { nodeId: "m" });
    const json = await callTool(fake.store, "delete_node", { nodeId: "a" });
    expect(json.result?.isError).toBeUndefined();
    expect(fake.nodes.has("a")).toBe(false);
    expect(fake.nodes.has("a1")).toBe(false);
    expect(fake.nodes.has("b")).toBe(true);
  });

  test("move_nodes reparents in one batch and refuses a move into its own subtree", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "move_nodes", {
      nodeIds: ["b"],
      newParentId: "a",
    });
    expect(json.result?.isError).toBeUndefined();
    expect(fake.batches).toHaveLength(1);
    expect(fake.nodes.get("b")?.parentId).toBe("a");

    const cycle = await callTool(fake.store, "move_nodes", {
      nodeIds: ["a"],
      newParentId: "a1",
    });
    expect(cycle.error).toBeUndefined();
    expect(cycle.result?.isError).toBe(true);
    expect(fake.batches).toHaveLength(1);
    expect(fake.nodes.get("a")?.parentId).toBeNull();
  });

  test("add_to_today claims every calendar level, files entries under the day, and reuses it", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "add_to_today", {
      text: "first",
      date: "2026-07-03",
    });
    expect(json.result?.isError).toBeUndefined();
    // The whole chain + entry lands as ONE batch (ADR 0009).
    expect(fake.batches).toHaveLength(1);
    // Every calendar level is claimed in the kv index (issue #271), and the
    // claimed ids are the ones the batch wired together.
    const id = (key: string) => fake.kv.get(key)!.nodeId;
    expect(fake.nodes.get(id("2026"))?.parentId).toBe(id("container"));
    expect(fake.nodes.get(id("2026-07"))?.parentId).toBe(id("2026"));
    expect(fake.nodes.get(id("week:2026-06-29"))?.parentId).toBe(id("2026-07"));
    expect(fake.nodes.get(id("2026-07-03"))?.parentId).toBe(
      id("week:2026-06-29"),
    );
    const dayId = id("2026-07-03");

    // A second capture reuses the claimed day (the kv claim is authoritative).
    await callTool(fake.store, "add_to_today", {
      text: "second",
      date: "2026-07-03",
    });
    expect(id("2026-07-03")).toBe(dayId);
    const entries = [...fake.nodes.values()].filter(
      (n) => n.parentId === dayId,
    );
    expect(entries.map((n) => n.text).sort()).toEqual(["first", "second"]);

    const malformed = await callTool(fake.store, "add_to_today", {
      text: "x",
      date: "07/03/2026",
    });
    expect(malformed.result?.isError).toBe(true);
    expect(fake.batches).toHaveLength(2);
  });

  test("add_to_today files under the account's Sunday-start Calendar week", async () => {
    const fake = makeStore(fixture(), [], "sunday");
    const json = await callTool(fake.store, "add_to_today", {
      text: "Sunday capture",
      date: "2026-07-05",
    });

    expect(json.result?.isError).toBeUndefined();
    expect(fake.kv.get("week:2026-07-05")).toBeDefined();
    expect(fake.kv.get("week:2026-06-29")).toBeUndefined();
    // The commit carries the Week start the plan was built against.
    expect(fake.expectedWeekStarts).toEqual(["sunday"]);
  });

  test("add_to_today refuses a plan when Week start changes before commit", async () => {
    const fake = makeStore(fixture(), [], "monday");
    fake.store.applyBatch = (_ops, expectedWeekStart) => {
      expect(expectedWeekStart).toBe("monday");
      throw new Error("CALENDAR_CHANGED: retry against the current Week start");
    };

    const json = await callTool(fake.store, "add_to_today", {
      text: "Stale capture",
      date: "2026-07-05",
    });

    expect(json.result?.isError).toBe(true);
    expect(toolText(json)).toContain("CALENDAR_CHANGED");
    expect(
      [...fake.nodes.values()].some((node) => node.text === "Stale capture"),
    ).toBe(false);
  });

  test("mirror_node mirrors with a live pointer, mirror_to_today onto the day; a cycle is refused", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "mirror_node", {
      nodeId: "a1",
      parentId: "b",
    });
    expect(json.result?.isError).toBeUndefined();
    const mirror = [...fake.nodes.values()].find((n) => n.mirrorOf === "a1");
    expect(mirror?.parentId).toBe("b");

    const cycle = await callTool(fake.store, "mirror_node", {
      nodeId: "a",
      parentId: "a1",
    });
    expect(cycle.result?.isError).toBe(true);

    const today = await callTool(fake.store, "mirror_to_today", {
      nodeId: "a",
      date: "2026-07-03",
    });
    expect(today.result?.isError).toBeUndefined();
    const dayId = fake.kv.get("2026-07-03")!.nodeId;
    const dayMirror = [...fake.nodes.values()].find((n) => n.mirrorOf === "a");
    expect(dayMirror?.parentId).toBe(dayId);
  });

  test("timeZone steers the omitted-date default and is validated even when date wins (issue #336)", async () => {
    const now = Date.parse("2026-08-10T00:30:00Z");
    // 00:30 UTC is already 08-10 in UTC but still 08-09 in
    // America/Los_Angeles: the capture belongs on the user's calendar day,
    // not UTC's. (23:30Z on the 9th would leave UTC on the 9th too, so it
    // could never detect a UTC fallback.)
    const west = makeStore(fixture());
    const westJson = await callTool(
      west.store,
      "add_to_today",
      {
        text: "captured",
        timeZone: "America/Los_Angeles",
      },
      now,
    );
    expect(westJson.result?.isError).toBeUndefined();
    expect(west.kv.has("2026-08-09")).toBe(true);
    expect(west.kv.has("2026-08-10")).toBe(false);

    // East of UTC the same instant is already tomorrow.
    const east = makeStore(fixture());
    await callTool(
      east.store,
      "add_to_today",
      {
        text: "captured",
        timeZone: "Asia/Tokyo",
      },
      now,
    );
    expect(east.kv.has("2026-08-10")).toBe(true);
    expect(east.kv.has("2026-08-09")).toBe(false);

    // mirror_to_today defaults "today" the same way.
    const mir = makeStore(fixture());
    await callTool(
      mir.store,
      "mirror_to_today",
      {
        nodeId: "a1",
        timeZone: "America/Los_Angeles",
      },
      now,
    );
    expect(mir.kv.has("2026-08-09")).toBe(true);
    expect(mir.kv.has("2026-08-10")).toBe(false);

    // An explicit date wins over timeZone on every daily tool. add_subtree
    // and import_opml use `date` as a target selector, so timeZone is
    // validated there and otherwise ignored.
    const opml =
      '<opml version="2.0"><body><outline text="one" /></body></opml>';
    for (const [name, args] of [
      ["add_to_today", { text: "x" }],
      ["add_subtree", { nodes: [{ text: "x" }] }],
      ["import_opml", { opml }],
    ] as const) {
      const ok = makeStore(fixture());
      const okJson = await callTool(
        ok.store,
        name,
        {
          ...args,
          date: "2026-07-03",
          timeZone: "America/Los_Angeles",
        },
        now,
      );
      expect(okJson.result?.isError).toBeUndefined();
      expect(ok.kv.has("2026-07-03")).toBe(true);

      // A malformed timeZone is refused, nothing written or claimed, even
      // when `date` would have won.
      const bad = makeStore(fixture());
      const badJson = await callTool(
        bad.store,
        name,
        {
          ...args,
          date: "2026-07-03",
          timeZone: "bogus",
        },
        now,
      );
      expect(badJson.result?.isError).toBe(true);
      expect(bad.batches).toHaveLength(0);
      expect(bad.kv.size).toBe(0);
    }

    // And on the omitted-date path, where it would have steered the day.
    const invalid = makeStore(fixture());
    const invalidJson = await callTool(
      invalid.store,
      "add_to_today",
      {
        text: "x",
        timeZone: "Not/AZone",
      },
      now,
    );
    expect(invalidJson.result?.isError).toBe(true);
    expect(invalid.batches).toHaveLength(0);
    expect(invalid.kv.size).toBe(0);
  });

  test("the daily container and calendar scaffold are protected; a day stays content (#271)", async () => {
    const fake = makeStore(fixture());
    await callTool(fake.store, "add_to_today", {
      text: "x",
      date: "2026-07-03",
    });
    // Delete cascades, so every rule applies to every scaffold level.
    for (const key of ["container", "2026", "2026-07", "week:2026-06-29"]) {
      const nodeId = fake.kv.get(key)!.nodeId;
      const text = fake.nodes.get(nodeId)!.text;

      const del = await callTool(fake.store, "delete_node", { nodeId });
      expect(del.result?.isError).toBe(true);
      expect(fake.nodes.has(nodeId)).toBe(true);

      const changes: RpcParams[] = [
        { text: "  " },
        { isTask: true },
        { completed: true },
      ];
      for (const change of changes) {
        const json = await callTool(fake.store, "update_node", {
          nodeId,
          ...change,
        });
        expect(json.result?.isError).toBe(true);
      }
      expect(fake.nodes.get(nodeId)?.text).toBe(text);
      expect(fake.nodes.get(nodeId)?.completed).toBe(false);
    }

    // Collapse is a position-local field and stays allowed.
    const collapse = await callTool(fake.store, "update_node", {
      nodeId: fake.kv.get("container")!.nodeId,
      collapsed: true,
    });
    expect(collapse.result?.isError).toBeUndefined();

    // A DAY node is content, not scaffold, so it stays freely editable.
    const day = await callTool(fake.store, "update_node", {
      nodeId: fake.kv.get("2026-07-03")!.nodeId,
      completed: true,
    });
    expect(day.result?.isError).toBeUndefined();
  });

  test("import_opml lands the forest as ONE atomic batch with origin stamped, and a compact receipt", async () => {
    const fake = makeStore(fixture());
    const opml = [
      '<?xml version="1.0"?>',
      '<opml version="2.0"><head><title>t</title></head><body>',
      '<outline text="one" _note="a note line"><outline text="one-a" _complete="true" /></outline>',
      '<outline text="two" _task="true" />',
      "</body></opml>",
    ].join("\n");
    const json = await callTool(fake.store, "import_opml", {
      opml,
      parentId: "a",
    });
    expect(json.result?.isError).toBeUndefined();
    expect(fake.batches).toHaveLength(1);
    const created = inserts(fake.batches[0]!);
    // 2 roots + 1 child + 1 note-derived bullet = 4 fresh nodes, all
    // provenance-stamped.
    expect(created).toHaveLength(4);
    expect(created.every((n) => n.origin === "TestAgent")).toBe(true);
    const roots = created.filter((n) => n.parentId === "a");
    expect(roots.map((n) => n.text)).toEqual(["one", "two"]);
    expect(created.find((n) => n.text === "two")?.isTask).toBe(true);
    expect(created.find((n) => n.text === "one-a")?.completed).toBe(true);
    // The receipt names the root ids and never echoes the whole forest.
    const text = toolText(json);
    expect(text).toContain(roots[0]!.id);
    expect(text).toContain(roots[1]!.id);
    expect(text).not.toContain("one-a");
  });

  test("import_opml dryRun writes and claims nothing; the real import lands under the day", async () => {
    const fake = makeStore(fixture());
    const opml =
      '<opml version="2.0"><body><outline text="from-agent" /></body></opml>';

    const targets: RpcParams[] = [{ date: "2026-07-03" }, { parentId: "a" }];
    for (const target of targets) {
      const dry = await callTool(fake.store, "import_opml", {
        opml,
        ...target,
        dryRun: true,
      });
      expect(dry.result?.isError).toBeUndefined();
    }
    expect(fake.batches).toHaveLength(0);
    expect(fake.nodes.size).toBe(3);
    // A dry run must not claim daily-index ids either: a kv claim IS a write.
    expect(fake.kv.size).toBe(0);

    const real = await callTool(fake.store, "import_opml", {
      opml,
      date: "2026-07-03",
    });
    expect(real.result?.isError).toBeUndefined();
    expect(fake.batches).toHaveLength(1);
    const dayId = fake.kv.get("2026-07-03")!.nodeId;
    const imported = [...fake.nodes.values()].find(
      (n) => n.text === "from-agent",
    );
    expect(imported?.parentId).toBe(dayId);
  });

  test("import_opml over the 5,000-node ceiling is refused, nothing written", async () => {
    const fake = makeStore(fixture());
    const opml = `<opml version="2.0"><body>${'<outline text="x" />'.repeat(5001)}</body></opml>`;
    const json = await callTool(fake.store, "import_opml", { opml });
    expect(json.result?.isError).toBe(true);
    expect(fake.batches).toHaveLength(0);
  });

  test("export_opml returns raw OPML scoped by nodeId, which round-trips through import_opml", async () => {
    const fake = makeStore(fixture());
    const whole = toolText(await callTool(fake.store, "export_opml", {}));
    // No preamble: the text is the document itself.
    expect(whole.startsWith('<?xml version="1.0"?>')).toBe(true);
    expect(whole).toContain("alpha");
    expect(whole).toContain("bravo");

    // Scope mirrors get_outline: the root is included, siblings are not.
    const scoped = toolText(
      await callTool(fake.store, "export_opml", { nodeId: "a" }),
    );
    expect(scoped).toContain("alpha one");
    expect(scoped).not.toContain("bravo");

    const json = await callTool(fake.store, "import_opml", {
      opml: scoped,
      parentId: "b",
    });
    expect(json.result?.isError).toBeUndefined();
    const created = inserts(fake.batches[0]!);
    expect(created.map((n) => n.text)).toEqual(["alpha", "alpha one"]);
    expect(created[0]!.parentId).toBe("b");
    expect(created[1]!.parentId).toBe(created[0]!.id);
  });

  test("export_opml over the 5,000-node ceiling rejects, never truncates", async () => {
    const seed: Node[] = [createNode({ id: "root", text: "root" })];
    let prev: string | null = null;
    for (let i = 0; i < 5001; i++) {
      const id = `c${i}`;
      seed.push(
        createNode({
          id,
          text: `child ${i}`,
          parentId: "root",
          prevSiblingId: prev,
        }),
      );
      prev = id;
    }
    const { store } = makeStore(seed);
    const json = await callTool(store, "export_opml", { nodeId: "root" });
    expect(json.result?.isError).toBe(true);

    // Scoping down to a subtree under the ceiling still works.
    const scoped = await callTool(store, "export_opml", { nodeId: "c0" });
    expect(scoped.result?.isError).toBeUndefined();
    expect(toolText(scoped)).toContain("child 0");
  });

  test("a store fault surfaces as a tool error with the real message", async () => {
    // Store faults used to become protocol-level -32603 "internal error",
    // which hid the Lunora shard's compound-SELECT failure behind a generic
    // message. They now match commit(): an isError tool result carrying the
    // store's own diagnostic (the caller is the shard owner's own agent).
    const broken: OutlineStore = {
      getNodes: () => {
        throw new Error("too many terms in compound SELECT: SQLITE_ERROR");
      },
      applyBatch: () => 0,
      getKv: () => [],
      getOrCreateKv: () => ({ key: "", nodeId: "" }),
    };
    const json = await callTool(broken, "get_outline", {});
    expect(json.result?.isError).toBe(true);
    expect(toolText(json)).toContain("too many terms in compound SELECT");
  });
});
