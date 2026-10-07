import { describe, expect, test } from "bun:test";
import { Clock, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

import { buildTreeIndex, createNode, type Node } from "../src/data/tree";
import { searchNodes } from "./outline-ops";
import { SearchInput, SearchPage, searchPage } from "./search";

const ids = (nodes: Node[], query: string, rootId: string | null = null) =>
  searchNodes(buildTreeIndex(nodes), query, 100, rootId).map((hit) => hit.id);

const page = (nodes: Node[], input: typeof SearchInput.Type) =>
  Effect.runPromise(searchPage(buildTreeIndex(nodes), input));

function tasks(count: number): Node[] {
  return Array.from({ length: count }, (_, i) =>
    createNode({
      id: `task-${i}`,
      prevSiblingId: i === 0 ? null : `task-${i - 1}`,
      text: `Task ${i} #dotflowy ||private-${i}||`,
      isTask: true,
    }),
  );
}

describe("DQL agent matching", () => {
  test("the requested query tests kind, completion, and exact same-node tags", () => {
    const nodes = [
      createNode({ id: "project", text: "Project #dotflowy", collapsed: true }),
      createNode({
        id: "open",
        parentId: "project",
        text: "Ship #dotflowy",
        isTask: true,
      }),
      createNode({
        id: "completed",
        parentId: "project",
        prevSiblingId: "open",
        text: "Done #dotflowy",
        isTask: true,
        completed: true,
      }),
      createNode({
        id: "untagged",
        parentId: "project",
        prevSiblingId: "completed",
        text: "Child",
        isTask: true,
      }),
      createNode({
        id: "paragraph",
        parentId: "project",
        prevSiblingId: "untagged",
        text: "Prose #dotflowy",
        isTask: true,
        kind: "paragraph",
      }),
      createNode({
        id: "prefix",
        parentId: "project",
        prevSiblingId: "paragraph",
        text: "Task #dotflowy-extra",
        isTask: true,
      }),
      createNode({
        id: "case",
        parentId: "project",
        prevSiblingId: "prefix",
        text: "Task #Dotflowy",
        isTask: true,
      }),
    ];
    expect(ids(nodes, "is:todo -is:complete #dotflowy")).toEqual(["open"]);
    expect(ids(nodes, "is:complete")).toEqual(["completed"]);
    expect(ids(nodes, "is:todo -#dotflowy")).toEqual([
      "untagged",
      "prefix",
      "case",
    ]);
    expect(ids(nodes, "is:paragraph")).toEqual(["paragraph"]);
  });

  test("AND differs from a phrase; adjacent-term OR, unknown operators, and markup retain app semantics", () => {
    const nodes = [
      createNode({ id: "phrase", text: "Release notes" }),
      createNode({
        id: "apart",
        prevSiblingId: "phrase",
        text: "notes about this release",
      }),
      createNode({
        id: "label",
        prevSiblingId: "apart",
        text: "[Guide](https://secret-url.test) ==🔴urgent==",
        origin: "Agent",
      }),
      createNode({ id: "literal", prevSiblingId: "label", text: "is:unknown" }),
    ];
    expect(ids(nodes, "release notes")).toEqual(["phrase", "apart"]);
    expect(ids(nodes, '"release notes"')).toEqual(["phrase"]);
    expect(ids(nodes, "release OR guide -notes")).toEqual(["label"]);
    expect(ids(nodes, "is:agent has:link highlight:red GUIDE")).toEqual([
      "label",
    ]);
    expect(ids(nodes, "secret-url")).toEqual([]);
    expect(ids(nodes, "is:unknown")).toEqual(["literal"]);
    expect(ids(nodes, '"is:unknown"')).toEqual(["literal"]);
  });

  test("scoped mirrors resolve content, deduplicate descendants, and keep first view breadcrumbs", () => {
    const nodes = [
      createNode({ id: "project", text: "Project" }),
      createNode({
        id: "task",
        parentId: "project",
        text: "Task #dotflowy",
        isTask: true,
      }),
      createNode({
        id: "child",
        parentId: "task",
        text: "Child #dotflowy",
        isTask: true,
      }),
      createNode({
        id: "today",
        prevSiblingId: "project",
        text: "Today",
        collapsed: true,
      }),
      createNode({
        id: "m1",
        parentId: "today",
        mirrorOf: "task",
        text: "stale",
        completed: true,
      }),
      createNode({
        id: "m2",
        parentId: "today",
        prevSiblingId: "m1",
        mirrorOf: "task",
      }),
      createNode({
        id: "cycle",
        parentId: "task",
        prevSiblingId: "child",
        mirrorOf: "project",
      }),
      createNode({
        id: "outside",
        prevSiblingId: "today",
        text: "Outside #dotflowy",
        isTask: true,
      }),
    ];
    const hits = searchNodes(
      buildTreeIndex(nodes),
      "is:todo -is:complete #dotflowy",
      100,
      "today",
    );
    // The project mirror also reaches the source task itself, but its already
    // expanded descendants are capped rather than emitted a second time.
    expect(hits.map((hit) => hit.id)).toEqual(["m1", "child", "task", "m2"]);
    expect(hits[0]).toEqual({
      id: "m1",
      text: "Task #dotflowy",
      kind: null,
      isTask: true,
      completed: false,
      locked: false,
      mirrorOf: "task",
      path: ["Today"],
    });
    expect(hits[1]?.path).toEqual(["Today", "Task #dotflowy"]);
    expect(ids(nodes, "is:mirror", "today")).toEqual(["m1", "cycle", "m2"]);
    expect(ids(nodes, "#dotflowy", "m2")).toEqual(["m2", "child", "task"]);
    expect(ids(nodes, "today", "today")).toEqual(["today"]);
  });

  test("spoilers cannot influence text, tags, links, highlights, negation, or mirrored matching", () => {
    const nodes = [
      createNode({ id: "parent", text: "Parent ||hidden-parent||" }),
      createNode({
        id: "secret",
        parentId: "parent",
        text: "Visible ||#secret [hidden](https://x) ==🔴answer==||",
        isTask: true,
      }),
      createNode({ id: "mirror", prevSiblingId: "parent", mirrorOf: "secret" }),
      createNode({
        id: "public",
        prevSiblingId: "mirror",
        text: "Visible #secret [public](https://x) ==🔴note==",
      }),
    ];
    for (const query of [
      "#secret",
      "has:link",
      "highlight:",
      "highlight:red",
    ]) {
      expect(ids(nodes, query)).toEqual(["public"]);
    }
    for (const query of ["hidden", "answer", "#secret is:mirror"])
      expect(ids(nodes, query)).toEqual([]);
    expect(ids(nodes, "visible -#secret -has:link -highlight:")).toEqual([
      "secret",
      "mirror",
    ]);
    const hit = searchNodes(buildTreeIndex(nodes), "visible is:todo", 100)[0];
    expect(hit?.text).toBe("Visible [spoiler]");
    expect(hit?.path).toEqual(["Parent [spoiler]"]);
  });
});

describe("search continuation", () => {
  test("date-label matching shares the captured clock and rejects continuation after midnight", async () => {
    const nodes = ["a", "b", "c", "d"].map((id, i) =>
      createNode({
        id,
        prevSiblingId: i === 0 ? null : ["a", "b", "c", "d"][i - 1],
        text: `custom:[[2032-10-${i < 2 ? "02" : "03"}]]`,
      }),
    );
    const index = buildTreeIndex(nodes);
    await Effect.runPromise(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* clock.setTime(new Date(2032, 9, 2, 12).getTime());
        const run = (input: typeof SearchInput.Type) =>
          searchPage(index, input).pipe(
            Effect.provideService(Clock.Clock, clock),
          );
        for (const query of ["today", "custom:today"]) {
          const first = yield* run({ query, limit: 1 });
          expect(first.nodes.map((node) => node.id)).toEqual(["a"]);
          if (!first.nextCursor) throw new Error("Expected continuation");
          const sameDay = yield* run({
            query,
            limit: 1,
            cursor: first.nextCursor,
          });
          expect(sameDay.nodes.map((node) => node.id)).toEqual(["b"]);
          yield* clock.setTime(new Date(2032, 9, 3, 0).getTime());
          const error = yield* Effect.flip(
            run({ query, limit: 1, cursor: first.nextCursor }),
          );
          expect(error.reason).toContain("Restart");
          const restarted = yield* run({ query, limit: 1 });
          expect(restarted.nodes.map((node) => node.id)).toEqual(["c"]);
          yield* clock.setTime(new Date(2032, 9, 2, 12).getTime());
        }
      }).pipe(Effect.scoped),
    );
  });

  test("exact page boundaries distinguish a complete list from more matches", async () => {
    const query = "is:todo #dotflowy";
    for (const count of [0, 25, 26]) {
      const nodes = tasks(count);
      const first = await page(nodes, { query });
      expect(Schema.is(SearchPage)(first)).toBe(true);
      expect(first.nodes.map((node) => node.id)).toEqual(
        nodes.slice(0, 25).map((node) => node.id),
      );
      expect(first.nextCursor !== null).toBe(count > 25);
      if (first.nextCursor) {
        expect(atob(first.nextCursor)).not.toContain("private");
        expect(atob(first.nextCursor)).not.toContain(query);
        const last = await page(nodes, { query, cursor: first.nextCursor });
        expect(last.nodes.map((node) => node.id)).toEqual(["task-25"]);
        expect(last.nextCursor).toBeNull();
      }
    }
  });

  test("small pages continue in outline order despite snapshot arrival order", async () => {
    const nodes = tasks(5).reverse();
    const input = { query: "is:todo", limit: 2 };
    const first = await page(nodes, input);
    expect(first.nodes.map((node) => node.id)).toEqual(["task-0", "task-1"]);
    if (!first.nextCursor) throw new Error("Expected continuation");
    const second = await page([...nodes].reverse(), {
      ...input,
      cursor: first.nextCursor,
    });
    expect(second.nodes.map((node) => node.id)).toEqual(["task-2", "task-3"]);
    if (!second.nextCursor) throw new Error("Expected continuation");
    const third = await page(nodes, { ...input, cursor: second.nextCursor });
    expect(third.nodes.map((node) => node.id)).toEqual(["task-4"]);
    expect(third.nextCursor).toBeNull();
  });

  test("visible edits, ordering, deletion, and option changes reject continuation", async () => {
    const nodes = tasks(3);
    const input = { query: "is:todo", limit: 1 };
    const first = await page(nodes, input);
    if (!first.nextCursor) throw new Error("Expected continuation");
    const continued = { ...input, cursor: first.nextCursor };
    for (const changes of [
      { text: "Changed" },
      { completed: true },
      { origin: "Agent" },
      { isTask: false },
      { kind: "paragraph" as const },
      { mirrorOf: "task-1" },
      { parentId: "task-1" },
      { prevSiblingId: "task-2" },
    ]) {
      const changed = nodes.map((node) =>
        node.id === "task-0" ? { ...node, ...changes } : node,
      );
      await expect(page(changed, continued)).rejects.toThrow("Restart");
    }
    await expect(page(nodes.slice(1), continued)).rejects.toThrow("Restart");
    for (const options of [
      { query: "#dotflowy" },
      { limit: 2 },
      { nodeId: "task-1" },
    ]) {
      await expect(page(nodes, { ...continued, ...options })).rejects.toThrow(
        "Restart",
      );
    }
    const scopedNodes = [
      createNode({ id: "scope", text: "Project" }),
      ...nodes.map((node) => ({ ...node, parentId: "scope" })),
    ];
    const scopedInput = { ...input, nodeId: "scope" };
    const scoped = await page(scopedNodes, scopedInput);
    if (!scoped.nextCursor) throw new Error("Expected scoped continuation");
    await expect(
      page(nodes, {
        ...scopedInput,
        cursor: scoped.nextCursor,
      }),
    ).rejects.toThrow("restart without the cursor");
  });

  test("spoiler-only changes and non-search view state keep continuation valid", async () => {
    const nodes = tasks(3);
    const input = { query: "is:todo", limit: 1 };
    const first = await page(nodes, input);
    if (!first.nextCursor) throw new Error("Expected continuation");
    const changed = nodes.map((node) => ({
      ...node,
      text: node.text.replace(
        /private-\d+/,
        "a different secret #tag ==🔴highlight==",
      ),
      updatedAt: 900,
      collapsed: true,
      bookmarkedAt: 100,
    }));
    const second = await page(changed, { ...input, cursor: first.nextCursor });
    expect(second.nodes.map((node) => node.id)).toEqual(["task-1"]);
    expect(second.nodes[0]?.text).toBe("Task 1 #dotflowy [spoiler]");
  });

  test("missing roots and malformed or out-of-range cursors are explicit failures", async () => {
    const nodes = tasks(2);
    await expect(
      page(nodes, { query: "is:todo", nodeId: "missing" }),
    ).rejects.toThrow("not found");
    for (const cursor of [
      "",
      "not-base64",
      btoa("{}"),
      btoa('{"version":2,"offset":1,"fingerprint":"x"}'),
    ]) {
      await expect(page(nodes, { query: "is:todo", cursor })).rejects.toThrow(
        "Invalid search cursor",
      );
    }
    const first = await page(nodes, { query: "is:todo", limit: 1 });
    if (!first.nextCursor) throw new Error("Expected continuation");
    const forged = { ...JSON.parse(atob(first.nextCursor)), offset: 999 };
    await expect(
      page(nodes, {
        query: "is:todo",
        limit: 1,
        cursor: btoa(JSON.stringify(forged)),
      }),
    ).rejects.toThrow("Invalid search cursor");
    for (const limit of [0, 101, 1.5])
      expect(Schema.is(SearchInput)({ query: "x", limit })).toBe(false);
    expect(Schema.is(SearchInput)({ query: "x", limit: 100 })).toBe(true);
  });
});
