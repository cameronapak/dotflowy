/**
 * Pure wiring: outline-ops ChangeOp batch → Lunora OutlinePlan
 * (mcp:applyChangeOps input). Full shard RPC stays integration-only.
 */

import { describe, expect, test } from "bun:test";

import type { MutationCtx } from "../lunora/_generated/server";

import { claimDailyMapping, commitPlan } from "../lunora/mcp";
import { planFromChangeOps } from "../src/data/outline-plans";
import { makeNode } from "../src/data/tree";

describe("MCP → Lunora applyChangeOps plan", () => {
  test("planner batch becomes inserts/patches/deletes", () => {
    const a = makeNode({ id: "a", text: "alpha" });
    const b = makeNode({ id: "b", text: "bravo" });
    const plan = planFromChangeOps("user-1", [
      { op: "insert", value: a },
      { op: "update", value: { ...b, text: "BRAVO" } },
      { op: "delete", key: "z" },
    ]);
    expect(plan.inserts[0]!.userId).toBe("user-1");
    expect(plan.inserts[0]!.text).toBe("alpha");
    expect(plan.patches[0]!.fields.text).toBe("BRAVO");
    expect(plan.deletes).toEqual(["z"]);
  });

  test("an insert and a later update on ONE key fold into one insert", () => {
    // The buckets apply deletes → patches → inserts, so an un-coalesced batch
    // would run this patch before its row exists and drop the update entirely.
    const a = makeNode({ id: "a", text: "alpha" });
    const plan = planFromChangeOps("user-1", [
      { op: "insert", value: a },
      { op: "update", value: { ...a, text: "ALPHA" } },
    ]);
    expect(plan.patches).toEqual([]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]!.text).toBe("ALPHA");
  });
});

/**
 * Routing, not shard RPC — the fake below is a call recorder, not a store.
 *
 * The invariant it models is "every id-addressed write names its table at
 * RUNTIME", not any one spelling of it. An unscoped by-id `patch`/`delete`
 * resolves the id via `UNION ALL` across every shard table (the branded `Id<T>`
 * erases before the call reaches the store), which trips Workerd SQLite's
 * compound-SELECT limit on this schema — so the fake throws for exactly that
 * call and records the table for either correct form: the accessor
 * (`ctx.db.nodes.patch(id, …)`, which `bindTableFacade` binds with its name) or
 * the explicit third argument `lunora/mutators.ts` passes off the looser
 * `MutatorCtx` (`ctx.db.patch(id, fields, "nodes")`).
 *
 * Modelling the unscoped path as a throw is what makes this a regression test:
 * before #330's fix every MCP write containing a patch or delete took it.
 */
function recordingCtx(options: { dailyRow?: Record<string, unknown> } = {}) {
  const calls: Array<{ id: string; op: string; table: string }> = [];
  const patched: Array<{ fields: unknown; id: string }> = [];
  const record = (id: string, op: string, table: string | undefined) => {
    if (!table) {
      throw new Error(
        `unscoped by-id ${op}: too many terms in compound SELECT`,
      );
    }
    calls.push({ id, op, table });
  };
  const writer = (bound?: string) => ({
    delete: async (id: string, expectedTable?: string) => {
      record(id, "delete", bound ?? expectedTable);
    },
    patch: async (id: string, fields: unknown, expectedTable?: string) => {
      record(id, "patch", bound ?? expectedTable);
      patched.push({ fields, id });
    },
  });
  // Unbound: the raw by-id form, correct only when it carries the table.
  const byId = writer();
  const db = {
    ...byId,
    asId: (_table: string, id: string) => id,
    dailyIndex: writer("dailyIndex"),
    insert: async (
      table: string,
      _doc: unknown,
      options_?: { clientId?: string },
    ) => {
      calls.push({ id: options_?.clientId ?? "", op: "insert", table });
      return options_?.clientId ?? "";
    },
    nodes: writer("nodes"),
    query: (table: string) => ({
      withIndex: () => ({
        first: async () =>
          table === "dailyIndex" ? (options.dailyRow ?? null) : null,
      }),
    }),
  };
  return {
    byId,
    calls,
    ctx: { auth: { userId: "user-1" }, db } as unknown as MutationCtx,
    patched,
  };
}

