import { describe, expect, test } from "bun:test";

import type { ChangeOp, Node } from "./wire-schema";

import { chainDisagreements } from "./sibling-chain";
import { createNode } from "./tree";
import {
  planWeekStartMigration,
  type DailyIndexRow,
  type WeekStartMigrationPlan,
} from "./week-start-migration";

function applyPlan(
  nodes: readonly Node[],
  rows: readonly DailyIndexRow[],
  plan: WeekStartMigrationPlan,
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const op of plan.ops) {
    if (op.op === "delete") byId.delete(op.key);
    else byId.set(op.value.id, op.value);
  }
  const byKey = new Map(rows.map((row) => [row.key, row]));
  for (const key of plan.deletes) byKey.delete(key);
  for (const row of plan.upserts) byKey.set(row.key, row);
  return { nodes: [...byId.values()], rows: [...byKey.values()] };
}

function changedNode(ops: readonly ChangeOp[], id: string): Node | undefined {
  const op = ops.find(
    (candidate) => candidate.op !== "delete" && candidate.value.id === id,
  );
  return op?.op === "delete" ? undefined : op?.value;
}

function seamFixture() {
  const nodes = [
    createNode({ id: "container", text: "Daily" }),
    createNode({ id: "year", parentId: "container", text: "2026" }),
    createNode({ id: "month", parentId: "year", text: "October" }),
    createNode({
      id: "week-a",
      parentId: "month",
      text: "Oct 5–11",
    }),
    createNode({
      id: "week-b",
      parentId: "month",
      prevSiblingId: "week-a",
      text: "Oct 12–18",
    }),
    createNode({
      id: "sunday",
      parentId: "week-a",
      text: "Sunday",
    }),
    createNode({
      id: "monday",
      parentId: "week-b",
      text: "Monday",
    }),
    createNode({
      id: "week-note",
      parentId: "week-b",
      prevSiblingId: "monday",
      text: "Undated weekly note",
    }),
  ];
  const rows: DailyIndexRow[] = [
    { key: "container", nodeId: "container" },
    { key: "2026", nodeId: "year" },
    { key: "2026-10", nodeId: "month" },
    { key: "week:2026-10-05", nodeId: "week-a" },
    { key: "week:2026-10-12", nodeId: "week-b" },
    { key: "2026-10-11", nodeId: "sunday" },
    { key: "2026-10-12", nodeId: "monday" },
  ];
  return { nodes, rows };
}

