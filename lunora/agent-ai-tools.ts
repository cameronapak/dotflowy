/**
 * AI SDK tool set for the inline agent — allowlisted MCP tool handlers only.
 */

import { jsonSchema, tool } from "@lunora/ai";
import { Effect, Schema } from "effect";

import { isAgentToolAllowed } from "../src/data/agent-tools";
import { tools, type OutlineStore } from "../worker/mcp-tools";

/** Provenance stamp written onto nodes the agent creates via tools. */
export const AGENT_TOOL_ORIGIN = "agent";

type AgentToolOpts = {
  /** Cooperative cancel (ADR 0059) — checked before each tool execute. */
  isCancelled: () => Promise<boolean>;
};

/** Built with `@lunora/ai`'s `tool` so types match that package's nested `ai`. */
export function buildAgentAiTools(store: OutlineStore, opts: AgentToolOpts) {
  const out: Record<string, object> = {};

  for (const def of tools) {
    if (!isAgentToolAllowed(def.name)) continue;

    const doc = Schema.toJsonSchemaDocument(def.input);
    const schema: Record<string, unknown> = { ...doc.schema };
    if (Object.keys(doc.definitions).length > 0) {
      schema["$defs"] = doc.definitions;
    }

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

  return out;
}
