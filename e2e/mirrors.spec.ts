import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Node mirrors (ADR 0022), slice 1b: render + field split. A node carrying
// `mirrorOf` windows its source's text + children; all instances are editable
// and text-synced. These specs SEED a mirror (creation is slice 1c) and prove
// the rendered behavior behind the flag, plus flag-off parity.
//
// Tree (display order, flag on, nothing collapsed):
//   A  "alpha source"
//     a1 "alpha child one"
//     a2 "alpha child two"
//   P  "project"
//     M  "mirror placeholder"  (mirrorOf=A)  -> windows a1, a2
//
// So `a1`/`a2` each appear twice: once under the real source A, once under the
// mirror M. The mirror row M itself shows A's text, not "mirror placeholder".
const MIRROR_TREE: SeedNode[] = [
  { id: "A", parentId: null, prevSiblingId: null, text: "alpha source" },
  { id: "P", parentId: null, prevSiblingId: "A", text: "project" },
  { id: "a1", parentId: "A", prevSiblingId: null, text: "alpha child one" },
  { id: "a2", parentId: "A", prevSiblingId: "a1", text: "alpha child two" },
  { id: "M", parentId: "P", prevSiblingId: null, text: "mirror placeholder", mirrorOf: "A" },
];

const text = (page: Page, nodeId: string) =>
  page.locator(`li[data-node-id="${nodeId}"] > .outline-row .node-text`);

async function load(page: Page, tree: SeedNode[], mirrors: boolean) {
  await page.addInitScript(() => {
    localStorage.setItem("dotflowy:flag:virtualized", "on");
  });
  if (mirrors) {
    await page.addInitScript(() => {
      localStorage.setItem("dotflowy:flag:mirrors", "on");
    });
  }
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, "A")).toBeVisible();
}

test.describe("node mirrors -- render + field split (ADR 0022)", () => {
  test("a mirror windows its source's text and children", async ({ page }) => {
    await load(page, MIRROR_TREE, true);

    // The mirror row reads the SOURCE's content, not its own placeholder text.
    await expect(text(page, "M")).toHaveText("alpha source");
    await expect(page.locator('li[data-node-id="M"]')).toHaveAttribute(
      "data-mirror",
      "instance",
    );

    // The source's children appear under the mirror too: a1/a2 each render twice
    // (once under real A, once under M). Distinct render keys, same node id.
    await expect(page.locator('li[data-node-id="a1"]')).toHaveCount(2);
    await expect(page.locator('li[data-node-id="a2"]')).toHaveCount(2);
    await expect(
      page.locator('li[data-node-id="a1"] .node-text', {
        hasText: "alpha child one",
      }),
    ).toHaveCount(2);
  });

  test("editing the source updates the mirror live, and vice versa", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, true);
    await expect(text(page, "M")).toHaveText("alpha source");

    // Type into the SOURCE -> the mirror reflects it (one client, no reload).
    await text(page, "A").click();
    await page.keyboard.type("XYZ");
    await expect(text(page, "A")).toContainText("XYZ");
    await expect(text(page, "M")).toContainText("XYZ");

    // Type into the MIRROR -> the source reflects it. Editing a mirror writes
    // the source (commands.onTextChange(content.id, ...)).
    await text(page, "M").click();
    await page.keyboard.type("QQQ");
    await expect(text(page, "M")).toContainText("QQQ");
    await expect(text(page, "A")).toContainText("QQQ");
  });

  test("the source's completed state shows through the mirror", async ({
    page,
  }) => {
    const completedTree = MIRROR_TREE.map((n) =>
      n.id === "A" ? { ...n, completed: true } : n,
    );
    await load(page, completedTree, true);

    // data-completed lives on the node-text and bullet-dot; the mirror reads it
    // from the source, so checking the source off strikes through every instance.
    await expect(text(page, "A")).toHaveAttribute("data-completed", "true");
    await expect(text(page, "M")).toHaveAttribute("data-completed", "true");
  });

  test("collapse is local: collapsing the mirror hides only its windowed children", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, true);
    await expect(page.locator('li[data-node-id="a1"]')).toHaveCount(2);

    // Collapse the MIRROR via its own chevron -> its windowed copy of a1/a2
    // disappears, but the real source A stays expanded (one copy remains).
    await page
      .locator('li[data-node-id="M"] > .outline-row > .collapse-toggle')
      .click();
    await expect(page.locator('li[data-node-id="a1"]')).toHaveCount(1);
    // The surviving copy is the real one, under the source.
    await expect(text(page, "A")).toBeVisible();
    await expect(page.locator('li[data-node-id="a2"]')).toHaveCount(1);
  });

  test("a broken mirror (missing source) renders a leaf, never hangs", async ({
    page,
  }) => {
    const brokenTree: SeedNode[] = [
      { id: "P", parentId: null, prevSiblingId: null, text: "project" },
      {
        id: "M",
        parentId: "P",
        prevSiblingId: null,
        text: "mirror placeholder",
        mirrorOf: "ghost",
      },
    ];
    await page.addInitScript(() => {
      localStorage.setItem("dotflowy:flag:virtualized", "on");
      localStorage.setItem("dotflowy:flag:mirrors", "on");
    });
    await seedOutline(page, brokenTree);
    await page.goto("/");

    const broken = page.locator('li[data-node-id="M"]');
    await expect(broken).toBeVisible();
    await expect(broken).toHaveAttribute("data-mirror", "broken");
    await expect(broken).toContainText("source not found");
  });

  test("flag OFF: a mirrorOf node renders as a plain leaf (parity)", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, false);

    // With mirrors disabled, M is an ordinary node: its own text, no windowing.
    await expect(text(page, "M")).toHaveText("mirror placeholder");
    await expect(page.locator('li[data-node-id="M"]')).not.toHaveAttribute(
      "data-mirror",
      /.*/,
    );
    // a1/a2 appear exactly once -- only under the real source.
    await expect(page.locator('li[data-node-id="a1"]')).toHaveCount(1);
    await expect(page.locator('li[data-node-id="a2"]')).toHaveCount(1);
  });
});

