import { expect, test } from "bun:test";
import { Effect } from "effect";
import { resolve } from "node:path";

import type { JsonObject } from "../src/core.js";

import { connect, rpc } from "../src/mcp.js";

const executable = resolve(import.meta.dir, "../dist/main.js");
const cli = async (
  server: string,
  args: string[],
  input?: string,
  token = "test-token",
) => {
  const child = Bun.spawn(["node", executable, "--server", server, ...args], {
    env: { ...process.env, DOTFLOWY_TOKEN: token, NO_COLOR: "1" },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

test("Node executable supports JSON/stdin, future tools, and distinct refusal/plan exit codes", async () => {
  let calls = 0;
  let received: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const authorization = request.headers.get("authorization");
      expect(authorization?.startsWith("Bearer ")).toBe(true);
      const token = authorization?.slice("Bearer ".length) ?? "missing";
      const body = await request.json();
      const result = (value: JsonObject) =>
        Response.json({ jsonrpc: "2.0", id: body.id, result: value });
      if (body.method === "initialize")
        return result({
          protocolVersion: "2025-06-18",
          serverInfo: { name: "fixture" },
        });
      if (body.method === "tools/list")
        return result({
          tools: [
            "future_tool",
            "delete_node",
            "refuse",
            "plan",
            "add_node",
          ].map((name) => ({ name, inputSchema: { type: "object" } })),
        });
      calls++;
      received = body.params.arguments;
      if (body.params.name === "refuse")
        return result({
          content: [
            {
              type: "text",
              text: `Rejected bearer ${token} and "${token}"`,
            },
          ],
          structuredContent: {
            authorization: `Bearer ${token}`,
            [token]: "must redact keys too",
            expiresAt: 1234,
            nested: [
              null,
              false,
              17,
              { text: `secret ${token}` },
              [`Bearer ${token}`],
            ],
          },
          isError: true,
        });
      if (body.params.name === "plan")
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32001, message: "Paid plan required" },
        });
      return result({
        content: [{ type: "text", text: "created" }],
        structuredContent: { id: "future-id" },
        extra: "preserved",
      });
    },
  });
  try {
    const args = { nested: [null, false, { text: "hello" }] };
    const result = await cli(
      server.url.origin,
      ["call", "future_tool", "--input", "-", "--json"],
      JSON.stringify(args),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(received).toEqual(args);
    expect(JSON.parse(result.stdout)).toEqual({
      content: [{ type: "text", text: "created" }],
      structuredContent: { id: "future-id" },
      extra: "preserved",
    });
    for (const args of [
      ["delete", "node"],
      ["call", "delete_node", "--args", '{"nodeId":"node"}'],
    ]) {
      const rejected = await cli(server.url.origin, args);
      expect(rejected.code).toBe(2);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain("--yes");
    }
    expect(calls).toBe(1);
    expect(
      (await cli(server.url.origin, ["delete", "node", "--yes"])).code,
    ).toBe(0);
    const refused = await cli(server.url.origin, ["call", "refuse", "--json"]);
    expect(refused.code).toBe(4);
    expect(refused.stdout).not.toContain("test-token");
    expect(JSON.parse(refused.stdout)).toEqual({
      content: [
        {
          type: "text",
          text: 'Rejected bearer [redacted] and "[redacted]"',
        },
      ],
      structuredContent: {
        authorization: "Bearer [redacted]",
        "[redacted]": "must redact keys too",
        expiresAt: 1234,
        nested: [
          null,
          false,
          17,
          { text: "secret [redacted]" },
          ["Bearer [redacted]"],
        ],
      },
      isError: true,
    });
    const numericRefusal = await cli(
      server.url.origin,
      ["call", "refuse", "--json"],
      undefined,
      "123",
    );
    expect(numericRefusal.code).toBe(4);
    expect(numericRefusal.stdout).not.toContain('"123"');
    expect(JSON.parse(numericRefusal.stdout)).toEqual({
      content: [
        {
          type: "text",
          text: 'Rejected bearer [redacted] and "[redacted]"',
        },
      ],
      structuredContent: {
        authorization: "Bearer [redacted]",
        "[redacted]": "must redact keys too",
        expiresAt: 1234,
        nested: [
          null,
          false,
          17,
          { text: "secret [redacted]" },
          ["Bearer [redacted]"],
        ],
      },
      isError: true,
    });
    const plan = await cli(server.url.origin, ["call", "plan", "--json"]);
    expect(plan.code).toBe(5);
    expect(plan.stdout).toBe("");
    expect(JSON.parse(plan.stderr).error.exitCode).toBe(5);
    const invalid = await cli(server.url.origin, ["add", "a", "b", "--json"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(
      (await cli(server.url.origin, ["add", "--text-file", "-"], "α\nbeta"))
        .code,
    ).toBe(0);
    expect(received).toEqual({ text: "α\nbeta" });
  } finally {
    server.stop(true);
  }
}, 30_000);

test("failed writes are never retried and redirects never receive bearer credentials", async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response("bad", { status: 503 });
    },
  });
  try {
    await expect(
      Effect.runPromise(
        rpc(server.url.origin, "test-token", "tools/call", {}, undefined, true),
      ),
    ).rejects.toThrow("unknown");
    expect(requests).toBe(1);
  } finally {
    server.stop(true);
  }
  let leaked = 0;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      leaked++;
      return Response.json({});
    },
  });
  const redirect = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.redirect(target.url.href, 307);
    },
  });
  try {
    await expect(
      Effect.runPromise(
        rpc(redirect.url.origin, "test-token", "tools/list", {}),
      ),
    ).rejects.toThrow();
    expect(leaked).toBe(0);
  } finally {
    target.stop(true);
    redirect.stop(true);
  }
});

