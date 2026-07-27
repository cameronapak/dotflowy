/**
 * Imperative play / stop for `@agent` chrome (ADR 0059 step 3).
 * No hosted AI — play creates a pending ask or reopens Add agent.
 */

import { toast } from "sonner";

import { openAddAgent } from "../components/add-agent-opener";
import {
  cancelActiveAsk,
  createPendingAsk,
  getAgentAskRows,
  refetchAgentAsks,
} from "./agent-asks";
import { hasAgentMention } from "./agent-mention";
import { decideAgentPlay } from "./agent-play";
import {
  getAgentPresenceRows,
  livePresenceAt,
  refetchAgentPresence,
} from "./agent-presence";
import { activeAskForNode } from "./agent-session";
import { getTreeIndex } from "./tree-store";

export type AgentPlayKind =
  | ReturnType<typeof decideAgentPlay>["kind"]
  | "noop-no-mention";

/**
 * Play on a mention chip / hotkey. Presence is re-checked at click time.
 * Returns the decision kind for tests / toast hooks.
 */
export function runAgentPlay(questionNodeId: string): AgentPlayKind {
  void refetchAgentPresence();
  const node = getTreeIndex().byId.get(questionNodeId);
  if (node != null && !hasAgentMention(node.text)) {
    toast.message("Add @agent or @dot to this bullet first");
    return "noop-no-mention";
  }
  const busy = activeAskForNode(getAgentAskRows(), questionNodeId);
  const { live } = livePresenceAt(getAgentPresenceRows(), Date.now());
  const decision = decideAgentPlay({
    questionNodeId,
    nodeExists: node != null,
    livePresence: live,
    askBusy: busy != null,
  });
  switch (decision.kind) {
    case "open-add-agent":
      openAddAgent();
      return decision.kind;
    case "create-ask":
      createPendingAsk(decision.questionNodeId);
      void refetchAgentAsks();
      return decision.kind;
    case "noop-busy":
    case "noop-missing":
      return decision.kind;
    default: {
      const _exhaustive: never = decision;
      void _exhaustive;
      return "noop-missing";
    }
  }
}

/** Stop: cancel the active ask for this node (clears busy). */
export function runAgentStop(questionNodeId: string): boolean {
  const ok = cancelActiveAsk(questionNodeId);
  if (ok) void refetchAgentAsks();
  return ok;
}
