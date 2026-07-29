/**
 * Pure wiring: outline-ops ChangeOp batch → Lunora OutlinePlan
 * (mcp:applyChangeOps input). Full shard RPC stays integration-only.
 */

import { describe, expect, test } from "bun:test";

import type { MutationCtx } from "../lunora/_generated/server";

import { commitPlan } from "../lunora/mcp";
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
 * The by-id `ctx.db.patch`/`ctx.db.delete` resolve an id via `UNION ALL` across
 * every shard table (the branded `Id<T>` erases before the call, and those
 * signatures have no `expectedTable` parameter), which trips Workerd SQLite's
 * compound-SELECT limit on this schema. The table accessors forward their bound
 * name as `expectedTable`, so they are scoped by construction.
 *
 * Modelling the by-id path as a throw is what makes this a regression test:
 * before #330's fix every MCP write containing a patch or delete took it.
 */
function recordingCtx() {
  const calls: Array<{ id: string; op: string; table: string }> = [];
  const patched: Array<{ fields: unknown; id: string }> = [];
  const tableWriter = (table: string) => ({
    delete: async (id: string) => {
      calls.push({ id, op: "delete", table });
    },
    patch: async (id: string, fields: unknown) => {
      calls.push({ id, op: "patch", table });
      patched.push({ fields, id });
    },
  });
  const unscoped = (op: string) => (): never => {
    throw new Error(`unscoped by-id ${op}: too many terms in compound SELECT`);
  };
  const db = {
    asId: (_table: string, id: string) => id,
    dailyIndex: tableWriter("dailyIndex"),
    delete: unscoped("delete"),
    insert: async (
      table: string,
      _doc: unknown,
      options?: { clientId?: string },
    ) => {
      calls.push({ id: options?.clientId ?? "", op: "insert", table });
      return options?.clientId ?? "";
    },
    nodes: tableWriter("nodes"),
    patch: unscoped("patch"),
  };
  return { calls, ctx: { db } as unknown as MutationCtx, patched };
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
});
