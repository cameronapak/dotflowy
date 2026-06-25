import type { Page, Route } from "@playwright/test";
import superjson from "superjson";

// A node as the test author cares about it -- structural fields only. Everything
// the schema also requires (isTask/completed/collapsed/timestamps) is filled in
// with inert defaults by seedOutline so each test only states what matters.
export interface SeedNode {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  collapsed?: boolean;
  completed?: boolean;
  isTask?: boolean;
  /** Epoch ms when bookmarked; omit/null for an un-bookmarked node. */
  bookmarkedAt?: number | null;
}

/** A full node row as the Wasp `getNodes` query returns — real booleans, all
 *  fields present. Mirrors the client `Node` type (src/data/schema.ts). */
interface ApiNode {
  id: string;
  parentId: string | null;
  prevSiblingId: string | null;
  text: string;
  isTask: boolean;
  completed: boolean;
  collapsed: boolean;
  bookmarkedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface TagColorRow {
  tag: string;
  color: string;
}

interface DailyRow {
  key: string;
  nodeId: string;
}

function toNode(n: SeedNode): ApiNode {
  return {
    id: n.id,
    parentId: n.parentId,
    prevSiblingId: n.prevSiblingId,
    text: n.text,
    isTask: n.isTask ?? false,
    completed: n.completed ?? false,
    collapsed: n.collapsed ?? false,
    bookmarkedAt: n.bookmarkedAt ?? null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function parseArgs<T>(route: Route): T {
  const raw = route.request().postData();
  if (!raw) return {} as T;
  return superjson.parse(raw) as T;
}

function replyOp(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(superjson.serialize(data)),
  });
}

/**
 * Seed a known outline by intercepting Wasp operations with an in-memory mock,
 * so the app's TanStack DB query collection loads exactly this tree and the
 * editor's seed-if-empty effect sees a non-empty store and stays out of the way.
 *
 * Mirrors the server semantics from src/nodes/operations.ts and the plugin
 * side-collections (tag colors, daily index) — only Postgres is swapped for
 * Maps. The store is scoped to this test's `page`, so `fullyParallel` tests
 * never share state. Register before `page.goto(...)` (every spec does) so the
 * collection's first query is mocked.
 */
export async function seedOutline(page: Page, nodes: SeedNode[]): Promise<void> {
  const nodeStore = new Map<string, ApiNode>();
  for (const n of nodes) nodeStore.set(n.id, toNode(n));

  const tagColors = new Map<string, TagColorRow>();
  const dailyIndex = new Map<string, DailyRow>();

  await page.route("**/operations/get-nodes", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return replyOp(route, [...nodeStore.values()]);
  });

  await page.route("**/operations/upsert-nodes", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { nodes: incoming } = parseArgs<{ nodes: ApiNode[] }>(route);
    for (const n of incoming ?? []) nodeStore.set(n.id, n);
    return replyOp(route, undefined);
  });

  await page.route("**/operations/update-nodes", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { updates } = parseArgs<{
      updates: { id: string; changes: Partial<ApiNode> }[];
    }>(route);
    for (const u of updates ?? []) {
      const cur = nodeStore.get(u.id);
      if (cur) nodeStore.set(u.id, { ...cur, ...u.changes });
    }
    return replyOp(route, undefined);
  });

  await page.route("**/operations/delete-nodes", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { ids } = parseArgs<{ ids: string[] }>(route);
    for (const id of ids ?? []) nodeStore.delete(id);
    return replyOp(route, undefined);
  });

  await page.route("**/operations/get-tag-colors", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return replyOp(route, [...tagColors.values()]);
  });

  await page.route("**/operations/upsert-tag-colors", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { rows } = parseArgs<{ rows: TagColorRow[] }>(route);
    for (const r of rows ?? []) tagColors.set(r.tag, r);
    return replyOp(route, undefined);
  });

  await page.route("**/operations/delete-tag-colors", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { tags } = parseArgs<{ tags: string[] }>(route);
    for (const tag of tags ?? []) tagColors.delete(tag);
    return replyOp(route, undefined);
  });

  await page.route("**/operations/get-daily-index", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return replyOp(route, [...dailyIndex.values()]);
  });

  await page.route("**/operations/upsert-daily-index", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { rows } = parseArgs<{ rows: DailyRow[] }>(route);
    for (const r of rows ?? []) dailyIndex.set(r.key, r);
    return replyOp(route, undefined);
  });

  await page.route("**/operations/delete-daily-index-keys", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { keys } = parseArgs<{ keys: string[] }>(route);
    for (const key of keys ?? []) dailyIndex.delete(key);
    return replyOp(route, undefined);
  });
}

/**
 * The standard fixture used by the navigation specs:
 *
 *   - Alpha            (alpha)
 *       - Alpha one    (alpha-1)
 *       - Alpha two    (alpha-2)
 *   - Bravo            (bravo)
 *   - Charlie          (charlie)
 *
 * Visible display order when nothing is collapsed:
 *   alpha, alpha-1, alpha-2, bravo, charlie
 */
export const STANDARD_TREE: SeedNode[] = [
  { id: "alpha", parentId: null, prevSiblingId: null, text: "Alpha" },
  { id: "bravo", parentId: null, prevSiblingId: "alpha", text: "Bravo" },
  { id: "charlie", parentId: null, prevSiblingId: "bravo", text: "Charlie" },
  { id: "alpha-1", parentId: "alpha", prevSiblingId: null, text: "Alpha one" },
  { id: "alpha-2", parentId: "alpha", prevSiblingId: "alpha-1", text: "Alpha two" },
];
