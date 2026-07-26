import { describe, expect, test } from "bun:test";

import { buildAgentPrompt } from "./agent-prompt";
import { buildTreeIndex, makeNode } from "./tree";

describe("buildAgentPrompt", () => {
  test("pairs prior @agent siblings with their answer subtrees as turns", () => {
    const parent = makeNode({ id: "p", text: "Week rules research" });
    const q1 = makeNode({
      id: "q1",
      parentId: "p",
      text: "@agent what's the ISO week rule?",
    });
    const a1 = makeNode({
      id: "a1",
      parentId: "q1",
      text: "ISO weeks start Monday.",
      origin: "agent",
    });
    const d1 = makeNode({
      id: "d1",
      parentId: "a1",
      text: "Thursday decides the month.",
      origin: "agent",
      collapsed: true,
    });
    const other = makeNode({
      id: "note",
      parentId: "p",
      prevSiblingId: "q1",
      text: "unrelated note",
    });
    const q2 = makeNode({
      id: "q2",
      parentId: "p",
      prevSiblingId: "note",
      text: "@agent so which month owns it?",
    });
    const index = buildTreeIndex([parent, q1, a1, d1, other, q2]);

    const prompt = buildAgentPrompt(index, "q2");
    expect(prompt.turns).toEqual([
      {
        role: "user",
        text: "@agent what's the ISO week rule?",
        nodeId: "q1",
      },
      {
        role: "agent",
        text: "ISO weeks start Monday.\n  Thursday decides the month.",
        nodeId: "a1",
      },
    ]);
    // Unrelated sibling is context, not a fake user turn.
    expect(prompt.turns.some((t) => t.text.includes("unrelated"))).toBe(false);
    expect(prompt.context).toContain("unrelated note");
    expect(prompt.context).toContain("UNTRUSTED CONTEXT");
    expect(prompt.question).toBe("@agent so which month owns it?");
  });

  test("omits missing answer as an agent turn", () => {
    const parent = makeNode({ id: "p", text: "Research" });
    const q1 = makeNode({
      id: "q1",
      parentId: "p",
      text: "@agent unfinished",
    });
    const q2 = makeNode({
      id: "q2",
      parentId: "p",
      prevSiblingId: "q1",
      text: "@agent follow up",
    });
    const index = buildTreeIndex([parent, q1, q2]);
    const prompt = buildAgentPrompt(index, "q2");
    expect(prompt.turns).toEqual([
      { role: "user", text: "@agent unfinished", nodeId: "q1" },
    ]);
  });
});
