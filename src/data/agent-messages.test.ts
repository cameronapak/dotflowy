import { describe, expect, test } from "bun:test";

import type { AgentPrompt } from "./agent-prompt";

import { buildAgentMessages, AGENT_SYSTEM_PROMPT } from "./agent-messages";

describe("buildAgentMessages", () => {
  test("orders prior turns, then question + context (no system role)", () => {
    const prompt: AgentPrompt = {
      question: "@agent what next?",
      turns: [
        { role: "user", text: "@agent prior", nodeId: "q1" },
        { role: "agent", text: "prior answer", nodeId: "a1" },
      ],
      context: "UNTRUSTED CONTEXT:\nBreadcrumb: Home",
    };
    const msgs = buildAgentMessages(prompt);
    expect(msgs.every((m) => m.role !== "system")).toBe(true);
    expect(AGENT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(AGENT_SYSTEM_PROMPT).toContain("Do NOT offer follow-ups");
    expect(AGENT_SYSTEM_PROMPT).toMatch(/You are Dot/);
    expect(AGENT_SYSTEM_PROMPT).toContain("does NOT sync with Notion");
    expect(AGENT_SYSTEM_PROMPT).toContain("web_search");
    expect(AGENT_SYSTEM_PROMPT).toContain("[title](url)");
    expect(AGENT_SYSTEM_PROMPT).toContain("Never invent product capabilities");
    expect(AGENT_SYSTEM_PROMPT).toMatch(/look them up via web_search/);
    expect(msgs[0]).toEqual({ role: "user", content: "@agent prior" });
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: "prior answer",
    });
    expect(msgs[2]?.role).toBe("user");
    expect(msgs[2]?.content).toContain("UNTRUSTED CONTEXT");
    expect(msgs[2]?.content).toContain("QUESTION:");
    expect(msgs[2]?.content).toContain("@agent what next?");
  });
});
