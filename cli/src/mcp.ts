import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";

import { decode, fail, JsonObject, VERSION } from "./core.js";
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
