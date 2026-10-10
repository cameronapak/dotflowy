import { expect, test, type Page } from "@playwright/test";

import { placeCaret, seedOutline, text, type SeedNode } from "./fixtures";

const TREE: SeedNode[] = [
  { id: "root", parentId: null, prevSiblingId: null, text: "Lock root" },
  { id: "child", parentId: "root", prevSiblingId: null, text: "Child" },
  { id: "sibling", parentId: null, prevSiblingId: "root", text: "Sibling" },
];

const row = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row`);

test("locking a node makes its subtree read-only while view state stays mutable", async ({
  page,
}) => {
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(text(page, "root")).toBeVisible({ timeout: 15_000 });

  await placeCaret(text(page, "root"), "end");
  await page.keyboard.type(" /lock");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(text(page, "root")).toHaveAttribute("contenteditable", "false");
  await expect(text(page, "child")).toHaveAttribute("contenteditable", "false");
  await expect(text(page, "root")).toHaveAttribute("aria-readonly", "true");
  await expect(row(page, "root").getByLabel("Locked subtree")).toBeVisible();
  await expect(row(page, "child").getByLabel("Locked subtree")).toBeVisible();

  await row(page, "root").getByRole("button", { name: "Collapse" }).click();
  await expect(text(page, "child")).toBeHidden();
  await row(page, "root").getByRole("button", { name: "Expand" }).click();
  await expect(text(page, "child")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("option", { name: /^Unlock/ }).click();
  await expect(text(page, "root")).toHaveAttribute("contenteditable", "true");
  await expect(text(page, "child")).toHaveAttribute("contenteditable", "true");
});

test("a persisted lock remains focusable and exposes both unlock palettes", async ({
  page,
}) => {
  await seedOutline(
    page,
    TREE.map((node) => (node.id === "root" ? { ...node, locked: true } : node)),
  );
  await page.goto("/");
  await expect(text(page, "root")).toBeVisible({ timeout: 15_000 });

  await text(page, "root").click();
  await expect(text(page, "root")).toBeFocused();
  await page.keyboard.press("/");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.getByRole("option", { name: /^Unlock/ }).click();
  await expect(text(page, "root")).toHaveAttribute("contenteditable", "true");

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("option", { name: /^Lock/ }).click();
  await expect(text(page, "root")).toHaveAttribute("contenteditable", "false");

  await text(page, "sibling").click();
  await text(page, "root").click();
  await expect(text(page, "root")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("option", { name: /^Unlock/ }).click();
  await expect(text(page, "root")).toHaveAttribute("contenteditable", "true");
});
