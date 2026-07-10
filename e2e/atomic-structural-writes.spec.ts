import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

// Regression suite for the atomic-structural-writes cure (PLAN.md):
//  - P1: one structural edit = exactly ONE /api/nodes request carrying every op.
//  - P2: under an echo delay, rapid structural edits never persist a broken
//    sibling chain (the "fan"/"dangle" corruption the cure exists to prevent).

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

interface NodeOp {
  op: "insert" | "update" | "delete";
  value?: { id: string; parentId: string | null; prevSiblingId: string | null };
  key?: string;
}
interface NodesWrite {
  method: string;
  ops?: NodeOp[];
  nodes?: unknown[];
}

/** Record every mutating /api/nodes request the client sends. */
function captureNodesWrites(page: Page): NodesWrite[] {
  const writes: NodesWrite[] = [];
  page.on("request", (req) => {
    if (
      req.url().includes("/api/nodes") &&
      ["POST", "PATCH", "DELETE"].includes(req.method())
    ) {
      const body = (req.postDataJSON() ?? {}) as {
        ops?: NodeOp[];
        nodes?: unknown[];
      };
      writes.push({ method: req.method(), ops: body.ops, nodes: body.nodes });
    }
  });
  return writes;
}

// Drop the caret at the END of `id` (mirrors caretAt in enter-split.spec.ts:
// Home/End/arrows are unreliable in macOS Chromium contentEditable).
async function caretAtEnd(page: Page, id: string) {
  await text(page, id).click();
  await text(page, id).evaluate((el) => {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

// True iff every parent's children form one clean prevSiblingId linked list (the
// invariant a move relies on). Same shape as sibling-chain-repair.spec.ts.
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

/** Replay captured batch writes over the seed to get the persisted node set. */
function applyWrites(seed: SeedNode[], writes: NodesWrite[]): SeedNode[] {
  const byId = new Map<string, SeedNode>(seed.map((n) => [n.id, { ...n }]));
  for (const w of writes) {
    for (const op of w.ops ?? []) {
      if (op.op === "delete") byId.delete(op.key!);
      else if (op.value) {
        const v = op.value;
        byId.set(v.id, {
          id: v.id,
          parentId: v.parentId,
          prevSiblingId: v.prevSiblingId,
          text: byId.get(v.id)?.text ?? "",
        });
      }
    }
  }
  return [...byId.values()];
}

test.describe("atomic structural writes", () => {
  test("a structural edit is exactly one /api/nodes batch request (P1)", async ({
    page,
  }) => {
    const writes = captureNodesWrites(page);
    await seedOutline(page, STANDARD_TREE);
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible();

    // Enter at the end of an expanded parent dives in: insertChildAtStart(alpha)
    // INSERTS a new head child AND REPOINTS the old head (alpha-1) -- the exact
    // insert-and-repoint that used to tear into a POST + a PATCH. Clear the log
    // first so only this op's writes are measured.
    await caretAtEnd(page, "alpha");
    writes.length = 0;
    await page.keyboard.press("Enter");

    // A new child appeared under alpha (the op landed) -- a focused bullet whose
    // data-parent-id is alpha (the flat render has no nested <ul>; ADR 0019).
    await expect(
      page.locator(
        'li[data-parent-id="alpha"] > .outline-row .node-text:focus',
      ),
    ).toBeVisible();

    // Exactly one request, and it is the atomic batch (POST {ops}), never a
    // separate PATCH/DELETE or the legacy {nodes} upsert.
    await expect.poll(() => writes.length).toBe(1);
    const only = writes[0]!;
    expect(only.method).toBe("POST");
    expect(only.nodes).toBeUndefined();
    expect(Array.isArray(only.ops)).toBe(true);
    // insert(new child) + update(old head's prevSiblingId) = one frame.
    expect(only.ops!.length).toBe(2);
    expect(only.ops!.filter((o) => o.op === "insert")).toHaveLength(1);
    expect(only.ops!.filter((o) => o.op === "update")).toHaveLength(1);
  });

  test("rapid structural edits keep sibling chains clean across the echo gap (P2)", async ({
    page,
  }) => {
    const writes = captureNodesWrites(page);
    // A deliberate gap between each write's HTTP response and its WS echo -- the
    // window where, pre-cure, the overlay could revert and a fast follow-up read
    // a stale chain. P2 holds the overlay across it.
    await seedOutline(page, STANDARD_TREE, { echoDelayMs: 500 });
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible();

    // Two inserts in quick succession, each repointing the same follower
    // (alpha-1): Enter at end of alpha creates head child N1 (alpha-1 follows
    // N1); a second Enter on N1 creates N2 (alpha-1 follows N2). The second edit
    // MUST compute against a state that already includes the first.
    await caretAtEnd(page, "alpha");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    // Let both echoes (delayed) arrive and settle.
    await page.waitForTimeout(900);

    // Reconstruct what was actually persisted and assert the chain under every
    // parent is total and acyclic -- no fan (two siblings sharing a prev) and no
    // node orphaned off the head chain.
    const persisted = applyWrites(STANDARD_TREE, writes);
    expect(chainsAreClean(persisted)).toBe(true);
    // alpha gained exactly two children (N1, N2) on top of alpha-1/alpha-2.
    const alphaKids = persisted.filter((n) => n.parentId === "alpha");
    expect(alphaKids).toHaveLength(4);
  });

  test("structural batches never overlap on the wire, so the DO can't reorder them (P1)", async ({
    page,
  }) => {
    // P1's atomicity only holds the fan off if the DO also sees rapid batches in
    // client-call order: the seq is assigned in ARRIVAL order, and two edits that
    // both repoint the same follower would fan if the later batch landed first.
    // Separate fetches give no ordering guarantee (HTTP/2 multiplexing), so the
    // client serializes batch POSTs (api.ts `batchTail`). Prove it: with a slow
    // batch response, a second batch must not be in flight until the first lands.
    let inFlight = 0;
    let maxInFlight = 0;
    let batchCount = 0;
    const isBatch = (req: {
      url(): string;
      method(): string;
      postDataJSON(): unknown;
    }) =>
      req.url().includes("/api/nodes") &&
      req.method() === "POST" &&
      Boolean((req.postDataJSON() as { ops?: unknown } | null)?.ops);
    page.on("request", (req) => {
      if (isBatch(req)) {
        batchCount += 1;
        maxInFlight = Math.max(maxInFlight, ++inFlight);
      }
    });
    page.on("requestfinished", (req) => {
      if (isBatch(req)) inFlight -= 1;
    });

    await seedOutline(page, STANDARD_TREE, { postDelayMs: 300 });
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible();

    // Same two rapid inserts as the echo-gap test, but here we watch the wire.
    await caretAtEnd(page, "alpha");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    // Both batches settle; at no point were two batch POSTs in flight at once.
    await expect.poll(() => inFlight).toBe(0);
    // Assert TWO batches were actually observed — `maxInFlight === 1` alone
    // false-passes if the second edit silently dropped its batch.
    expect(batchCount).toBe(2);
    expect(maxInFlight).toBe(1);
  });
});
