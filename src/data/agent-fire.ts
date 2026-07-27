/**
 * Client fire/stop for inline `@agent` (ADR 0059).
 * Requires upgraded sync (Lunora); classic accounts get a toast.
 */

import type { FunctionReference } from "lunorash/client";

import { toast } from "sonner";

import { api } from "../../lunora/_generated/api";
import { hasAgentMention } from "./agent-mention";
import { getAgentRunForQuestion, noteLocalAgentRun } from "./agent-runs";
import { isLunoraSyncEnabled } from "./flags";
import { getLunoraClient } from "./lunora-client";
import {
  getLunoraOutlineContext,
  softReloadLunoraOutline,
} from "./lunora-sync";
import { getTreeIndex } from "./tree-store";

/** Question ids the user Stop'd while fireAgent was still in flight. */
const cancelledQuestions = new Set<string>();

/**
 * Store mutators (`ctx.store.mutators.*`) apply locally + outbox — and return
 * the TanStack Transaction, not the server result. Worse: an empty local apply
 * (no running row in the agentRuns collection yet — only the `local:` overlay)
 * skips the server write entirely. Cancel must always hit the Worker via
 * `client.mutation`, same path fire uses for `client.action`.
 */
type CancelByQuestionRef = FunctionReference<
  "mutation",
  { userId: string; questionNodeId: string; updatedAt: number },
  { ok: boolean; runId: string | null }
>;
const cancelAgentRunForQuestionRef = (
  api as unknown as {
    mutators: { cancelAgentRunForQuestion: CancelByQuestionRef };
  }
).mutators.cancelAgentRunForQuestion;

async function cancelRunOnServer(
  userId: string,
  questionNodeId: string,
): Promise<{ ok: boolean; runId: string | null }> {
  const client = getLunoraClient();
  const result = (await client.mutation(
    cancelAgentRunForQuestionRef,
    {
      userId,
      questionNodeId,
      updatedAt: Date.now(),
    },
    { shardKey: userId },
  )) as { ok?: boolean; runId?: string | null };
  return {
    ok: result?.ok === true,
    runId: result?.runId ?? null,
  };
}

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

  // Fresh fire — drop any prior Stop mark for this question.
  cancelledQuestions.delete(nodeId);
  // Trailing busy chrome before shape sync: action→createAgentRun has no client apply.
  noteLocalAgentRun({
    runId: `local:${nodeId}`,
    questionNodeId: nodeId,
    status: "running",
    partialText: "",
    answerRootId: null,
    answerHash: null,
    error: null,
    updatedAt: Date.now(),
  });

  try {
    const client = getLunoraClient();
    const result = (await client.action(
      api.agent.fireAgentRun,
      {
        userId: ctx.userId,
        questionNodeId: nodeId,
      },
      { shardKey: ctx.userId },
    )) as {
      status?: string;
      runId?: string;
      answerRootId?: string;
      error?: string;
    };
    // Server failAgentRun returns {status:"error"} without throwing — surface it.
    if (result?.status === "error") {
      noteLocalAgentRun(null);
      toast.error(result.error?.slice(0, 200) || "Agent run failed");
      return;
    }
    // Stop may have raced ahead of createAgentRun — cancel again + skip reload.
    if (cancelledQuestions.has(nodeId) || result?.status === "cancelled") {
      cancelledQuestions.delete(nodeId);
      noteLocalAgentRun(null);
      try {
        await cancelRunOnServer(ctx.userId, nodeId);
      } catch {
        /* best-effort */
      }
      return;
    }
    noteLocalAgentRun(null);
    // Durable commit may already be on the shard while the outline collection
    // is still stale (WS poke missed). Soft-reload = hard-refresh without F5.
    // Animate the answer in; never scrollIntoView / steal focus (WS streaming
    // is preferred when alive — here we only have the post-commit reload).
    if (result?.status === "completed") {
      softReloadLunoraOutline({
        answerRootId: result.answerRootId ?? null,
      });
    }
  } catch (err) {
    noteLocalAgentRun(null);
    const msg = err instanceof Error ? err.message : "Agent run failed";
    toast.error(msg);
  }
}

/** Cooperative cancel of the active run on this question. */
export async function stopAgent(nodeId: string): Promise<void> {
  const ctx = getLunoraOutlineContext();
  const run = getAgentRunForQuestion(nodeId);
  if (!ctx || !run || run.status !== "running") return;
  cancelledQuestions.add(nodeId);
  // Optimistic: clear the local busy overlay immediately.
  noteLocalAgentRun(null);
  try {
    // Always cancel by questionNodeId via client.mutation (not store mutators —
    // see cancelRunOnServer). The UI often only has a `local:` stub.
    await cancelRunOnServer(ctx.userId, nodeId);
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
