/**
 * Client fire/stop for inline `@agent` (ADR 0059).
 * Requires upgraded sync (Lunora); classic accounts get a toast.
 */

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
import { childrenOf } from "./tree";
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

  // Ghost before shape sync: action→createAgentRun has no client apply.
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
    // #region agent log
    fetch("http://127.0.0.1:7920/ingest/4fe7f996-e307-4b62-b12b-1c7d5e6b57b8", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "a23e41",
      },
      body: JSON.stringify({
        sessionId: "a23e41",
        hypothesisId: "H3",
        location: "src/data/agent-fire.ts:fireAgent",
        message: "firing agent action",
        data: { nodeId, userIdLen: ctx.userId.length },
        timestamp: Date.now(),
        runId: "post-fix",
      }),
    }).catch(() => {});
    // #endregion
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
    // #region agent log
    const childCount = childrenOf(getTreeIndex(), nodeId).length;
    fetch("http://127.0.0.1:7920/ingest/4fe7f996-e307-4b62-b12b-1c7d5e6b57b8", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "a23e41",
      },
      body: JSON.stringify({
        sessionId: "a23e41",
        hypothesisId: "H2",
        location: "src/data/agent-fire.ts:fireAgent:result",
        message: "fireAgent action returned",
        data: {
          status: result?.status ?? null,
          runId: result?.runId ?? null,
          answerRootId: result?.answerRootId ?? null,
          errLen: result?.error?.length ?? 0,
          errHead: result?.error?.slice(0, 120) ?? null,
          childCountBeforeReload: childCount,
        },
        timestamp: Date.now(),
        runId: "post-fix",
      }),
    }).catch(() => {});
    // #endregion
    // Server failAgentRun returns {status:"error"} without throwing — surface it.
    if (result?.status === "error") {
      noteLocalAgentRun(null);
      toast.error(result.error?.slice(0, 200) || "Agent run failed");
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
    // #region agent log
    fetch("http://127.0.0.1:7920/ingest/4fe7f996-e307-4b62-b12b-1c7d5e6b57b8", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "a23e41",
      },
      body: JSON.stringify({
        sessionId: "a23e41",
        hypothesisId: "H3",
        location: "src/data/agent-fire.ts:fireAgent:catch",
        message: "fireAgent failed",
        data: { msg: msg.slice(0, 200) },
        timestamp: Date.now(),
        runId: "post-fix",
      }),
    }).catch(() => {});
    // #endregion
    toast.error(msg);
  }
}

/** Cooperative cancel of the active run on this question. */
export async function stopAgent(nodeId: string): Promise<void> {
  const ctx = getLunoraOutlineContext();
  const run = getAgentRunForQuestion(nodeId);
  if (!ctx || !run || run.status !== "running") return;
  // Local-only stub has no server row yet / cancel is a no-op on server id.
  if (run.runId.startsWith("local:")) {
    noteLocalAgentRun(null);
    return;
  }
  try {
    await ctx.store.mutators.cancelAgentRun({
      userId: ctx.userId,
      runId: run.runId,
      updatedAt: Date.now(),
    });
    noteLocalAgentRun(null);
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
