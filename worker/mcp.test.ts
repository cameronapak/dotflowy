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
import { Effect } from "effect";

import type { ChangeOp, Node } from "../src/data/wire-schema";
import type { OutlineStore } from "./mcp-tools";

import { makeNode } from "../src/data/tree";
import { handleMcp } from "./mcp";

// --- In-memory store fake -----------------------------------------------------

interface FakeStore {
  store: OutlineStore;
  nodes: Map<string, Node>;
  kv: Map<string, { key: string; nodeId: string }>;
  batches: ChangeOp[][];
}

function makeStore(
  seed: Node[] = [],
  kvRows: Array<{ key: string; nodeId: string }> = [],
): FakeStore {
  const nodes = new Map(seed.map((n) => [n.id, n]));
  const kv = new Map(kvRows.map((r) => [r.key, r]));
  const batches: ChangeOp[][] = [];
  const store: OutlineStore = {
    getNodes: () => [...nodes.values()],
    applyBatch: (ops) => {
      batches.push([...ops]);
      for (const op of ops) {
        if (op.op === "delete") nodes.delete(op.key);
        else nodes.set(op.value.id, op.value);
      }
      return batches.length;
    },
    getKv: (collection) =>
      collection === "daily-index" ? [...kv.values()] : [],
    getOrCreateKv: (collection, key, value) => {
      if (collection !== "daily-index")
        throw new Error(`unexpected kv collection ${collection}`);
      const existing = kv.get(key);
      if (existing) return existing;
      kv.set(key, value as { key: string; nodeId: string });
      return value;
    },
  };
  return { store, nodes, kv, batches };
}

// --- Request plumbing -----------------------------------------------------------

