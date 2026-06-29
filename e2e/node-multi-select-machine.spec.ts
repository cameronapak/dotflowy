import { expect, test, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Parity proof for the XState v6 selection backend (ADR 0018 + the XState/Effect
// PoC in `.scratch/xstate-effect-schema/`). Same scenarios as a representative
// slice of `node-multi-select.spec.ts`, but with the `selection-machine` flag ON
// -- so the selection model is driven by the Effect-Schema-typed actor instead
// of the module singleton. The behavior (edges, depth-walk, Cmd+A ladder, batch
// delete) must be identical: the backends share the tree logic + range math, and
// this asserts the actor's storage + per-row edge derivation + subscription wire
// up the same DOM.

const FLAT: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "alpha" },
  { id: "b", parentId: null, prevSiblingId: "a", text: "bravo" },
  { id: "c", parentId: null, prevSiblingId: "b", text: "charlie" },
  { id: "d", parentId: null, prevSiblingId: "c", text: "delta" },
];

const CHAIN: SeedNode[] = [
  { id: "a", parentId: null, prevSiblingId: null, text: "alpha" },
  { id: "aa", parentId: "a", prevSiblingId: null, text: "alphaalpha" },
  { id: "aaa", parentId: "aa", prevSiblingId: null, text: "alphaalphaalpha" },
];

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .node-text`);
const li = (page: Page, id: string) => page.locator(`li[data-node-id="${id}"]`);
const focused = (page: Page) => page.locator(".node-text:focus");
const orderedTexts = (page: Page) =>
  page.locator(".outline-row > .node-text").allTextContents();
const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function load(page: Page, tree: SeedNode[] = FLAT) {
  await seedOutline(page, tree);
  // Flip on the XState selection backend before any app script runs.
  await page.addInitScript(() =>
    localStorage.setItem("dotflowy:flag:selection-machine", "on"),
  );
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

async function focus(page: Page, id: string) {
  await text(page, id).click();
  await expect(text(page, id)).toBeFocused();
}

test.describe("Node multi-selection (XState backend)", () => {
  test("first Shift+arrow selects only the focused node; the second extends", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "d");

    await page.keyboard.press("Shift+ArrowUp");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "single");
    await expect(li(page, "c")).not.toHaveAttribute("data-selected", /.*/);
    await expect(focused(page)).toHaveCount(0);

    await page.keyboard.press("Shift+ArrowUp");
    await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
  });

  test("Shift+Down extends to a middle edge, Shift+Up shrinks toward the anchor", async ({
    page,
  }) => {
    await load(page);
    await focus(page, "a");

    await page.keyboard.press("Shift+ArrowDown"); // enter -> [a]
    await expect(li(page, "a")).toHaveAttribute("data-selected", "single");
    await expect(focused(page)).toHaveCount(0);

    await page.keyboard.press("Shift+ArrowDown"); // [a, b]
    await page.keyboard.press("Shift+ArrowDown"); // [a, b, c]
    await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "b")).toHaveAttribute("data-selected", "middle");
    await expect(li(page, "c")).toHaveAttribute("data-selected", "bottom");

    await page.keyboard.press("Shift+ArrowUp"); // shrink -> [a, b]
    await expect(li(page, "b")).toHaveAttribute("data-selected", "bottom");
    await expect(li(page, "c")).not.toHaveAttribute("data-selected", /.*/);
  });

  test("single-root selection climbs to the parent and dives back into the child", async ({
    page,
  }) => {
    await load(page, CHAIN);
    await focus(page, "aaa");

    await page.keyboard.press("Shift+ArrowUp"); // [aaa]
    await expect(li(page, "aaa")).toHaveAttribute("data-selected", "single");

    await page.keyboard.press("Shift+ArrowUp"); // climb -> [aa]
    await expect(li(page, "aa")).toHaveAttribute("data-selected", "single");
    await expect(li(page, "aaa")).not.toHaveAttribute("data-selected", /.*/);

    await page.keyboard.press("Shift+ArrowUp"); // climb -> [a]
    await expect(li(page, "a")).toHaveAttribute("data-selected", "single");

    await page.keyboard.press("Shift+ArrowDown"); // dive -> [aa]
    await expect(li(page, "aa")).toHaveAttribute("data-selected", "single");
    await expect(li(page, "a")).not.toHaveAttribute("data-selected", /.*/);
  });

  test("Cmd+A ladder: node -> whole view", async ({ page }) => {
    await load(page);
    await focus(page, "a");

    await page.keyboard.press(`${MOD}+a`); // rung 1: text (native)
    await expect(li(page, "a")).not.toHaveAttribute("data-selected", /.*/);

    await page.keyboard.press(`${MOD}+a`); // rung 2: this node
    await expect(li(page, "a")).toHaveAttribute("data-selected", "single");

    await page.keyboard.press(`${MOD}+a`); // rung 3: whole view
    await expect(li(page, "a")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
  });

  test("Escape clears the selection and returns the caret", async ({ page }) => {
    await load(page);
    await focus(page, "b");
    await page.keyboard.press("Shift+ArrowDown"); // [b]
    await expect(li(page, "b")).toHaveAttribute("data-selected", "single");

    await page.keyboard.press("Escape");
    await expect(li(page, "b")).not.toHaveAttribute("data-selected", /.*/);
    await expect(text(page, "b")).toBeFocused();
  });

  test("Backspace deletes the selected run in one batch", async ({ page }) => {
    await load(page);
    await focus(page, "b");
    await page.keyboard.press("Shift+ArrowDown"); // [b]
    await page.keyboard.press("Shift+ArrowDown"); // [b, c]
    await expect(li(page, "b")).toHaveAttribute("data-selected", "top");

    await page.keyboard.press("Backspace");
    await expect(li(page, "b")).toHaveCount(0);
    await expect(li(page, "c")).toHaveCount(0);
    await expect(li(page, "a")).toBeVisible();
    await expect(li(page, "d")).toBeVisible();
  });

  // The relocate-run path (`refreshSelection`) is the one place `parentId`
  // mutates: an indent/outdent moves the selected run under a new parent and the
  // selection must follow. It's the only public op the other scenarios don't
  // touch, so cover it explicitly under the actor backend -- a machine-specific
  // regression here would otherwise ship green (the singleton spec runs flag-off).
  test("Tab indents the selected run under the previous sibling; Shift+Tab outdents it back", async ({
    page,
  }) => {
    await load(page); // FLAT: alpha, bravo, charlie, delta
    await focus(page, "d");
    await page.keyboard.press("Shift+ArrowUp"); // enter -> [d]
    await page.keyboard.press("Shift+ArrowUp"); // extend -> [c, d] -- anchor d, focus c
    await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");

    // Tab: c and d become children of b, in order, and STAY selected -- the actor
    // re-derives the run under the new parent (`refreshSelection`).
    await page.keyboard.press("Tab");
    await expect(
      page.locator('li[data-node-id="c"][data-parent-id="b"]'),
    ).toBeVisible();
    await expect(
      page.locator('li[data-node-id="d"][data-parent-id="b"]'),
    ).toBeVisible();
    await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
    // Only alpha + bravo remain at the top level now.
    await expect(
      page.locator("li[data-node-id]:not([data-parent-id])"),
    ).toHaveCount(2);

    // Shift+Tab: outdent back to the top level, right after b, still selected.
    await page.keyboard.press("Shift+Tab");
    await expect(
      page.locator("li[data-node-id]:not([data-parent-id])"),
    ).toHaveCount(4);
    await expect(li(page, "c")).toHaveAttribute("data-selected", "top");
    await expect(li(page, "d")).toHaveAttribute("data-selected", "bottom");
    expect(await orderedTexts(page)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
  });
});
