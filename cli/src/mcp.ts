import { Effect, Predicate, Schema } from "effect";
import { randomUUID } from "node:crypto";

import { CliError, decode, fail, JsonObject, VERSION } from "./core.js";
import { requestJson } from "./http.js";

const Envelope = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.String,
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(
    Schema.Struct({ code: Schema.Number, message: Schema.String }),
  ),
});
const Descriptor = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  inputSchema: JsonObject,
  annotations: Schema.optionalKey(
    Schema.Struct({
      readOnlyHint: Schema.optionalKey(Schema.Boolean),
      destructiveHint: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type Descriptor = typeof Descriptor.Type;
const ToolList = Schema.Struct({
  tools: Schema.Array(Descriptor),
  nextCursor: Schema.optionalKey(Schema.String),
});
const ToolResult = Schema.Struct({
  content: Schema.Array(JsonObject),
  isError: Schema.optionalKey(Schema.Boolean),
});
const SearchNode = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  kind: Schema.NullOr(Schema.Literal("paragraph")),
  isTask: Schema.Boolean,
  completed: Schema.Boolean,
  mirrorOf: Schema.NullOr(Schema.String),
  path: Schema.Array(Schema.String),
});
const SearchPage = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  ),
  structuredContent: Schema.Struct({
    nodes: Schema.Array(SearchNode),
    nextCursor: Schema.NullOr(Schema.String),
  }),
  isError: Schema.optionalKey(Schema.Boolean),
});
const Initialize = Schema.Struct({
  protocolVersion: Schema.String,
  serverInfo: JsonObject,
});
const versions = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const rpc = Effect.fn("MCP.rpc")(function* (
  server: string,
  token: string,
  method: string,
  params: JsonObject,
  version = "2025-06-18",
  uncertainWrite = false,
) {
  const id = randomUUID();
  const raw = yield* requestJson(`${server}/mcp`, {
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    headers: {
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": version,
    },
    uncertainWrite,
  });
  const envelope = yield* decode(Envelope, raw, "MCP response");
  if (
    envelope.id !== id ||
    (envelope.result === undefined) === (envelope.error === undefined)
  ) {
    return yield* Effect.fail(fail("Invalid MCP response envelope."));
  }
  if (envelope.error)
    return yield* Effect.fail(
      fail(
        envelope.error.message.split(token).join("[redacted]"),
        envelope.error.code === -32001 ? 5 : 1,
      ),
    );
  return yield* decode(JsonObject, envelope.result, "MCP result");
});

export const connect = Effect.fn("MCP.connect")(function* (
  server: string,
  token: string,
) {
  const initialized = yield* decode(
    Initialize,
    yield* rpc(server, token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "Dotflowy CLI", version: VERSION },
    }),
    "MCP initialization",
  );
  if (!versions.includes(initialized.protocolVersion))
    return yield* Effect.fail(
      fail("Unsupported MCP protocol. Update the CLI."),
    );
  const call = (method: string, params: JsonObject, write = false) =>
    rpc(server, token, method, params, initialized.protocolVersion, write);
  return {
    serverInfo: initialized.serverInfo,
    list: () =>
      Effect.gen(function* () {
        const tools: Descriptor[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = yield* decode(
            ToolList,
            yield* call("tools/list", cursor ? { cursor } : {}),
            "tool list",
          );
          tools.push(...page.tools);
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor))
            return yield* Effect.fail(
              fail("Server repeated a tool-list cursor."),
            );
          if (cursor) cursors.add(cursor);
          if (cursors.size > 100)
            return yield* Effect.fail(fail("Too many tool-list pages."));
        } while (cursor);
        return tools;
      }),
    invoke: (name: string, args: JsonObject, write: boolean) =>
      Effect.gen(function* () {
        const raw = yield* call("tools/call", { name, arguments: args }, write);
        const checked = yield* decode(ToolResult, raw, "tool result");
        return {
          raw,
          isError: checked.isError === true,
          content: checked.content,
        };
      }).pipe(
        Effect.mapError((error) =>
          write && error.exitCode === 1 && !error.message.includes("unknown")
            ? fail(
                `${error.message} Write outcome may be unknown; inspect the outline before retrying. Nothing was retried.`,
              )
            : error,
        ),
      ),
  };
});

type Invoke = (
  name: string,
  args: JsonObject,
  write: boolean,
) => Effect.Effect<
  { raw: JsonObject; isError: boolean; content: ReadonlyArray<JsonObject> },
  CliError
>;

export const invokeAllSearch = Effect.fn("MCP.invokeAllSearch")(function* (
  invoke: Invoke,
  args: JsonObject,
) {
  const nodes: Array<typeof SearchNode.Type> = [];
  const bodies: string[] = [];
  const nodeIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const pageArgs: JsonObject = { ...args };
    if (cursor !== null) pageArgs.cursor = cursor;
    const result = yield* invoke("search_nodes", pageArgs, false);
    if (result.isError) {
      const reason = result.content
        .map((block) => (Predicate.isString(block.text) ? block.text : ""))
        .filter(Boolean)
        .join("\n");
      return yield* Effect.fail(
        fail(`Search failed before all pages were read. ${reason}`),
      );
    }
    const page = yield* decode(SearchPage, result.raw, "search page");
    const body = page.content[0];
    if (body === undefined)
      return yield* Effect.fail(fail("Invalid search page."));
    bodies.push(body.text);
    for (const node of page.structuredContent.nodes) {
      if (nodeIds.has(node.id))
        return yield* Effect.fail(
          fail("Server returned a duplicate search node."),
        );
      nodeIds.add(node.id);
      nodes.push(node);
    }
    cursor = page.structuredContent.nextCursor;
    if (cursor !== null) {
      if (cursors.has(cursor))
        return yield* Effect.fail(fail("Server repeated a search cursor."));
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return {
    content: [{ type: "text", text: bodies.join("\n") }],
    structuredContent: { nodes, nextCursor: null },
  };
});
