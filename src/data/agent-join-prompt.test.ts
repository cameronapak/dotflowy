import { describe, expect, test } from "bun:test";

import { buildAgentJoinPrompt } from "./agent-join-prompt";

describe("buildAgentJoinPrompt (ADR 0059)", () => {
  test("includes MCP URL, presence loop, ask poll, and docs placeholder", () => {
    const md = buildAgentJoinPrompt({
      appOrigin: "https://app.dotflowy.com/",
    });
    expect(md).toContain("https://app.dotflowy.com/mcp");
    expect(md).toContain("announce_presence");
    expect(md).toContain("list_asks");
    expect(md).toContain("claim_ask");
    expect(md).toContain("complete_ask");
    expect(md).toContain("questionNodeId");
    expect(md).toContain("children");
    expect(md).toContain("search_nodes");
    expect(md).toContain("https://app.dotflowy.com/agent-docs");
    expect(md).toContain("https://app.dotflowy.com/agent-docs.md");
    expect(md).toContain("20–30 seconds");
  });

  test("custom docs path", () => {
    const md = buildAgentJoinPrompt({
      appOrigin: "http://localhost:3000",
      docsPath: "/docs/agent",
    });
    expect(md).toContain("http://localhost:3000/mcp");
    expect(md).toContain("http://localhost:3000/docs/agent");
  });
});