// Slice 1c: creating a mirror via the `/mirror` destination picker (reuses the
// `/move` dialog in mirror mode). Source A (children a1/a2) + a bookmarked
// destination box D.
const CREATE_TREE: SeedNode[] = [
  { id: "A", parentId: null, prevSiblingId: null, text: "alpha source" },
  {
    id: "D",
    parentId: null,
    prevSiblingId: "A",
    text: "dest box",
    bookmarkedAt: 100,
  },
  { id: "a1", parentId: "A", prevSiblingId: null, text: "alpha child one" },
  { id: "a2", parentId: "A", prevSiblingId: "a1", text: "alpha child two" },
];

// Open the CORE `/mirror` picker for a node the way a user does: focus the
// bullet, type the slash command (a leading space so `detectSlash` fires), then
// click the core option -- disambiguated from daily's "Mirror to Today" by its
// unique description ("...another node"). Mirrors openMove in move-dialog.spec.
async function openMirror(page: Page, id: string) {
  await text(page, id).click();
  await expect(text(page, id)).toBeFocused();
  await page.keyboard.type(" /mirror");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: /another node/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("node mirrors -- create via the picker (ADR 0022)", () => {
  test("/mirror creates a live copy under the chosen destination", async ({
    page,
  }) => {
    await load(page, CREATE_TREE, true);
    await openMirror(page, "A");

    // Pick the bookmarked destination from the empty-query state.
    await page
      .getByRole("dialog")
      .getByRole("option", { name: "dest box" })
      .click();
    await expect(page.getByText("Mirrored to dest box")).toBeVisible();

    // A new mirror instance now lives under D, windowing A's text + children.
    const mirror = page.locator('li[data-mirror="instance"]');
    await expect(mirror).toHaveCount(1);
    await expect(mirror).toHaveAttribute("data-parent-id", "D");
    await expect(mirror.locator("> .outline-row .node-text")).toContainText(
      "alpha source",
    );
    // a1/a2 now each render twice: under real A, and under the new mirror.
    await expect(page.locator('li[data-node-id="a1"]')).toHaveCount(2);
    await expect(page.locator('li[data-node-id="a2"]')).toHaveCount(2);
  });

  test("the picker excludes the source's own subtree (cycle guard)", async ({
    page,
  }) => {
    // Bookmark a1 (a child of A) so it WOULD surface in the empty-query picker --
    // but mirroring A into its own child would cycle, so it must be excluded.
    const tree: SeedNode[] = [
      { id: "A", parentId: null, prevSiblingId: null, text: "alpha source" },
      {
        id: "D",
        parentId: null,
        prevSiblingId: "A",
        text: "dest box",
        bookmarkedAt: 100,
      },
      {
        id: "a1",
        parentId: "A",
        prevSiblingId: null,
        text: "alpha child one",
        bookmarkedAt: 200,
      },
    ];
    await load(page, tree, true);
    await openMirror(page, "A");

    const dialog = page.getByRole("dialog");
    // D is offered; the source's own child a1 is not (it would cycle).
    await expect(dialog.getByRole("option", { name: "dest box" })).toBeVisible();
    await expect(
      dialog.getByRole("option", { name: "alpha child one" }),
    ).toHaveCount(0);
  });
});

// Slice 1d: mirror chrome -- the "appears in N places" badge, the source/instance
// border attribute, the places jump list, and the Cmd+K dedup. Seeded directly
// (the MIRROR_TREE from above: source A with one mirror M under P).
test.describe("node mirrors -- chrome (ADR 0022)", () => {
  test("the source and the instance both show the 'appears in N places' badge", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, true);

    // A is the source of exactly one mirror, so the content appears in 2 places.
    // The badge shows the total (2) on BOTH the source row and the mirror row.
    const sourceBadge = page.locator(
      'li[data-node-id="A"] > .outline-row .mirror-badge',
    );
    const mirrorBadge = page.locator(
      'li[data-node-id="M"] > .outline-row .mirror-badge',
    );
    await expect(sourceBadge).toHaveText("2");
    await expect(mirrorBadge).toHaveText("2");

    // The source row carries data-mirror="source" (its colored edge); the mirror
    // row stays "instance".
    await expect(page.locator('li[data-node-id="A"]')).toHaveAttribute(
      "data-mirror",
      "source",
    );
    await expect(page.locator('li[data-node-id="M"]')).toHaveAttribute(
      "data-mirror",
      "instance",
    );
  });

  test("clicking the badge opens the places list and jumps to the source", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, true);

    await page
      .locator('li[data-node-id="A"] > .outline-row .mirror-badge')
      .click();

    // The jump list opens, titled with the place count, listing a Source row and
    // a Mirror row.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Appears in 2 places")).toBeVisible();
    await expect(dialog.getByText("Source", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Mirror", { exact: true })).toBeVisible();

    // Picking "Source" zooms into A -- it becomes the page title.
    await dialog.getByText("Source", { exact: true }).click();
    await expect(page).toHaveURL(/\/A$/);
    await expect(page.locator("h2.zoomed-title")).toContainText("alpha source");
  });

  test("flag OFF: no badge, no data-mirror attribute (parity)", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, false);

    await expect(page.locator(".mirror-badge")).toHaveCount(0);
    await expect(page.locator('li[data-node-id="A"]')).not.toHaveAttribute(
      "data-mirror",
      /.*/,
    );
  });
});

