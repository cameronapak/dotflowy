import { describe, expect, test } from "bun:test";

import { splitAgentAnswer } from "./agent-answer";

describe("splitAgentAnswer", () => {
  test("single line is summary only", () => {
    expect(splitAgentAnswer("Hello")).toEqual({
      summary: "Hello",
      detail: "",
    });
  });

  test("first line summary, rest detail", () => {
    expect(splitAgentAnswer("Summary\n\nMore detail\nline")).toEqual({
      summary: "Summary",
      detail: "More detail\nline",
    });
  });

  test("empty becomes placeholder summary", () => {
    expect(splitAgentAnswer("   ")).toEqual({
      summary: "(no answer)",
      detail: "",
    });
  });

  test("leading blank lines are trimmed before split", () => {
    expect(splitAgentAnswer("\nbody only")).toEqual({
      summary: "body only",
      detail: "",
    });
  });
});