test("validates response IDs and paginates tool discovery", async () => {
  let pages = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      const envelope = (result: JsonObject) =>
        Response.json({ jsonrpc: "2.0", id: body.id, result });
      if (body.method === "initialize")
        return envelope({ protocolVersion: "2025-06-18", serverInfo: {} });
      if (body.method === "tools/list") {
        pages++;
        const result: JsonObject = {
          tools: [{ name: `tool${pages}`, inputSchema: {} }],
        };
        if (pages === 1) result.nextCursor = "second";
        return envelope(result);
      }
      return Response.json({ jsonrpc: "2.0", id: "wrong", result: {} });
    },
  });
  try {
    const client = await Effect.runPromise(
      connect(server.url.origin, "test-token"),
    );
    expect((await Effect.runPromise(client.list())).map((t) => t.name)).toEqual(
      ["tool1", "tool2"],
    );
    await expect(
      Effect.runPromise(client.invoke("tool1", {}, false)),
    ).rejects.toThrow("envelope");
    await expect(
      Effect.runPromise(client.invoke("tool1", {}, true)),
    ).rejects.toThrow("outcome may be unknown");
  } finally {
    server.stop(true);
  }
});

test("search --all validates and buffers real pages while raw search stays single-page", async () => {
  type Mode =
    | "success"
    | "empty"
    | "stale"
    | "malformed"
    | "repeat"
    | "duplicate";
  let mode: Mode = "success";
  const searchCalls: JsonObject[] = [];
  const node = (id: string) => ({
    id,
    text: `text ${id}`,
    kind: null,
    isTask: false,
    completed: false,
    mirrorOf: null,
    path: ["Root", `text ${id}`],
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      const result = (value: JsonObject) =>
        Response.json({ jsonrpc: "2.0", id: body.id, result: value });
      if (body.method === "initialize")
        return result({ protocolVersion: "2025-06-18", serverInfo: {} });
      if (body.method === "tools/list")
        return result({
          tools: [
            {
              name: "search_nodes",
              inputSchema: {},
              annotations: { readOnlyHint: true },
            },
          ],
        });
      const args: JsonObject = body.params.arguments;
      searchCalls.push(args);
      if (mode === "empty")
        return result({
          content: [{ type: "text", text: 'No nodes match "project".' }],
          structuredContent: { nodes: [], nextCursor: null },
        });
      if (args.cursor === undefined)
        return result({
          content: [
            { type: "text", text: "first body" },
            { type: "text", text: "Continue with cursor second" },
          ],
          structuredContent: { nodes: [node("a")], nextCursor: "second" },
        });
      if (mode === "stale")
        return result({
          content: [
            {
              type: "text",
              text: "Search changed. Restart without the cursor. test-token",
            },
          ],
          isError: true,
        });
      if (mode === "malformed")
        return result({
          content: [{ type: "text", text: "bad" }],
          structuredContent: { nodes: [{ id: "b" }], nextCursor: null },
        });
      return result({
        content: [{ type: "text", text: "second body" }],
        structuredContent: {
          nodes: [node(mode === "duplicate" ? "a" : "b")],
          nextCursor: mode === "repeat" ? "second" : null,
        },
      });
    },
  });
  try {
    const success = await cli(server.url.origin, [
      "search",
      "project",
      "--node",
      "root",
      "--limit",
      "1",
      "--all",
      "--json",
    ]);
    expect(success.code).toBe(0);
    expect(success.stderr).toBe("");
    expect(JSON.parse(success.stdout)).toEqual({
      content: [{ type: "text", text: "first body\nsecond body" }],
      structuredContent: { nodes: [node("a"), node("b")], nextCursor: null },
    });
    expect(searchCalls).toEqual([
      { query: "project", nodeId: "root", limit: 1 },
      { query: "project", nodeId: "root", limit: 1, cursor: "second" },
    ]);

    searchCalls.length = 0;
    const raw = await cli(server.url.origin, [
      "call",
      "search_nodes",
      "--args",
      '{"query":"project"}',
      "--json",
    ]);
    expect(raw.code).toBe(0);
    expect(searchCalls).toHaveLength(1);
    expect(JSON.parse(raw.stdout).structuredContent.nextCursor).toBe("second");

    mode = "empty";
    const empty = await cli(server.url.origin, ["search", "project", "--all"]);
    expect(empty.code).toBe(0);
    expect(empty.stdout.trim()).toBe('No nodes match "project".');

    for (const [failureMode, message] of [
      ["stale", "Restart without the cursor."],
      ["malformed", "Invalid search page"],
      ["repeat", "repeated a search cursor"],
      ["duplicate", "duplicate search node"],
    ] as const) {
      mode = failureMode;
      searchCalls.length = 0;
      const failed = await cli(server.url.origin, [
        "search",
        "project",
        "--all",
      ]);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).toContain(message);
      expect(failed.stderr).not.toContain("test-token");
      expect(searchCalls).toHaveLength(2);
    }
  } finally {
    server.stop(true);
  }
}, 30_000);
