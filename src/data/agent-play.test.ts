import { describe, expect, test } from "bun:test";

import { decideAgentPlay } from "./agent-play";

describe("decideAgentPlay (ADR 0059)", () => {
  test("missing node → noop-missing", () => {
    expect(
      decideAgentPlay({
        questionNodeId: "n",
        nodeExists: false,
        livePresence: true,
        askBusy: false,
      }),
    ).toEqual({ kind: "noop-missing" });
  });

  test("busy ask → noop-busy", () => {
    expect(
      decideAgentPlay({
        questionNodeId: "n",
        nodeExists: true,
        livePresence: true,
        askBusy: true,
      }),
    ).toEqual({ kind: "noop-busy" });
  });

  test("no live presence → open-add-agent", () => {
    expect(
      decideAgentPlay({
        questionNodeId: "n",
        nodeExists: true,
        livePresence: false,
        askBusy: false,
      }),
    ).toEqual({ kind: "open-add-agent" });
  });

  test("live presence → create-ask", () => {
    expect(
      decideAgentPlay({
        questionNodeId: "node-a",
        nodeExists: true,
        livePresence: true,
        askBusy: false,
      }),
    ).toEqual({ kind: "create-ask", questionNodeId: "node-a" });
  });
});
