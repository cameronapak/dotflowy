/**
 * Client fire/stop for inline `@agent` (ADR 0059).
 * Requires upgraded sync (Lunora); classic accounts get a toast.
 */

import { toast } from "sonner";

import { api } from "../../lunora/_generated/api";
import { hasAgentMention } from "./agent-mention";
import { getAgentRunForQuestion } from "./agent-runs";
import { isLunoraSyncEnabled } from "./flags";
import { getLunoraClient } from "./lunora-client";
import { getLunoraOutlineContext } from "./lunora-sync";
import { getTreeIndex } from "./tree-store";

/** Ensure the focused node mentions `@agent`, then start a Lunora run. */
export async function fireAgent(nodeId: string): Promise<void> {
  const node = getTreeIndex().byId.get(nodeId);
  if (!node) return;

  if (!hasAgentMention(node.text)) {
    toast.message("Add @agent to this bullet first");
    return;
  }

  if (!isLunoraSyncEnabled()) {
    toast.message("Inline agent needs upgraded sync", {
      description: "Turn on the beta sync option in Settings, then try again.",
    });
    return;
  }

  const ctx = getLunoraOutlineContext();
  if (!ctx) {
    toast.message("Outline sync is still loading");
    return;
  }

  const existing = getAgentRunForQuestion(nodeId);
  if (existing?.status === "running") {
    await stopAgent(nodeId);
    return;
  }

  try {
    const client = getLunoraClient();
    await client.action(
      api.agent.fireAgentRun,
      {
        userId: ctx.userId,
        questionNodeId: nodeId,
      },
      { shardKey: ctx.userId },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Agent run failed";
    toast.error(msg);
  }
}

/** Cooperative cancel of the active run on this question. */
export async function stopAgent(nodeId: string): Promise<void> {
  const ctx = getLunoraOutlineContext();
  const run = getAgentRunForQuestion(nodeId);
  if (!ctx || !run || run.status !== "running") return;
  try {
    await ctx.store.mutators.cancelAgentRun({
      userId: ctx.userId,
      runId: run.runId,
      updatedAt: Date.now(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not stop run";
    toast.error(msg);
  }
}

/** Insert `@agent ` at the start of the bullet (Seam C `/ask`). */
export function ensureAgentMention(
  nodeId: string,
  onTextChange: (id: string, text: string) => void,
): void {
  const node = getTreeIndex().byId.get(nodeId);
  if (!node) return;
  if (hasAgentMention(node.text)) return;
  const next = node.text.trim().length ? `@agent ${node.text}` : "@agent ";
  onTextChange(nodeId, next);
}
