import { describe, expect, test } from "bun:test";

import type { AgentPrompt } from "./agent-prompt";

import { buildAgentMessages, AGENT_SYSTEM_PROMPT } from "./agent-messages";

describe("buildAgentMessages", () => {
  test("orders system, prior turns, then question + context", () => {
    const prompt: AgentPrompt = {
      question: "@agent what next?",
      turns: [
        { role: "user", text: "@agent prior", nodeId: "q1" },
        { role: "agent", text: "prior answer", nodeId: "a1" },
      ],
      context: "UNTRUSTED CONTEXT:\nBreadcrumb: Home",
    };
    const msgs = buildAgentMessages(prompt);
    expect(msgs[0]).toEqual({
      role: "system",
      content: AGENT_SYSTEM_PROMPT,
    });
    expect(msgs[1]).toEqual({ role: "user", content: "@agent prior" });
    expect(msgs[2]).toEqual({
      role: "assistant",
      content: "prior answer",
    });
    expect(msgs[3]?.role).toBe("user");
    expect(msgs[3]?.content).toContain("UNTRUSTED CONTEXT");
    expect(msgs[3]?.content).toContain("QUESTION:");
    expect(msgs[3]?.content).toContain("@agent what next?");
  });
});