// Slice 2b: caret nav across the mirror boundary. Arrow Up/Down walks ROW KEYS
// (visible-order's path address), so pressing Down from a mirror enters the
// mirror's OWN windowed copy of the source's children -- never the source's real
// row elsewhere in the view. Same MIRROR_TREE (A + a1/a2; P > M -> A); visible
// order is A, a1, a2, P, M, then M's windowed a1, a2.
test.describe("node mirrors -- caret nav (ADR 0022)", () => {
  // Both copies of a source child share data-node-id AND data-parent-id (they are
  // the same instance node, rendered at two paths), so they're indistinguishable
  // by attribute. Document order IS the flat visible order, so nth(0) is the real
  // row under the source and nth(1) is the windowed copy under the mirror.
  const a1Copies = (page: Page) =>
    page.locator('li[data-node-id="a1"] > .outline-row .node-text');
  const a2Copies = (page: Page) =>
    page.locator('li[data-node-id="a2"] > .outline-row .node-text');

  test("ArrowDown from a mirror enters its windowed child, not the source's row", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, true);
    await expect(a1Copies(page)).toHaveCount(2);

    await text(page, "M").click();
    await expect(text(page, "M")).toBeFocused();
    await page.keyboard.press("ArrowDown");

    // Focus crossed into the mirror's OWN a1 (the row just below M), not the
    // source's real a1 (which sits far above, under A).
    await expect(a1Copies(page).nth(1)).toBeFocused();
    await expect(a1Copies(page).nth(0)).not.toBeFocused();
    // Decisive anti-teleport check: the focused row sits BELOW M (the windowed
    // child), not above it where the source's real a1 lives.
    const mBox = await text(page, "M").boundingBox();
    const focusedBox = await page.locator(":focus").boundingBox();
    expect(focusedBox!.y).toBeGreaterThan(mBox!.y);
  });

  test("arrow nav walks between windowed instances and back to the mirror", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, true);

    await text(page, "M").click();
    await page.keyboard.press("ArrowDown"); // M -> windowed a1
    await expect(a1Copies(page).nth(1)).toBeFocused();
    await page.keyboard.press("ArrowDown"); // -> windowed a2
    await expect(a2Copies(page).nth(1)).toBeFocused();

    // a2 is the last visible row: Down holds focus, never teleports to the source.
    await page.keyboard.press("ArrowDown");
    await expect(a2Copies(page).nth(1)).toBeFocused();

    // Back up: windowed a2 -> windowed a1 -> M.
    await page.keyboard.press("ArrowUp");
    await expect(a1Copies(page).nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(text(page, "M")).toBeFocused();
  });
});
