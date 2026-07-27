import { describe, expect, test } from "bun:test";

import { splitAgentAnswer } from "./agent-answer";

describe("splitAgentAnswer", () => {
  test("single line is summary only", () => {
    expect(splitAgentAnswer("Hello")).toEqual({
      summary: "Hello",
      detail: "",
      detailForest: [],
    });
  });

  test("first line summary, rest as paragraph forest", () => {
    const parts = splitAgentAnswer("Summary\n\nMore detail\nline");
    expect(parts.summary).toBe("Summary");
    expect(parts.detail).toBe("More detail\nline");
    expect(parts.detailForest).toEqual([
      {
        text: "More detail",
        isTask: false,
        completed: false,
        kind: "paragraph",
        children: [],
      },
      {
        text: "line",
        isTask: false,
        completed: false,
        kind: "paragraph",
        children: [],
      },
    ]);
  });

  test("empty becomes placeholder summary", () => {
    expect(splitAgentAnswer("   ")).toEqual({
      summary: "(no answer)",
      detail: "",
      detailForest: [],
    });
  });

  test("leading blank lines are trimmed before split", () => {
    expect(splitAgentAnswer("\nbody only")).toEqual({
      summary: "body only",
      detail: "",
      detailForest: [],
    });
  });

  test("list markers become bullet nodes; bare lines become paragraphs", () => {
    const parts = splitAgentAnswer(
      [
        "I can help you with:",
        "",
        "- **Outline Management**: nest bullets",
        "- **Add Content**: paste markdown",
        "",
        "Would you like me to continue?",
      ].join("\n"),
    );
    expect(parts.summary).toBe("I can help you with:");
    expect(parts.detailForest).toEqual([
      {
        text: "**Outline Management**: nest bullets",
        isTask: false,
        completed: false,
        kind: null,
        children: [],
      },
      {
        text: "**Add Content**: paste markdown",
        isTask: false,
        completed: false,
        kind: null,
        children: [],
      },
      {
        text: "Would you like me to continue?",
        isTask: false,
        completed: false,
        kind: "paragraph",
        children: [],
      },
    ]);
  });

  test("nested list indentation is preserved", () => {
    const parts = splitAgentAnswer("Parent\n- a\n  - b\n- c");
    expect(parts.detailForest).toEqual([
      {
        text: "a",
        isTask: false,
        completed: false,
        kind: null,
        children: [
          {
            text: "b",
            isTask: false,
            completed: false,
            kind: null,
            children: [],
          },
        ],
      },
      {
        text: "c",
        isTask: false,
        completed: false,
        kind: null,
        children: [],
      },
    ]);
  });

  test("emphasis markers stay in text (not stripped)", () => {
    const parts = splitAgentAnswer("Sum\n- **bold** and *italic*");
    expect(parts.detailForest[0]?.text).toBe("**bold** and *italic*");
  });

  test("task checkboxes become task nodes", () => {
    const parts = splitAgentAnswer("Sum\n- [ ] open\n- [x] done");
    expect(parts.detailForest).toEqual([
      {
        text: "open",
        isTask: true,
        completed: false,
        kind: null,
        children: [],
      },
      {
        text: "done",
        isTask: true,
        completed: true,
        kind: null,
        children: [],
      },
    ]);
  });
});
