import { expect, test } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

interface PatchUpdate {
  id: string;
  changes: { prevSiblingId?: string | null };
}

// True iff every parent's children form one clean prevSiblingId linked list:
// each child reachable from the head (prev === null) exactly once -- i.e. no two
// siblings share a prevSiblingId (a "fan") and nothing is orphaned off the
// chain. This is the invariant a move relies on; when it breaks, both keyboard
// and drag reorders silently no-op on the orphaned nodes.
function chainsAreClean(nodes: SeedNode[]): boolean {
  const byParent = new Map<string | null, SeedNode[]>();
  for (const n of nodes) {
    if (!byParent.has(n.parentId)) byParent.set(n.parentId, []);
    byParent.get(n.parentId)!.push(n);
  }
  for (const kids of byParent.values()) {
    const byPrev = new Map<string | null, SeedNode>();
    for (const k of kids) byPrev.set(k.prevSiblingId, k);
    const reached = new Set<string>();
    let cur: string | null = null;
    for (let i = 0; i < kids.length + 1; i++) {
      const next = byPrev.get(cur);
      if (!next || reached.has(next.id)) break;
      reached.add(next.id);
      cur = next.id;
    }
    if (reached.size !== kids.length) return false;
  }
  return true;
}

// Self-heal on snapshot: a persisted sibling chain that's been shattered by a
// write race (siblings sharing a prevSiblingId, pointers to non-siblings) must
// be repaired on load so every node is reorderable again. Regression guard for
// the "some bullets can't be reordered, even after refresh" bug.
test("heals a shattered sibling chain on load so every node is reorderable", async ({
  page,
}) => {
  // Mirrors the production corruption: B and C both point at A (root), so one
  // orphans out of the chain; A1/A2 both claim the head under A (a nested fan).
  const seed: SeedNode[] = [
    { id: "A", parentId: null, prevSiblingId: null, text: "alpha" },
    { id: "B", parentId: null, prevSiblingId: "A", text: "bravo" },
    { id: "C", parentId: null, prevSiblingId: "A", text: "charlie" },
    { id: "A1", parentId: "A", prevSiblingId: null, text: "a-one" },
    { id: "A2", parentId: "A", prevSiblingId: null, text: "a-two" },
  ];
  // Sanity: the seed really is broken before the heal runs.
  expect(chainsAreClean(seed)).toBe(false);

  // Accumulate every corrective PATCH the client sends to /api/nodes.
  const updates: PatchUpdate[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/nodes") && req.method() === "PATCH") {
      updates.push(
        ...(req.postDataJSON() as { updates: PatchUpdate[] }).updates,
      );
    }
  });

  await seedOutline(page, seed);
  await page.goto("/");

  // Applying the heal's pointer corrections must yield clean, fully-reachable
  // chains under every parent.
  await expect
    .poll(() => {
      const healed = seed.map((n) => ({ ...n }));
      const byId = new Map(healed.map((n) => [n.id, n]));
      for (const u of updates) {
        const node = byId.get(u.id);
        if (node && "prevSiblingId" in u.changes) {
          node.prevSiblingId = u.changes.prevSiblingId ?? null;
        }
      }
      return chainsAreClean(healed);
    })
    .toBe(true);
});