// Each test request is its own stateless HTTP exchange, so a fixed id is fine.
async function rpc(
  store: OutlineStore,
  method: string,
  params?: unknown,
  id: number | null = 1,
  // The provenance stamp the Worker resolves from the bearer token in prod; a
  // fixed harness name here so the stamping assertions have something to check.
  origin: string | null = "TestAgent",
) {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (id !== null) body["id"] = id;
  if (params !== undefined) body["params"] = params;
  const request = new Request("http://test/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return Effect.runPromise(handleMcp(request, store, origin));
}

async function callTool(store: OutlineStore, name: string, args: unknown) {
  const res = await rpc(store, "tools/call", { name, arguments: args });
  const json = (await res.json()) as {
    result?: {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  };
  return json;
}

function toolText(json: Awaited<ReturnType<typeof callTool>>): string {
  return json.result?.content[0]?.text ?? "";
}

/** a -> b (top level), a1 under a. */
function fixture(): Node[] {
  return [
    makeNode({ id: "a", text: "alpha" }),
    makeNode({ id: "b", text: "bravo", prevSiblingId: "a" }),
    makeNode({ id: "a1", text: "alpha one", parentId: "a" }),
  ];
}

// --- Protocol level -------------------------------------------------------------

describe("MCP transport", () => {
  test("initialize echoes a supported protocol version and advertises tools", async () => {
    const { store } = makeStore();
    const res = await rpc(store, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const json = (await res.json()) as any;
    expect(json.result.protocolVersion).toBe("2025-03-26");
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.serverInfo.name).toBe("dotflowy");
  });

  test("an unknown requested protocol version is countered with the latest", async () => {
    const { store } = makeStore();
    const json = (await (
      await rpc(store, "initialize", { protocolVersion: "1999-01-01" })
    ).json()) as any;
    expect(json.result.protocolVersion).toBe("2025-06-18");
  });

  test("notifications get 202 and no body", async () => {
    const { store } = makeStore();
    const res = await rpc(store, "notifications/initialized", undefined, null);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("ping pongs", async () => {
    const { store } = makeStore();
    const json = (await (await rpc(store, "ping")).json()) as any;
    expect(json.result).toEqual({});
  });

  test("tools/list publishes JSON Schema derived from the Effect Schema inputs", async () => {
    const { store } = makeStore();
    const json = (await (await rpc(store, "tools/list")).json()) as any;
    const names = json.result.tools.map((t: any) => t.name);
    expect(names).toEqual([
      "get_outline",
      "search_nodes",
      "add_node",
      "add_subtree",
      "update_node",
      "delete_node",
      "move_nodes",
      "add_to_today",
      "mirror_node",
      "mirror_to_today",
      "import_opml",
      "export_opml",
    ]);
    const addNode = json.result.tools.find((t: any) => t.name === "add_node");
    expect(addNode.inputSchema.type).toBe("object");
    expect(addNode.inputSchema.required).toEqual(["text"]);
    expect(addNode.annotations.readOnlyHint).toBe(false);
    const getOutline = json.result.tools.find(
      (t: any) => t.name === "get_outline",
    );
    expect(getOutline.annotations.readOnlyHint).toBe(true);
  });

  test("unknown method is -32601, unknown tool and bad args are -32602", async () => {
    const { store } = makeStore();
    expect(
      ((await (await rpc(store, "resources/list")).json()) as any).error.code,
    ).toBe(-32601);
    expect((await callTool(store, "not_a_tool", {})).error?.code).toBe(-32602);
    expect((await callTool(store, "add_node", { text: 42 })).error?.code).toBe(
      -32602,
    );
  });

  test("malformed JSON is -32700 and a batch array is -32600", async () => {
    const { store } = makeStore();
    const bad = await Effect.runPromise(
      handleMcp(
        new Request("http://test/api/mcp", { method: "POST", body: "{nope" }),
        store,
        null,
      ),
    );
    expect(((await bad.json()) as any).error.code).toBe(-32700);

    const batch = await Effect.runPromise(
      handleMcp(
        new Request("http://test/api/mcp", { method: "POST", body: "[]" }),
        store,
        null,
      ),
    );
    expect(((await batch.json()) as any).error.code).toBe(-32600);
  });

  test("GET is declined with 405 (stateless: no server stream)", async () => {
    const { store } = makeStore();
    const res = await Effect.runPromise(
      handleMcp(
        new Request("http://test/api/mcp", { method: "GET" }),
        store,
        null,
      ),
    );
    expect(res.status).toBe(405);
  });
});

// --- Tools over the fake store ----------------------------------------------------

describe("MCP tools", () => {
  test("get_outline renders lines with ids; search_nodes finds by substring", async () => {
    const { store } = makeStore(fixture());
    const outline = toolText(await callTool(store, "get_outline", {}));
    expect(outline).toContain("- alpha (id: a)");
    expect(outline).toContain("  - alpha one (id: a1)");

    const hits = toolText(
      await callTool(store, "search_nodes", { query: "one" }),
    );
    expect(hits).toContain("(id: a1)");
    expect(hits).toContain("in: alpha");
  });

  test("add_node writes one atomic batch and reports the new id", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "add_node", {
      text: "new bullet",
      parentId: "a",
    });
    expect(json.result?.isError).toBeUndefined();
    expect(fake.batches).toHaveLength(1);
    const insert = fake.batches[0]!.find((op) => op.op === "insert");
    expect(insert && insert.op === "insert" && insert.value.parentId).toBe("a");
    // Provenance: the resolved harness name is stamped onto the created node, so
    // the editor can mark an agent's edit apart from the user's own (write-once).
    expect(insert && insert.op === "insert" && insert.value.origin).toBe(
      "TestAgent",
    );
    expect(toolText(json)).toContain('Added "new bullet"');
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
    const inserts = fake.batches[0]!.flatMap((op) =>
      op.op === "insert" ? [op.value] : [],
    );
    // 2 roots + 2 grandchildren = 4 fresh nodes, all agent-stamped.
    expect(inserts).toHaveLength(4);
    expect(inserts.every((n) => n.origin === "TestAgent")).toBe(true);
    // The two top-level roots chain, both under a, first after a's existing child.
    const roots = inserts.filter((n) => n.parentId === "a");
    expect(roots).toHaveLength(2);
    expect(roots[0]!.prevSiblingId).toBe("a1");
    expect(roots[1]!.prevSiblingId).toBe(roots[0]!.id);
    // The reply renders the created bullets with their ids.
    expect(toolText(json)).toContain("one-a");
    expect(toolText(json)).toContain("(id:");
  });

  test("add_subtree onto the daily note creates the day and appends the forest", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "add_subtree", {
      date: "2026-07-03",
      nodes: [{ text: "research", children: [{ text: "finding" }] }],
    });
    expect(json.result?.isError).toBeUndefined();
    expect(fake.batches).toHaveLength(1);
    // Daily container + day claimed in the kv index.
    expect(fake.kv.has("container")).toBe(true);
    expect(fake.kv.has("2026-07-03")).toBe(true);
    expect(toolText(json)).toContain("Friday, July 3, 2026");
  });

  test("add_subtree with BOTH parentId and date is a loud isError, nothing written", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "add_subtree", {
      parentId: "a",
      date: "2026-07-03",
      nodes: [{ text: "x" }],
    });
    expect(json.result?.isError).toBe(true);
    expect(toolText(json)).toContain("not both");
    expect(fake.batches).toHaveLength(0);
  });

  test("add_subtree with a missing parent is isError with no write", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "add_subtree", {
      parentId: "ghost",
      nodes: [{ text: "x" }],
    });
    expect(json.result?.isError).toBe(true);
    expect(fake.batches).toHaveLength(0);
  });

  test("add_subtree onto a day with an empty forest fails BEFORE claiming any daily ids", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "add_subtree", {
      date: "2026-07-03",
      nodes: [],
    });
    expect(json.result?.isError).toBe(true);
    expect(fake.batches).toHaveLength(0);
    // The size guard runs before the kv claims, so no orphan container/day
    // mapping is left pointing at nodes that were never inserted (ADR 0028).
    expect(fake.kv.has("container")).toBe(false);
    expect(fake.kv.has("2026-07-03")).toBe(false);
  });

  test("add_subtree publishes its recursive input as a named $def", async () => {
    const { store } = makeStore();
    const json = (await (await rpc(store, "tools/list")).json()) as any;
    const addSubtree = json.result.tools.find(
      (t: any) => t.name === "add_subtree",
    );
    expect(addSubtree.inputSchema.type).toBe("object");
    expect(addSubtree.inputSchema.required).toEqual(["nodes"]);
    // The recursive SubtreeNode shape is emitted as a $def and referenced.
    expect(addSubtree.inputSchema.$defs?.SubtreeNode).toBeDefined();
    expect(JSON.stringify(addSubtree.inputSchema)).toContain(
      "#/$defs/SubtreeNode",
    );
  });

  test("update_node edits fields; delete_node cascades", async () => {
    const fake = makeStore(fixture());
    await callTool(fake.store, "update_node", {
      nodeId: "a1",
      completed: true,
    });
    expect(fake.nodes.get("a1")?.completed).toBe(true);

    const json = await callTool(fake.store, "delete_node", { nodeId: "a" });
    expect(toolText(json)).toContain("Deleted 2 node(s)");
    expect(fake.nodes.has("a")).toBe(false);
    expect(fake.nodes.has("a1")).toBe(false);
    expect(fake.nodes.get("b")?.prevSiblingId).toBeNull();
  });

  test("move_nodes reparents in one atomic batch without recreating nodes", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "move_nodes", {
      nodeIds: ["b"],
      newParentId: "a",
    });
    expect(json.result?.isError).toBeUndefined();
    expect(fake.batches).toHaveLength(1);
    // The id survives — a move is an update, never an insert/delete.
    expect(fake.batches[0]!.every((op) => op.op === "update")).toBe(true);
    expect(fake.nodes.get("b")?.parentId).toBe("a");
    expect(fake.nodes.has("b")).toBe(true);
    expect(toolText(json)).toContain("Moved 1 node(s)");
  });

  test("move_nodes refuses a move into a moved node’s own subtree as isError", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "move_nodes", {
      nodeIds: ["a"],
      newParentId: "a1",
    });
    expect(json.error).toBeUndefined();
    expect(json.result?.isError).toBe(true);
    expect(fake.batches).toHaveLength(0);
    expect(fake.nodes.get("a")?.parentId).toBeNull();
  });

  test("update_node with no fields is a tool error, not a crash", async () => {
    const { store } = makeStore(fixture());
    const json = await callTool(store, "update_node", { nodeId: "a1" });
    expect(json.result?.isError).toBe(true);
    expect(toolText(json)).toContain("nothing to change");
  });

  test("add_to_today creates the Daily container, the day, and the entry on first use", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "add_to_today", {
      text: "captured",
      date: "2026-07-03",
    });
    expect(json.result?.isError).toBeUndefined();
    expect(fake.kv.get("container")).toBeDefined();
    expect(fake.kv.get("2026-07-03")).toBeDefined();
    const containerId = fake.kv.get("container")!.nodeId;
    const dayId = fake.kv.get("2026-07-03")!.nodeId;
    expect(fake.nodes.get(containerId)?.text).toBe("Daily");
    expect(fake.nodes.get(dayId)?.parentId).toBe(containerId);
    const entry = [...fake.nodes.values()].find((n) => n.text === "captured");
    expect(entry?.parentId).toBe(dayId);
    // One structural mutation = ONE batch (ADR 0009).
    expect(fake.batches).toHaveLength(1);
  });

  test("add_to_today reuses an existing day (the kv claim is authoritative)", async () => {
    const fake = makeStore(fixture());
    await callTool(fake.store, "add_to_today", {
      text: "first",
      date: "2026-07-03",
    });
    const dayId = fake.kv.get("2026-07-03")!.nodeId;
    await callTool(fake.store, "add_to_today", {
      text: "second",
      date: "2026-07-03",
    });
    expect(fake.kv.get("2026-07-03")!.nodeId).toBe(dayId);
    const entries = [...fake.nodes.values()].filter(
      (n) => n.parentId === dayId,
    );
    expect(entries.map((n) => n.text).sort()).toEqual(["first", "second"]);
    // "second" chains after "first".
    const second = entries.find((n) => n.text === "second")!;
    const first = entries.find((n) => n.text === "first")!;
    expect(second.prevSiblingId).toBe(first.id);
  });

  test("add_to_today rejects a malformed date", async () => {
    const { store } = makeStore(fixture());
    const json = await callTool(store, "add_to_today", {
      text: "x",
      date: "07/03/2026",
    });
    expect(json.result?.isError).toBe(true);
    expect(toolText(json)).toContain("YYYY-MM-DD");
  });

  test("mirror_node mirrors with a live pointer; mirror cycle is refused", async () => {
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
    expect(toolText(cycle)).toContain("cycle");
  });

  test("mirror_to_today mirrors onto the day note", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "mirror_to_today", {
      nodeId: "a1",
      date: "2026-07-03",
    });
    expect(json.result?.isError).toBeUndefined();
    const dayId = fake.kv.get("2026-07-03")!.nodeId;
    const mirror = [...fake.nodes.values()].find((n) => n.mirrorOf === "a1");
    expect(mirror?.parentId).toBe(dayId);
    expect(toolText(json)).toContain("Friday, July 3, 2026");
  });

  test("the daily container is protected from delete, blanking, and completing", async () => {
    const fake = makeStore(fixture());
    await callTool(fake.store, "add_to_today", {
      text: "x",
      date: "2026-07-03",
    });
    const containerId = fake.kv.get("container")!.nodeId;

    const del = await callTool(fake.store, "delete_node", {
      nodeId: containerId,
    });
    expect(del.result?.isError).toBe(true);
    expect(fake.nodes.has(containerId)).toBe(true);

    const blank = await callTool(fake.store, "update_node", {
      nodeId: containerId,
      text: "  ",
    });
    expect(blank.result?.isError).toBe(true);
    expect(fake.nodes.get(containerId)?.text).toBe("Daily");

    const complete = await callTool(fake.store, "update_node", {
      nodeId: containerId,
      completed: true,
    });
    expect(complete.result?.isError).toBe(true);

    // Collapse is a position-local field and stays allowed.
    const collapse = await callTool(fake.store, "update_node", {
      nodeId: containerId,
      collapsed: true,
    });
    expect(collapse.result?.isError).toBeUndefined();
  });

  test("deleting an ancestor of surviving mirrors is refused (ADR 0022 v1 protects)", async () => {
    const fake = makeStore([
      ...fixture(),
      makeNode({
        id: "m",
        text: "alpha one",
        mirrorOf: "a1",
        prevSiblingId: "b",
      }),
    ]);
    const json = await callTool(fake.store, "delete_node", { nodeId: "a" });
    expect(json.result?.isError).toBe(true);
    expect(toolText(json)).toContain("orphan");
    expect(fake.nodes.has("a")).toBe(true);
  });

  test("a tool-level failure surfaces as isError, never a protocol error", async () => {
    const { store } = makeStore(fixture());
    const json = await callTool(store, "delete_node", { nodeId: "ghost" });
    expect(json.error).toBeUndefined();
    expect(json.result?.isError).toBe(true);
    expect(toolText(json)).toContain("not found");
  });

  test("import_opml lands the forest as ONE atomic batch with origin stamped, and answers with a receipt", async () => {
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
    const inserts = fake.batches[0]!.flatMap((op) =>
      op.op === "insert" ? [op.value] : [],
    );
    // 2 roots + 1 child + 1 note-derived bullet = 4 fresh nodes, all under a,
    // all provenance-stamped.
    expect(inserts).toHaveLength(4);
    expect(inserts.every((n) => n.origin === "TestAgent")).toBe(true);
    const roots = inserts.filter((n) => n.parentId === "a");
    expect(roots.map((n) => n.text)).toEqual(["one", "two"]);
    expect(roots[0]!.prevSiblingId).toBe("a1");
    expect(roots[1]!.prevSiblingId).toBe(roots[0]!.id);
    expect(inserts.find((n) => n.text === "two")?.isTask).toBe(true);
    expect(inserts.find((n) => n.text === "one-a")?.completed).toBe(true);
    // The receipt is compact — root ids + texts, counts, landing spot — never
    // the echoed forest.
    const text = toolText(json);
    expect(text).toContain('Imported 4 node(s) under "alpha" (id: a).');
    expect(text).toContain(`- "one" (id: ${roots[0]!.id})`);
    expect(text).toContain("1 _note attribute(s) -> 1 child bullet(s)");
    expect(text).toContain("No fidelity degradations.");
    expect(text).not.toContain("one-a");
  });

  test("import_opml with BOTH parentId and date is a loud isError, nothing written", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "import_opml", {
      opml: '<opml version="2.0"><body><outline text="x" /></body></opml>',
      parentId: "a",
      date: "2026-07-03",
    });
    expect(json.result?.isError).toBe(true);
    expect(toolText(json)).toContain("not both");
    expect(fake.batches).toHaveLength(0);
  });

  test("import_opml onto a date creates the day and appends; dryRun claims nothing", async () => {
    const fake = makeStore(fixture());
    const opml =
      '<opml version="2.0"><body><outline text="from-agent" /></body></opml>';

    const dry = await callTool(fake.store, "import_opml", {
      opml,
      date: "2026-07-03",
      dryRun: true,
    });
    expect(dry.result?.isError).toBeUndefined();
    expect(toolText(dry)).toContain("Dry run");
    expect(toolText(dry)).toContain("Nothing was written.");
    expect(fake.batches).toHaveLength(0);
    // A dry run must not claim daily-index ids either — a kv claim IS a write.
    expect(fake.kv.has("container")).toBe(false);
    expect(fake.kv.has("2026-07-03")).toBe(false);

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
    expect(toolText(real)).toContain("Friday, July 3, 2026");
  });

  test("import_opml dryRun onto a parent plans the same receipt and commits nothing", async () => {
    const fake = makeStore(fixture());
    const json = await callTool(fake.store, "import_opml", {
      opml: '<opml version="2.0"><body><outline text="x" /></body></opml>',
      parentId: "a",
      dryRun: true,
    });
    expect(json.result?.isError).toBeUndefined();
    expect(toolText(json)).toContain(
      'Dry run — would import 1 node(s) under "alpha" (id: a).',
    );
    expect(fake.batches).toHaveLength(0);
    expect(fake.nodes.size).toBe(3);
  });

  test("import_opml over the 5,000-node ceiling is refused with guidance, nothing written", async () => {
    const fake = makeStore(fixture());
    const opml = `<opml version="2.0"><body>${'<outline text="x" />'.repeat(5001)}</body></opml>`;
    const json = await callTool(fake.store, "import_opml", { opml });
    expect(json.result?.isError).toBe(true);
    expect(toolText(json)).toContain("5001 exceeds the 5000-node ceiling");
    // Reject-with-guidance names the app importer as the migration door.
    expect(toolText(json)).toContain("app's own OPML import");
    expect(fake.batches).toHaveLength(0);
  });

  test("import_opml surfaces a parse error with line/column, and rejects a missing parent", async () => {
    const fake = makeStore(fixture());
    const truncated = await callTool(fake.store, "import_opml", {
      opml: '<opml version="2.0"><body><outline text="x"',
    });
    expect(truncated.result?.isError).toBe(true);
    expect(toolText(truncated)).toMatch(/line \d+, column \d+/);
    expect(fake.batches).toHaveLength(0);

    const ghost = await callTool(fake.store, "import_opml", {
      opml: '<opml version="2.0"><body><outline text="x" /></body></opml>',
      parentId: "ghost",
    });
    expect(ghost.result?.isError).toBe(true);
    expect(toolText(ghost)).toContain("not found");
    expect(fake.batches).toHaveLength(0);
  });

  test("export_opml returns the raw OPML string with no preamble, scoped by nodeId", async () => {
    const { store } = makeStore(fixture());
    const whole = toolText(await callTool(store, "export_opml", {}));
    expect(whole.startsWith('<?xml version="1.0"?>')).toBe(true);
    expect(whole).toContain('<outline text="alpha">');
    expect(whole).toContain('<outline text="bravo" />');

    const scoped = toolText(
      await callTool(store, "export_opml", { nodeId: "a" }),
    );
    // Scope mirrors get_outline: the root is included, siblings are not.
    expect(scoped).toContain('<outline text="alpha">');
    expect(scoped).toContain('<outline text="alpha one" />');
    expect(scoped).not.toContain("bravo");
    expect(scoped).toContain("<title>alpha</title>");
  });

  test("export_opml round-trips through import_opml", async () => {
    const fake = makeStore(fixture());
    const opml = toolText(
      await callTool(fake.store, "export_opml", { nodeId: "a" }),
    );
    const json = await callTool(fake.store, "import_opml", {
      opml,
      parentId: "b",
    });
    expect(json.result?.isError).toBeUndefined();
    const inserts = fake.batches[0]!.flatMap((op) =>
      op.op === "insert" ? [op.value] : [],
    );
    expect(inserts.map((n) => n.text)).toEqual(["alpha", "alpha one"]);
    expect(inserts[1]!.parentId).toBe(inserts[0]!.id);
  });

  test("export_opml over the 5,000-node ceiling rejects, never truncates", async () => {
    const seed: Node[] = [makeNode({ id: "root", text: "root" })];
    let prev: string | null = null;
    for (let i = 0; i < 5001; i++) {
      const id = `c${i}`;
      seed.push(
        makeNode({
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
    expect(toolText(json)).toContain("5002 nodes, over the 5000-node ceiling");
    expect(toolText(json)).toContain("nodeId");

    // Scoping down to a subtree under the ceiling still works.
    const scoped = await callTool(store, "export_opml", { nodeId: "c0" });
    expect(scoped.result?.isError).toBeUndefined();
    expect(toolText(scoped)).toContain('<outline text="child 0" />');
  });

  test("a store fault becomes -32603 without leaking internals", async () => {
    const broken: OutlineStore = {
      getNodes: () => {
        throw new Error("secret D1 connection string");
      },
      applyBatch: () => 0,
      getKv: () => [],
      getOrCreateKv: () => ({}),
    };
    const json = await callTool(broken, "get_outline", {});
    expect(json.error?.code).toBe(-32603);
    expect(JSON.stringify(json)).not.toContain("secret");
  });
});
