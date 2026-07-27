import { describe, expect, test } from "bun:test";

import {
  AGENT_DENIED_TOOLS,
  AGENT_ALLOWED_TOOLS,
  isAgentToolAllowed,
} from "./agent-tools";

describe("isAgentToolAllowed", () => {
  test("allows the read + additive set", () => {
    for (const name of AGENT_ALLOWED_TOOLS) {
      expect(isAgentToolAllowed(name)).toBe(true);
    }
  });

  test("denies destructive MCP tools", () => {
    for (const name of AGENT_DENIED_TOOLS) {
      expect(isAgentToolAllowed(name)).toBe(false);
    }
  });

  test("denies unknown tool names", () => {
    expect(isAgentToolAllowed("rm_rf")).toBe(false);
    expect(isAgentToolAllowed("")).toBe(false);
  });

  test("allows web_search (Firecrawl; runtime-gated by API key)", () => {
    expect(AGENT_ALLOWED_TOOLS).toContain("web_search");
    expect(isAgentToolAllowed("web_search")).toBe(true);
  });
});
