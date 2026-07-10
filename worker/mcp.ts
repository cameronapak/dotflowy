/**
 * The MCP endpoint: Model Context Protocol over stateless Streamable HTTP.
 *
 * Deliberately hand-rolled as one Effect pipeline instead of Effect's own
 * `McpServer.layerHttp` or the official SDK: both keep per-client session state
 * in isolate memory, and Workers isolates are neither long-lived nor sticky —
 * a follow-up POST can land on a fresh isolate and find no session. So this
 * server is STATELESS by design (the spec's no-session mode): every POST is
 * self-contained, `initialize` returns no `Mcp-Session-Id`, GET streams are
 * declined with 405. All state lives where it already lives — the per-user DO.
 * See docs/adr/0026-agent-native-mcp-server.md.
 *
 * The protocol surface is small on purpose: initialize / ping / tools. Tool
 * input schemas are DERIVED from the registry's Effect Schemas
 * (`Schema.toJsonSchemaDocument`), so the contract `tools/list` publishes and
 * the validator `tools/call` enforces are the same value (ADR 0014's rule).
 * JSON-RPC-level failures (parse, bad request, unknown method/tool, bad args)
 * map to typed error responses; tool-level refusals surface as `isError` tool
 * results; unexpected defects (DO faults) collapse to -32603 without leaking.
 */

import { Effect, Schema } from "effect";

import { type OutlineStore, tools } from "./mcp-tools";
import { APP_VERSION } from "./version";

// --- Protocol constants -------------------------------------------------------

/** Spec revisions this server speaks. `initialize` echoes the client's version
 *  when supported and counter-offers the newest otherwise. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";

/** `version` is informational: MCP clients negotiate `protocolVersion` (the spec
 *  date, above) and never pin a server version. It still has to be TRUE — read
 *  from package.json, not typed here (ADR 0046). */
const SERVER_INFO = {
  name: "dotflowy",
  title: "Dotflowy",
  version: APP_VERSION,
};

const SERVER_INSTRUCTIONS =
  'Dotflowy is the user\'s personal outline (nested bullets; some are to-dos; daily notes live under a "Daily" container). ' +
  "Read with get_outline / search_nodes — every line carries the node id the write tools need. " +
  "add_to_today and mirror_to_today are the fastest ways to put something on the user's daily note; pass the user's local date when you know it.";

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// --- Wire schemas (the /api/mcp trust boundary) --------------------------------

const JsonRpcIdSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Null,
]);
type JsonRpcId = Schema.Schema.Type<typeof JsonRpcIdSchema>;

const JsonRpcMessageSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  // Absent id = a notification (no response expected).
  id: Schema.optional(JsonRpcIdSchema),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});

const InitializeParamsSchema = Schema.Struct({
  protocolVersion: Schema.optional(Schema.String),
});

const CallToolParamsSchema = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Unknown),
});

// --- Response builders ----------------------------------------------------------

/** CORS for browser-based MCP clients (e.g. the inspector). Safe to be open:
 *  the endpoint is bearer-token gated, never cookie-authenticated. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, mcp-protocol-version, mcp-session-id",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

/** A notification was accepted; there is nothing to say back. */
function accepted(): Response {
  return new Response(null, { status: 202, headers: CORS_HEADERS });
}

/** The CORS preflight response — storeless, so worker/index.ts can answer the
 *  pre-auth OPTIONS on /mcp without fabricating an outline store. */
export function mcpCorsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// --- tools/list ------------------------------------------------------------------
// Computed once at module load: the registry is static, and deriving the JSON
// Schema from each tool's Effect Schema here guarantees the published contract
// can't drift from the decoder used in tools/call below.

const toolList = tools.map((tool) => {
  const doc = Schema.toJsonSchemaDocument(tool.input);
  const inputSchema: Record<string, unknown> = { ...doc.schema };
  if (Object.keys(doc.definitions).length)
    inputSchema["$defs"] = doc.definitions;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    annotations: { readOnlyHint: tool.readOnly },
  };
});

// --- Dispatch --------------------------------------------------------------------

const decodeOrNull = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  schema: S,
  value: unknown,
): S["Type"] | null => {
  const result = Schema.decodeUnknownOption(schema)(value);
  return result._tag === "Some" ? result.value : null;
};

function handleInitialize(id: JsonRpcId, params: unknown): Response {
  const parsed = decodeOrNull(InitializeParamsSchema, params ?? {});
  const requested = parsed?.protocolVersion;
  const protocolVersion =
    requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
  return rpcResult(id, {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS,
  });
}

