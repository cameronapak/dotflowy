import { describe, expect, test } from "bun:test";

import { resolveHarnessMark } from "./harness";

describe("resolveHarnessMark", () => {
  test("Dot origins", () => {
    expect(resolveHarnessMark("agent")).toEqual({
      kind: "dot",
      displayName: "Dot",
    });
    expect(resolveHarnessMark("dot")).toEqual({
      kind: "dot",
      displayName: "Dot",
    });
  });

  test("ChatGPT / OpenAI → Blossom + ChatGPT label", () => {
    expect(resolveHarnessMark("ChatGPT")).toEqual({
      kind: "chatgpt",
      displayName: "ChatGPT",
    });
    expect(resolveHarnessMark("openai-mcp")).toEqual({
      kind: "chatgpt",
      displayName: "ChatGPT",
    });
  });

  test("Claude / Cursor → sparkle with clean display names", () => {
    expect(resolveHarnessMark("Claude")).toEqual({
      kind: "sparkle",
      displayName: "Claude",
    });
    expect(resolveHarnessMark("anthropic-desktop")).toEqual({
      kind: "sparkle",
      displayName: "Claude",
    });
    expect(resolveHarnessMark("Cursor")).toEqual({
      kind: "sparkle",
      displayName: "Cursor",
    });
  });

  test("unknown keeps origin text + sparkle", () => {
    expect(resolveHarnessMark("WeirdClient")).toEqual({
      kind: "sparkle",
      displayName: "WeirdClient",
    });
  });
});
