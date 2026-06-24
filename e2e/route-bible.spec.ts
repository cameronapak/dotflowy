import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Route Bible plugin (ADR 0026): a Scripture reference in node.text renders as a
// non-folding chip (Seam A) that opens route.bible on click (Seam B). Detection
// is liberal-regex-PROPOSES / grab-bcv-parser-DISPOSES, so a valid reference
// chips and a non-reference falls through to plain text. Unlike a rich link the
// chip does NOT fold/reveal -- its text equals its source whether focused or not.

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .node-text`);

const chip = (page: Page, id: string) =>
  text(page, id).locator("span[data-bible-ref]");

async function load(page: Page, tree: SeedNode[]) {
  // Capture window.open so we can assert click-to-open without a real popup.
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

const opened = (page: Page) =>
  page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

test.describe("Scripture reference chips", () => {
  test("a chapter:verse reference chips with the resolver URL; a non-reference stays plain text", async ({
    page,
  }) => {
    await load(page, [
      { id: "ref", parentId: null, prevSiblingId: null, text: "Read John 3:16 today" },
      { id: "noref", parentId: null, prevSiblingId: "ref", text: "just some text 3" },
    ]);

    // The reference is a single chip showing its verbatim source...
    await expect(chip(page, "ref")).toHaveText("John 3:16");
    // ...linking to the canonical route.bible URL (lowercased OSIS + attribution).
    await expect(chip(page, "ref")).toHaveAttribute(
      "data-href",
      "https://route.bible/jhn.3.16?src=dotflowy",
    );

    // The plugin styles seam (ADR 0027) actually delivered the plugin's CSS: a
    // bare span defaults to `inline`, so `inline-block` proves `.bible-ref` from
    // the mounted <PluginStyles> applied (not core styles.css).
    await expect(chip(page, "ref")).toHaveCSS("display", "inline-block");

    // A book-like word + number that isn't a real reference never chips (the
    // parser gate rejects it).
    await expect(chip(page, "noref")).toHaveCount(0);
    await expect(text(page, "noref")).toHaveText("just some text 3");
  });

  test("a whole-chapter reference (no verse) also chips", async ({ page }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "See Genesis 1 for the start" },
    ]);

    await expect(chip(page, "n")).toHaveText("Genesis 1");
    await expect(chip(page, "n")).toHaveAttribute(
      "data-href",
      "https://route.bible/gen.1?src=dotflowy",
    );
  });

  test("multiple references on one line each chip independently", async ({
    page,
  }) => {
    await load(page, [
      {
        id: "n",
        parentId: null,
        prevSiblingId: null,
        text: "Compare John 3:16 with Romans 8:28",
      },
    ]);

    const chips = chip(page, "n");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveText("John 3:16");
    await expect(chips.nth(1)).toHaveText("Romans 8:28");
  });

  test("clicking a chip opens its route.bible URL in a new tab", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: "1 Cor 13:4-7" },
    ]);

    await chip(page, "n").click();

    expect(await opened(page)).toEqual([
      "https://route.bible/1co.13.4-7?src=dotflowy",
    ]);
  });
});