describe("commitPlan table scoping", () => {
  test("patches and deletes go through the table accessor, not by-id", async () => {
    const { calls, ctx, patched } = recordingCtx();
    const plan = planFromChangeOps("user-1", [
      { op: "insert", value: makeNode({ id: "a", text: "alpha" }) },
      { op: "update", value: makeNode({ id: "b", text: "BRAVO" }) },
      { op: "delete", key: "z" },
    ]);

    await commitPlan(ctx, plan);

    // Every id-addressed write names `nodes`; order stays deletes → patches →
    // inserts (a deleted id must be gone before an insert could reclaim it).
    expect(calls).toEqual([
      { id: "z", op: "delete", table: "nodes" },
      { id: "b", op: "patch", table: "nodes" },
      { id: "a", op: "insert", table: "nodes" },
    ]);
    expect(patched[0]!.fields).toMatchObject({ text: "BRAVO" });
  });

  test("a null patch field survives — top-level moves set parentId null", async () => {
    // The generated `Insert_nodes` drops `.nullable()`, so this is the case the
    // cast in `commitPlan` exists for. Assert the payload, not just the route:
    // a cast that quietly dropped the null would still route correctly.
    const { calls, ctx, patched } = recordingCtx();
    await commitPlan(ctx, {
      deletes: [],
      inserts: [],
      patches: [{ fields: { parentId: null }, id: "n1" }],
    });
    expect(calls).toEqual([{ id: "n1", op: "patch", table: "nodes" }]);
    expect(patched).toEqual([{ fields: { parentId: null }, id: "n1" }]);
  });

  test("an unscoped by-id write is what the fake rejects — the bug, not a spelling", async () => {
    // Guards the guard: if `record` ever stopped throwing, the two tests above
    // would pass against the broken code they exist to catch.
    // `byId` is the raw by-id writer, reached here directly because the nominal
    // `MutationCtx` can't even SPELL the 3-arg call — which is the whole bug.
    const { byId, calls } = recordingCtx();
    expect(byId.patch("n1", {})).rejects.toThrow("unscoped by-id patch");
    // The explicit third argument is the OTHER correct form (`mutators.ts`),
    // so the fake must accept it — the invariant is "names its table".
    await byId.patch("n1", {}, "nodes");
    expect(calls).toEqual([{ id: "n1", op: "patch", table: "nodes" }]);
  });
});

describe("claimDailyMapping table scoping", () => {
  test("an existing mapping patches through the dailyIndex accessor", async () => {
    // The second call site #330 broke. `commitPlan`'s tests only touch `nodes`,
    // so without this the dailyIndex half could regress unnoticed.
    const { calls, ctx, patched } = recordingCtx({
      dailyRow: { _id: "d1", key: "2026-07-30", nodeId: "day-node" },
    });

    const result = await claimDailyMapping.handler(ctx, {
      key: "2026-07-30",
      nodeId: "loser-node",
      touchedAt: 1_700_000_000_000,
      userId: "user-1",
    });

    // Pre-existing mapping wins (resolveDailyClaim); the row is still touched.
    expect(result).toEqual({ nodeId: "day-node", won: false });
    expect(calls).toEqual([{ id: "d1", op: "patch", table: "dailyIndex" }]);
    expect(patched[0]!.fields).toEqual({
      nodeId: "day-node",
      touchedAt: 1_700_000_000_000,
    });
  });

  test("a missing mapping inserts — no by-id write to scope", async () => {
    const { calls, ctx } = recordingCtx();

    const result = await claimDailyMapping.handler(ctx, {
      key: "2026-07-30",
      nodeId: "day-node",
      touchedAt: 1_700_000_000_000,
      userId: "user-1",
    });

    expect(result).toEqual({ nodeId: "day-node", won: true });
    expect(calls).toEqual([{ id: "", op: "insert", table: "dailyIndex" }]);
  });
});