function handleToolCall(
  id: JsonRpcId,
  params: unknown,
  store: OutlineStore,
  origin: string | null,
): Effect.Effect<Response> {
  const call = decodeOrNull(CallToolParamsSchema, params);
  if (!call) {
    return Effect.succeed(
      rpcError(id, INVALID_PARAMS, "expected params {name, arguments}"),
    );
  }
  const tool = tools.find((t) => t.name === call.name);
  if (!tool)
    return Effect.succeed(
      rpcError(id, INVALID_PARAMS, `unknown tool: ${call.name}`),
    );

  // The registry erases each tool's input type (`Schema.Struct<any>`), which
  // would leak `any` into the Effect requirements channel — pin the decode
  // signature at this one seam instead.
  const decodeInput = Schema.decodeUnknownEffect(tool.input) as unknown as (
    input: unknown,
  ) => Effect.Effect<unknown, { readonly message: string }>;
  return decodeInput(call.arguments ?? {}).pipe(
    Effect.mapError((issue) => rpcError(id, INVALID_PARAMS, issue.message)),
    Effect.flatMap((input) =>
      tool.handle(input, store, origin).pipe(
        Effect.map((text) =>
          rpcResult(id, { content: [{ type: "text", text }] }),
        ),
        Effect.catchTag("ToolError", (e) =>
          Effect.succeed(
            rpcResult(id, {
              content: [{ type: "text", text: `Error: ${e.reason}` }],
              isError: true,
            }),
          ),
        ),
      ),
    ),
    // The typed channel above only ever carries the already-built INVALID_PARAMS
    // response; fold it back into the success track.
    Effect.catch((response) => Effect.succeed(response)),
    // A defect here is an unexpected DO/runtime fault — answer inside the
    // protocol (the client can't use an HTTP 500) without leaking internals.
    Effect.catchDefect(() =>
      Effect.succeed(rpcError(id, INTERNAL_ERROR, "internal error")),
    ),
  );
}

function dispatch(
  message: typeof JsonRpcMessageSchema.Type,
  store: OutlineStore,
  origin: string | null,
): Effect.Effect<Response> {
  // A notification (no id) never gets a JSON-RPC response body, whatever the
  // method — `notifications/initialized` and friends land here.
  if (message.id === undefined) return Effect.succeed(accepted());
  const id = message.id;

  switch (message.method) {
    case "initialize":
      return Effect.succeed(handleInitialize(id, message.params));
    case "ping":
      return Effect.succeed(rpcResult(id, {}));
    case "tools/list":
      return Effect.succeed(rpcResult(id, { tools: toolList }));
    case "tools/call":
      return handleToolCall(id, message.params, store, origin);
    default:
      return Effect.succeed(
        rpcError(id, METHOD_NOT_FOUND, `method not found: ${message.method}`),
      );
  }
}

// --- HTTP surface ------------------------------------------------------------------

/**
 * Handle one HTTP exchange on /mcp (or its /api/mcp alias) for an already-authenticated user.
 * Total: every failure mode becomes a well-formed HTTP/JSON-RPC response, so
 * the caller (worker/index.ts) can treat this as infallible routing.
 *
 * `origin` is the caller's provenance stamp — the resolved harness name of the
 * OAuth client behind the bearer token (worker/index.ts), written onto every
 * node a write tool creates. Null when it can't be resolved (falls back to a
 * generic marker there).
 */
export function handleMcp(
  request: Request,
  store: OutlineStore,
  origin: string | null,
): Effect.Effect<Response> {
  switch (request.method) {
    case "OPTIONS":
      return Effect.succeed(mcpCorsPreflight());
    case "POST":
      break;
    default:
      // Stateless mode: no server-initiated SSE stream (GET) and no session to
      // end (DELETE). 405 tells a spec-compliant client to carry on with POSTs.
      return Effect.succeed(
        new Response(JSON.stringify({ error: "method not allowed" }), {
          status: 405,
          headers: {
            "content-type": "application/json",
            allow: "POST, OPTIONS",
            ...CORS_HEADERS,
          },
        }),
      );
  }

  return Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => rpcError(null, PARSE_ERROR, "malformed JSON body"),
    });
    if (Array.isArray(raw)) {
      // JSON-RPC batching was removed in the 2025-06-18 MCP revision; keep the
      // surface single-message.
      return yield* Effect.fail(
        rpcError(null, INVALID_REQUEST, "batch requests are not supported"),
      );
    }
    const message = yield* Schema.decodeUnknownEffect(JsonRpcMessageSchema)(
      raw,
    ).pipe(
      Effect.mapError((issue) =>
        rpcError(null, INVALID_REQUEST, issue.message),
      ),
    );
    return yield* dispatch(message, store, origin);
  }).pipe(
    // The typed error channel only ever carries already-built error Responses.
    Effect.catch((response) => Effect.succeed(response)),
    // Honor the "total routing" contract: an unexpected defect outside
    // handleToolCall (which self-guards) still answers inside the protocol
    // rather than escaping as an HTTP 500 the client can't parse.
    Effect.catchDefect(() =>
      Effect.succeed(rpcError(null, INTERNAL_ERROR, "internal error")),
    ),
  );
}
