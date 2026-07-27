/**
 * Pure play→ask gate (ADR 0059 step 3). No hosted AI — play either opens Add
 * agent (no live presence) or creates a pending ask for the question node.
 */

export type AgentPlayDecision =
  | { kind: "open-add-agent" }
  | { kind: "noop-busy" }
  | { kind: "noop-missing" }
  | { kind: "create-ask"; questionNodeId: string };

/**
 * Decide what play does for `questionNodeId`.
 *
 * - Missing node → noop
 * - Already pending/claimed ask → noop (row shows stop)
 * - No live presence → reopen Add agent (same join prompt; never invent focus paste)
 * - Else → create pending ask
 */
export function decideAgentPlay(input: {
  questionNodeId: string;
  nodeExists: boolean;
  livePresence: boolean;
  askBusy: boolean;
}): AgentPlayDecision {
  if (!input.nodeExists) return { kind: "noop-missing" };
  if (input.askBusy) return { kind: "noop-busy" };
  if (!input.livePresence) return { kind: "open-add-agent" };
  return { kind: "create-ask", questionNodeId: input.questionNodeId };
}
