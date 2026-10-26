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

  const rootTextbox = row(page, "root").getByRole("textbox");
  await expect(rootTextbox).toHaveText("Lock root");
  await placeCaret(text(page, "root"), "end");
  await page.keyboard.type(" /lock");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Enter");

  const cdp = await page.context().newCDPSession(page);
  const readonlyTextbox = async (name: string) => {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const textbox = nodes.find(
      (node) =>
        node.role?.value === "textbox" && node.name?.value.trim() === name,
    );
    return {
      value: textbox?.value?.value.trim(),
      readonly: textbox?.properties?.find((prop) => prop.name === "readonly")
        ?.value.value,
    };
  };
  await expect
    .poll(() => readonlyTextbox("Lock root"))
    .toEqual({
      value: "Lock root",
      readonly: true,
    });
  await expect(text(page, "root")).toHaveAttribute("contenteditable", "false");
  await expect(text(page, "child")).toHaveAttribute("contenteditable", "false");
  await expect(text(page, "root")).toHaveAttribute("aria-readonly", "true");
  await expect(row(page, "root").getByLabel("Locked subtree")).toBeVisible();
  await expect(row(page, "child").getByLabel("Locked subtree")).toBeVisible();

  const disclosure = (expanded: boolean) =>
    row(page, "root").getByRole("button", {
      name: expanded ? "Collapse" : "Expand",
      expanded,
    });
  await expect(
    row(page, "child").getByRole("button", { name: /^(Expand|Collapse)$/ }),
  ).toHaveCount(0);
  await disclosure(true).click();
  await expect(text(page, "child")).toBeHidden();
  await expect(disclosure(false)).toBeAttached();

  // Filtering opens matching descendants without changing saved collapse state.
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByRole("combobox", { name: "Filter query" }).fill("Child");
  await expect(text(page, "child")).toBeVisible();
  await expect(disclosure(true)).toBeAttached();
  await page.getByRole("combobox", { name: "Filter query" }).fill("");
  await expect(text(page, "child")).toBeHidden();
  await disclosure(false).click();
  await expect(text(page, "child")).toBeVisible();

  await row(page, "root").getByRole("button", { name: "Zoom in" }).click();
  const title = page.getByRole("heading", { level: 2 }).getByRole("textbox", {
    name: "Title",
  });
  await expect(title).toHaveText("Lock root");
  await expect
    .poll(() => readonlyTextbox("Title"))
    .toEqual({
      value: "Lock root",
      readonly: true,
    });
  await title.focus();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("option", { name: /^Unlock/ }).click();
  await expect(title).toHaveAttribute("contenteditable", "true");
  await expect(text(page, "child")).toHaveAttribute("contenteditable", "true");
  await expect
    .poll(() => readonlyTextbox("Title"))
    .toEqual({
      value: "Lock root",
      readonly: false,
    });
  await cdp.detach();
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
