import type { Page } from "@playwright/test";

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
}

const STORAGE_KEY = "dotflowy-oss:nodes";

/**
 * Write a known outline straight into localStorage before the app's JS runs, so
 * the TanStack DB collection loads exactly this tree and the editor's
 * seed-if-empty effect sees a non-empty store and stays out of the way.
 *
 * The on-disk shape is TanStack DB's LocalStorageCollection format: an object
 * keyed by `s:<id>` (the `s:` prefix marks a string key) whose values are
 * `{ versionKey, data }` -- not a plain `Node[]`. versionKey can be any string.
 */
export async function seedOutline(page: Page, nodes: SeedNode[]): Promise<void> {
  const store: Record<string, { versionKey: string; data: unknown }> = {};
  nodes.forEach((n, i) => {
    store[`s:${n.id}`] = {
      versionKey: `seed-${i}`,
      data: {
        id: n.id,
        parentId: n.parentId,
        prevSiblingId: n.prevSiblingId,
        text: n.text,
        isTask: n.isTask ?? false,
        completed: n.completed ?? false,
        collapsed: n.collapsed ?? false,
        bookmarkedAt: null,
        createdAt: 0,
        updatedAt: 0,
      },
    };
  });

  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [STORAGE_KEY, JSON.stringify(store)] as const,
  );
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
