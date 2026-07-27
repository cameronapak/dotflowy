import { describe, expect, test } from "bun:test";

import { agentRunAllowsAnswerCommit } from "./agent-run-gate";

describe("agentRunAllowsAnswerCommit", () => {
  test("allows only running", () => {
    expect(agentRunAllowsAnswerCommit("running")).toBe(true);
  });

  test("refuses cancelled, completed, error, and junk", () => {
    expect(agentRunAllowsAnswerCommit("cancelled")).toBe(false);
    expect(agentRunAllowsAnswerCommit("completed")).toBe(false);
    expect(agentRunAllowsAnswerCommit("error")).toBe(false);
    expect(agentRunAllowsAnswerCommit(null)).toBe(false);
    expect(agentRunAllowsAnswerCommit(undefined)).toBe(false);
    expect(agentRunAllowsAnswerCommit("")).toBe(false);
  });
});
