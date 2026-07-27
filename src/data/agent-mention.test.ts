import { describe, expect, test } from "bun:test";

import {
  AGENT_MENTION,
  hasAgentMention,
  isAiNode,
  parseAgentMentions,
} from "./agent-mention";
import { makeNode } from "./tree";

const matches = (text: string): string[] =>
  [...text.matchAll(new RegExp(AGENT_MENTION, "gu"))].map((m) => m[0]);

describe("AGENT_MENTION", () => {
  test("matches a bare @agent at start", () => {
    expect(matches("@agent what's the ISO week?")).toEqual(["@agent"]);
  });

  test("matches @dot interchangeably", () => {
    expect(matches("@dot what's the ISO week?")).toEqual(["@dot"]);
    expect(matches("ask @dot about weeks")).toEqual(["@dot"]);
  });

  test("matches after whitespace", () => {
    expect(matches("ask @agent about weeks")).toEqual(["@agent"]);
  });

  test("does not match mid-word, @agency, or @dotted", () => {
    expect(matches("email@agent.com")).toEqual([]);
    expect(matches("@agency research")).toEqual([]);
    expect(matches("x@agent")).toEqual([]);
    expect(matches("@dotted path")).toEqual([]);
    expect(matches("x@dot")).toEqual([]);
  });

  test("does not match @Agent / @Dot case variants", () => {
    expect(matches("@Agent hello")).toEqual([]);
    expect(matches("@AGENT hello")).toEqual([]);
    expect(matches("@Dot hello")).toEqual([]);
  });
});

describe("hasAgentMention / parseAgentMentions", () => {
  test("true when @agent or @dot present", () => {
    expect(hasAgentMention("@agent hi")).toBe(true);
    expect(hasAgentMention("@dot hi")).toBe(true);
    expect(parseAgentMentions("a @agent b")).toEqual(["@agent"]);
    expect(parseAgentMentions("a @dot b")).toEqual(["@dot"]);
  });

  test("false without mention", () => {
    expect(hasAgentMention("plain bullet")).toBe(false);
    expect(parseAgentMentions("plain")).toEqual([]);
  });
});

describe("isAiNode", () => {
  test("true for @agent or @dot mention even without origin", () => {
    expect(isAiNode(makeNode({ id: "q", text: "@agent week rule?" }))).toBe(
      true,
    );
    expect(isAiNode(makeNode({ id: "d", text: "@dot week rule?" }))).toBe(true);
  });

  test("true for origin-stamped answer without mention", () => {
    expect(
      isAiNode(
        makeNode({ id: "a", text: "ISO weeks start Monday.", origin: "agent" }),
      ),
    ).toBe(true);
  });

  test("false for ordinary user bullet", () => {
    expect(isAiNode(makeNode({ id: "u", text: "my notes" }))).toBe(false);
  });
});