describe("planWeekStartMigration", () => {
  test("Monday to Sunday moves only the seam day and keeps direct Week notes", () => {
    const fixture = seamFixture();
    const plan = planWeekStartMigration(
      fixture.nodes,
      fixture.rows,
      "sunday",
      100,
      () => "unused",
    );

    expect(plan.deletes).toEqual(["week:2026-10-05", "week:2026-10-12"]);
    expect(plan.upserts).toEqual(
      expect.arrayContaining([
        { key: "week:2026-10-04", nodeId: "week-a" },
        { key: "week:2026-10-11", nodeId: "week-b" },
      ]),
    );
    expect(changedNode(plan.ops, "sunday")?.parentId).toBe("week-b");
    expect(changedNode(plan.ops, "monday")).toMatchObject({
      parentId: "week-b",
      prevSiblingId: "sunday",
    });
    expect(changedNode(plan.ops, "week-note")).toBeUndefined();
    expect(changedNode(plan.ops, "week-b")?.text).toBe("Oct 11–17");
  });

  test("switching back restores Monday placement without moving a direct note", () => {
    const fixture = seamFixture();
    const sunday = planWeekStartMigration(
      fixture.nodes,
      fixture.rows,
      "sunday",
      100,
      () => "unused",
    );
    const migrated = applyPlan(fixture.nodes, fixture.rows, sunday);
    const monday = planWeekStartMigration(
      migrated.nodes,
      migrated.rows,
      "monday",
      200,
      () => "unused",
    );

    expect(changedNode(monday.ops, "sunday")?.parentId).toBe("week-a");
    expect(changedNode(monday.ops, "week-note")).toBeUndefined();
    expect(monday.upserts).toEqual(
      expect.arrayContaining([
        { key: "week:2026-10-05", nodeId: "week-a" },
        { key: "week:2026-10-12", nodeId: "week-b" },
      ]),
    );
  });

  test("leaves a user-relocated Daily note outside the scaffold", () => {
    const fixture = seamFixture();
    const nodes = [
      ...fixture.nodes,
      createNode({ id: "project", text: "Project" }),
      createNode({ id: "relocated", parentId: "project" }),
    ];
    const rows = [...fixture.rows, { key: "2026-10-18", nodeId: "relocated" }];
    const plan = planWeekStartMigration(
      nodes,
      rows,
      "sunday",
      100,
      () => "unused",
    );

    expect(changedNode(plan.ops, "relocated")).toBeUndefined();
  });

  test("leaves a top-level relocated day in a valid root sibling chain", () => {
    const nodes = [
      createNode({ id: "container", text: "Daily" }),
      createNode({ id: "before", prevSiblingId: "container", text: "Before" }),
      createNode({
        id: "relocated",
        prevSiblingId: "before",
        text: "Relocated day",
      }),
      createNode({ id: "after", prevSiblingId: "relocated", text: "After" }),
    ];
    const rows = [
      { key: "container", nodeId: "container" },
      { key: "2026-10-18", nodeId: "relocated" },
    ];
    const plan = planWeekStartMigration(
      nodes,
      rows,
      "sunday",
      100,
      () => "unused",
    );
    const migrated = applyPlan(nodes, rows, plan);

    expect(changedNode(plan.ops, "relocated")).toBeUndefined();
    expect(changedNode(plan.ops, "after")).toBeUndefined();
    expect(chainDisagreements(migrated.nodes)).toEqual([]);
  });

  test("rejects two live Week nodes converging on one target identity", () => {
    const fixture = seamFixture();
    const rows = [
      ...fixture.rows,
      { key: "week:2026-10-11", nodeId: "week-a" },
    ];

    expect(() =>
      planWeekStartMigration(
        fixture.nodes,
        rows,
        "sunday",
        100,
        () => "unused",
      ),
    ).toThrow("week mapping week:2026-10-11 is already occupied");
  });

  test("refuses to reclaim a relocated Month required by a boundary Week", () => {
    const nodes = [
      createNode({ id: "container", text: "Daily" }),
      createNode({ id: "daily-year", parentId: "container", text: "2026" }),
      createNode({ id: "october", parentId: "daily-year", text: "October" }),
      createNode({ id: "week", parentId: "october", text: "Sep 28–Oct 4" }),
      createNode({ id: "project", text: "Project" }),
      createNode({ id: "september", parentId: "project", text: "September" }),
      createNode({
        id: "private-note",
        parentId: "september",
        text: "Private",
      }),
    ];
    const rows = [
      { key: "container", nodeId: "container" },
      { key: "2026", nodeId: "daily-year" },
      { key: "2026-10", nodeId: "october" },
      { key: "2026-09", nodeId: "september" },
      { key: "week:2026-09-28", nodeId: "week" },
    ];

    expect(() =>
      planWeekStartMigration(nodes, rows, "sunday", 100, () => "unused"),
    ).toThrow("month mapping 2026-09 was relocated");
  });

  test("deletes abandoned scaffold claims before deriving target structure", () => {
    const fixture = seamFixture();
    const rows = [
      ...fixture.rows,
      { key: "week:2026-10-19", nodeId: "never-committed" },
      { key: "2026-11", nodeId: "never-committed-month" },
    ];
    const plan = planWeekStartMigration(
      fixture.nodes,
      rows,
      "sunday",
      100,
      () => "unused",
    );

    expect(plan.deletes).toEqual(
      expect.arrayContaining(["week:2026-10-19", "2026-11"]),
    );
  });

  test("moves a year-boundary week and removes only emptied old scaffold", () => {
    const nodes = [
      createNode({ id: "container", text: "Daily" }),
      createNode({ id: "year-2026", parentId: "container", text: "2026" }),
      createNode({ id: "jan", parentId: "year-2026", text: "January" }),
      createNode({
        id: "week",
        parentId: "jan",
        text: "Dec 29, 2025–Jan 4, 2026",
      }),
      createNode({ id: "day", parentId: "week", text: "December 30" }),
    ];
    const rows = [
      { key: "container", nodeId: "container" },
      { key: "2026", nodeId: "year-2026" },
      { key: "2026-01", nodeId: "jan" },
      { key: "week:2025-12-29", nodeId: "week" },
      { key: "2025-12-30", nodeId: "day" },
    ];
    let nextId = 0;
    const plan = planWeekStartMigration(
      nodes,
      rows,
      "sunday",
      100,
      () => `new-${++nextId}`,
    );
    const migrated = applyPlan(nodes, rows, plan);
    const december = migrated.rows.find((row) => row.key === "2025-12");

    expect(migrated.rows).toEqual(
      expect.arrayContaining([
        { key: "2025", nodeId: expect.any(String) },
        { key: "week:2025-12-28", nodeId: "week" },
      ]),
    );
    expect(migrated.rows.some((row) => row.key === "2026-01")).toBe(false);
    expect(migrated.rows.some((row) => row.key === "2026")).toBe(false);
    expect(migrated.nodes.some((node) => node.id === "jan")).toBe(false);
    expect(migrated.nodes.some((node) => node.id === "year-2026")).toBe(false);
    expect(migrated.nodes.find((node) => node.id === "week")?.parentId).toBe(
      december?.nodeId,
    );
  });

  test("creates sparse boundary scaffold and is idempotent after applying", () => {
    const nodes = [
      createNode({ id: "container", text: "Daily" }),
      createNode({ id: "day", parentId: "container", text: "Sunday" }),
    ];
    const rows = [
      { key: "container", nodeId: "container" },
      { key: "2027-01-03", nodeId: "day" },
    ];
    let nextId = 0;
    const first = planWeekStartMigration(
      nodes,
      rows,
      "sunday",
      100,
      () => `new-${++nextId}`,
    );
    const migrated = applyPlan(nodes, rows, first);
    const weekRow = migrated.rows.find((row) => row.key === "week:2027-01-03");

    expect(weekRow).toBeDefined();
    expect(migrated.rows).toEqual(
      expect.arrayContaining([
        { key: "2027", nodeId: expect.any(String) },
        { key: "2027-01", nodeId: expect.any(String) },
      ]),
    );
    expect(migrated.nodes.find((node) => node.id === "day")?.parentId).toBe(
      weekRow?.nodeId,
    );

    const second = planWeekStartMigration(
      migrated.nodes,
      migrated.rows,
      "sunday",
      200,
      () => "should-not-create",
    );
    expect(second).toEqual({ ops: [], upserts: [], deletes: [] });
  });
});
