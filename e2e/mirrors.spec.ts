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
  page.locator(`li[data-node-id="${nodeId}"] > .outline-row > .node-text`);

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
