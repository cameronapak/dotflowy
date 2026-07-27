/**
 * OutlineStore for the inline agent action — same shard bridge MCP uses
 * (listNodes / applyChangeOps / daily-index), via ActionCtx.runQuery/runMutation.
 */

import type { ChangeOp } from "../src/data/wire-schema";
import type { OutlineStore } from "../worker/mcp-tools";
import type { ActionCtx } from "./_generated/server";

import {
  decodeClaimDailyResult,
  decodeDailyClaimValue,
  decodeDailyIndexRows,
  decodeMcpNodeList,
} from "../worker/lunora-mcp-store";
import { internal } from "./_generated/api";

export function createActionOutlineStore(
  ctx: ActionCtx,
  userId: string,
): OutlineStore {
  return {
    async getNodes() {
      // FunctionReference vs RegisteredQuery — same cast as mutator fire path.
      return decodeMcpNodeList(
        await ctx.runQuery(internal.mcp.listNodes as never, { userId }),
      );
    },

    async applyBatch(ops: readonly ChangeOp[]) {
      if (ops.length === 0) return 0;
      await ctx.runMutation(internal.mcp.applyChangeOps as never, {
        userId,
        ops: [...ops],
      });
      return ops.length;
    },

    async getKv(collection: string) {
      if (collection !== "daily-index") return [];
      return decodeDailyIndexRows(
        await ctx.runQuery(internal.mcp.listDailyIndex as never, { userId }),
      );
    },

    async getOrCreateKv(collection: string, key: string, value: unknown) {
      if (collection !== "daily-index") {
        throw new Error(
          `agent outline store: unsupported kv collection ${collection}`,
        );
      }
      let candidate: string;
      try {
        candidate = decodeDailyClaimValue(value).nodeId;
      } catch {
        throw new Error("agent outline store: daily claim needs { nodeId }");
      }
      const result = decodeClaimDailyResult(
        await ctx.runMutation(internal.mcp.claimDailyMapping as never, {
          userId,
          key,
          nodeId: candidate,
          touchedAt: Date.now(),
        }),
      );
      return { key, nodeId: result.nodeId };
    },
  };
}
