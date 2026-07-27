/**
 * AI SDK tool set for the inline agent — allowlisted MCP tool handlers +
 * optional `web_search` (Firecrawl) when `FIRECRAWL_API_KEY` is set.
 */

import { jsonSchema, tool } from "@lunora/ai";
import { Effect, Schema } from "effect";

import { isAgentToolAllowed } from "../src/data/agent-tools";
import { WEB_SEARCH_MAX_PER_RUN } from "../src/data/agent-web-search";
import { tools, type OutlineStore } from "../worker/mcp-tools";
import { firecrawlWebSearchE, WebSearchInputSchema } from "./agent-web-search";

/** Provenance stamp written onto nodes the agent creates via tools. */
export const AGENT_TOOL_ORIGIN = "agent";

type AgentToolOpts = {
  /** Cooperative cancel (ADR 0059) — checked before each tool execute. */
  isCancelled: () => Promise<boolean>;
  /**
   * Firecrawl API key for `web_search`. Absent/empty → tool omitted (fail
   * closed — never invent results).
   */
  firecrawlApiKey?: string;
};

function toJsonSchema(input: Schema.Top): Record<string, unknown> {
  const doc = Schema.toJsonSchemaDocument(input);
  const schema: Record<string, unknown> = { ...doc.schema };
  if (Object.keys(doc.definitions).length > 0) {
    schema["$defs"] = doc.definitions;
  }
  return schema;
}

/** Built with `@lunora/ai`'s `tool` so types match that package's nested `ai`. */
export function buildAgentAiTools(store: OutlineStore, opts: AgentToolOpts) {
  const out: Record<string, object> = {};

  for (const def of tools) {
    if (!isAgentToolAllowed(def.name)) continue;

    const schema = toJsonSchema(def.input);

    out[def.name] = tool({
      description: def.description,
      inputSchema: jsonSchema(schema as never, {
        validate: (value) => {
          try {
            const decoded = Schema.decodeUnknownSync(def.input as never)(value);
            return { success: true as const, value: decoded };
          } catch (err) {
            return {
              success: false as const,
              error: err instanceof Error ? err : new Error(String(err)),
            };
          }
        },
      }),
      execute: async (input: unknown) => {
        if (await opts.isCancelled()) {
          return "Error: run cancelled";
        }
        try {
          return await Effect.runPromise(
            def
              .handle(input, store, AGENT_TOOL_ORIGIN)
              .pipe(
                Effect.catchTag("ToolError", (e) =>
                  Effect.succeed(`Error: ${e.reason}`),
                ),
              ),
          );
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
  }

  const apiKey = opts.firecrawlApiKey?.trim();
  if (apiKey && isAgentToolAllowed("web_search")) {
    let searchesThisRun = 0;
    const schema = toJsonSchema(WebSearchInputSchema);

    out.web_search = tool({
      description:
        "Search the public web for current facts, product docs, or anything outside the user's outline. Returns titles, URLs, and short descriptions. Cite sources in the answer as inline markdown links [title](url). Do not invent results if search fails.",
      inputSchema: jsonSchema(schema as never, {
        validate: (value) => {
          try {
            const decoded =
              Schema.decodeUnknownSync(WebSearchInputSchema)(value);
            return { success: true as const, value: decoded };
          } catch (err) {
            return {
              success: false as const,
              error: err instanceof Error ? err : new Error(String(err)),
            };
          }
        },
      }),
      execute: async (input: unknown) => {
        if (await opts.isCancelled()) {
          return "Error: run cancelled";
        }
        if (searchesThisRun >= WEB_SEARCH_MAX_PER_RUN) {
          return "Error: search unavailable (per-run limit reached)";
        }
        searchesThisRun += 1;
        try {
          const decoded = Schema.decodeUnknownSync(WebSearchInputSchema)(input);
          return await Effect.runPromise(
            firecrawlWebSearchE({
              apiKey,
              query: decoded.query,
              limit: decoded.limit,
            }).pipe(
              Effect.catchTag("FirecrawlSearchError", (e) =>
                Effect.succeed(`Error: search unavailable (${e.reason})`),
              ),
            ),
          );
        } catch (err) {
          return `Error: search unavailable (${err instanceof Error ? err.message : String(err)})`;
        }
      },
    });
  }

  return out;
}
