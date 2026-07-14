import { expect, test, type Page } from "@playwright/test";

import { seedOutline, STANDARD_TREE } from "./fixtures";

// Cmd on macOS, Control elsewhere (mirrors daily-notes.spec.ts).
function modifier() {
  return process.platform === "darwin" ? "Meta" : "Control";
}

const dialog = (page: Page) =>
  page.locator('[role="dialog"][aria-label="Quick add"]');
const editor = (page: Page) =>
  page.locator(".quick-add-editor [contenteditable]");
const destChip = (page: Page) => page.locator("[data-quick-add-dest]");
const todayButton = (page: Page) =>
  page.getByRole("button", { name: "Today's daily note" });
const rowWithText = (page: Page, t: string) =>
  page.locator("li[data-node-id] > .outline-row", { hasText: t });

async function load(page: Page) {
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  await expect(
    page.locator('li[data-node-id="alpha"] > .outline-row .node-text'),
  ).toBeVisible();
}

/** Open quick-add via the global Opt+Cmd+N hotkey, then wait for the destination
 *  to resolve to Today (a kv get-or-create round-trip) before returning -- typing
 *  before it settles would race the born-in-destination decision. */
async function openQuickAdd(page: Page) {
  await page.keyboard.press("Alt+Meta+KeyN");
  await expect(dialog(page)).toBeVisible();
  await expect(destChip(page)).toHaveAttribute("data-quick-add-dest", "Today");
  await editor(page).click();
}

async function type(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.type(text);
}

// Cmd+Enter = commit & next (the rapid-fire burst key, ADR 0049 amendment):
// commits the current node, clears the editor, keeps the overlay open, appends
// to the session list. Plain Enter now commits & CLOSES.
async function commitNext(page: Page) {
  await page.keyboard.press(`${modifier()}+Enter`);
}

const toastByText = (page: Page, text: string) =>
  page.locator("[data-sonner-toast]", { hasText: text });

// The deferred-resolve test seam (ADR 0049): hold the destination resolve open
// to exercise the in-flight-born window (clear/retarget/slash while borning),
// which the seedOutline Map mock otherwise resolves in a microtask.
async function holdResolve(page: Page) {
  await page.evaluate(() =>
    (
      window as unknown as { __quickAddHoldResolve: () => void }
    ).__quickAddHoldResolve(),
  );
}
async function releaseResolve(page: Page) {
  await page.evaluate(() =>
    (
      window as unknown as { __quickAddReleaseResolve: () => void }
    ).__quickAddReleaseResolve(),
  );
}

/** The `data-parent-id` of the (first) row whose text matches, or null. */
async function parentIdOf(page: Page, text: string): Promise<string | null> {
  return rowWithText(page, text)
    .first()
    .evaluate(
      (el) =>
        el.closest("li[data-node-id]")?.getAttribute("data-parent-id") ?? null,
    );
}

test.describe("quick-add capture", () => {
  test("Opt+Cmd+N opens the overlay and Esc closes it", async ({ page }) => {
    await load(page);
    await page.keyboard.press("Alt+Meta+KeyN");
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
  });

  test("rapid-fire Cmd+Enter commits each capture as a sibling at the bottom of Today", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    await type(page, "first-capture");
    await commitNext(page);
    // Wait for the first capture to land in the session list (and the editor to
    // clear) before typing the next -- otherwise the second type() races the
    // post-commit re-render and drops keystrokes under parallel load.
    await expect(dialog(page)).toContainText("first-capture");
    await expect(editor(page)).toHaveText("");

    await type(page, "second-capture");
    await commitNext(page);

    // Cmd+Enter keeps the overlay open; the running session list proves both
    // landed without peeking at Today.
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText("first-capture");
    await expect(dialog(page)).toContainText("second-capture");

    // Close, then open Today and confirm both are children, in capture order.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await todayButton(page).click();
    await expect(page).toHaveURL(/\/[^/]+$/);

    const firstRow = rowWithText(page, "first-capture");
    const secondRow = rowWithText(page, "second-capture");
    // Capture -> Today get-or-create -> WS echo -> nav is a longer async chain
    // than a synchronous outline edit, so allow for it under parallel contention.
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await expect(secondRow).toBeVisible({ timeout: 10_000 });

    // first-capture precedes second-capture (chronological log).
    const firstIdx = await firstRow.evaluate((el) => {
      const rows = Array.from(document.querySelectorAll("li[data-node-id]"));
      return rows.indexOf(el.closest("li[data-node-id]")!);
    });
    const secondIdx = await secondRow.evaluate((el) => {
      const rows = Array.from(document.querySelectorAll("li[data-node-id]"));
      return rows.indexOf(el.closest("li[data-node-id]")!);
    });
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  test("Enter commits the single node and closes the overlay", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    await type(page, "one-and-done");
    await page.keyboard.press("Enter");

    // Enter closes (commit & close), unlike Cmd+Enter which keeps going.
    await expect(dialog(page)).toBeHidden();

    // The node still landed in Today (commit-immediately).
    await todayButton(page).click();
    await expect(rowWithText(page, "one-and-done")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("Enter shows an off-page toast whose 'Go there' zooms to the destination", async ({
    page,
  }) => {
    await load(page);
    // We're on the top-level home view, NOT on Today -- so a capture to Today is
    // off-page and must announce itself.
    await openQuickAdd(page);
    await type(page, "toasted-note");
    await page.keyboard.press("Enter");

    const toast = toastByText(page, "Added to Today");
    await expect(toast).toBeVisible({ timeout: 10_000 });

    // "Go there" zooms to Today, where the capture is waiting.
    await toast.getByRole("button", { name: "Go there" }).click();
    await expect(page).toHaveURL(/\/[^/]+$/);
    await expect(rowWithText(page, "toasted-note")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("Enter fires no toast when you're already viewing the destination", async ({
    page,
  }) => {
    await load(page);
    // Zoom into Today FIRST, so the capture lands in the view we're already on.
    await todayButton(page).click();
    await expect(page).toHaveURL(/\/[^/]+$/);

    await openQuickAdd(page);
    await type(page, "silent-note");
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeHidden();

    // On-page: the node is already on screen, so no toast interrupts.
    await expect(rowWithText(page, "silent-note")).toBeVisible({
      timeout: 10_000,
    });
    await expect(toastByText(page, "Added to")).toHaveCount(0);
  });

  test("/todo shows the checkbox inline once the capture is born", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    await type(page, "grab coffee");
    // Turn the born capture into a to-do via the slash palette.
    await page.keyboard.type(" /todo");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Enter");

    // The Seam-F checkbox now renders inline in the mini-editor (flow 3), just
    // like a normal node -- proving the third render path wires the node slots.
    await expect(
      dialog(page).locator(".quick-add-editor .checkbox"),
    ).toBeVisible();
  });

  test("progressive Escape: the first press closes an open menu, the next closes the dialog", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    // Open the `/` palette, then Escape once -- the menu closes but the dialog
    // stays (Base UI's document Escape listener is stopped while a listbox is up).
    await type(page, "note ");
    await page.keyboard.type("/");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(dialog(page)).toBeVisible();

    // A second Escape now closes the whole overlay.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
  });

  test("open + abandon (no keystroke) leaves no today note (lazy resolve)", async ({
    page,
  }) => {
    await load(page);
    await page.keyboard.press("Alt+Meta+KeyN");
    await expect(dialog(page)).toBeVisible();
    // The chip reads Today immediately (label is known without creating anything).
    await expect(destChip(page)).toHaveAttribute(
      "data-quick-add-dest",
      "Today",
    );
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    // Nothing was typed, so today's note was never minted -- no Daily container.
    await expect(rowWithText(page, "Daily")).toHaveCount(0);
  });

  test("the FAB never mounts on a fine pointer", async ({ page }) => {
    await load(page);
    await expect(page.locator("[data-quick-add-fab]")).toHaveCount(0);
  });

  test("discard-if-empty: a typed-then-cleared capture leaves nothing", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    await type(page, "ephemeral");
    // Clear it back to empty, then close.
    await page.keyboard.press(`${modifier()}+a`);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();

    // Open Today: the cleared capture must not be there.
    await todayButton(page).click();
    await expect(page).toHaveURL(/\/[^/]+$/);
    await expect(rowWithText(page, "ephemeral")).toHaveCount(0);
  });

  test("a captured node survives closing (commit-immediately)", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);
    await type(page, "kept-on-close");
    // No Enter -- just close. A non-empty draft is already live in Today.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();

    await todayButton(page).click();
    await expect(rowWithText(page, "kept-on-close")).toBeVisible();
  });

  test("the Today chip retargets the current capture", async ({ page }) => {
    await load(page);
    await openQuickAdd(page);
    await type(page, "moved-capture");

    // Open the retarget picker and choose Bravo.
    await destChip(page).click();
    const picker = page.getByPlaceholder("Capture into…");
    await expect(picker).toBeVisible();
    await picker.fill("Bravo");
    await page.getByRole("option", { name: "Bravo" }).click();

    // The chip now reads Bravo, and the node lives under Bravo (not Today).
    await expect(destChip(page)).toHaveAttribute(
      "data-quick-add-dest",
      "Bravo",
    );
    await page.keyboard.press("Escape");

    const moved = rowWithText(page, "moved-capture");
    await expect(moved).toBeVisible();
    const parentId = await moved.evaluate(
      (el) =>
        el.closest("li[data-node-id]")?.getAttribute("data-parent-id") ?? null,
    );
    expect(parentId).toBe("bravo");
  });

  test("tags and the slash palette work inside the mini-editor", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    // A #tag folds into a chip live while composing.
    await type(page, "read #books");
    await expect(dialog(page).locator('.tag[data-tag="books"]')).toBeVisible();

    // "/" opens the curated command palette; the structural verbs are absent.
    await page.keyboard.type(" /");
    const palette = page.getByRole("listbox");
    await expect(palette).toBeVisible();
    await expect(palette).toContainText("Paragraph");
    await expect(palette).not.toContainText("Move");
    await expect(palette).not.toContainText("Delete");
  });
});

// The async-born lifecycle: with the daily claim resolving in a microtask (the
// Map mock), the in-flight-born window never happens, hiding a cluster of race
// bugs. These specs HOLD the destination resolve open via the test seam, drive
// the interfering action, then release -- so each race is actually exercised.
test.describe("quick-add async-born lifecycle (deferred resolve)", () => {
  test("clear during an in-flight born, then retype: the retype still lands (bug 1)", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    await holdResolve(page);
    await type(page, "aaa"); // born starts, blocked on the held resolve
    await page.keyboard.press(`${modifier()}+a`);
    await page.keyboard.press("Backspace"); // cleared while borning
    await releaseResolve(page); // born settles against empty text -> creates nothing
    // The now-idle draft must accept a fresh keystroke (no poisoned dead promise).
    await page.waitForTimeout(50);
    await type(page, "bbb");
    await commitNext(page);

    await expect(dialog(page)).toContainText("bbb");
    await page.keyboard.press("Escape");
    await todayButton(page).click();
    await expect(rowWithText(page, "bbb")).toBeVisible({ timeout: 10_000 });
    await expect(rowWithText(page, "aaa")).toHaveCount(0);
  });

  test("retarget then Enter: the NEXT capture resets to Today (bug 2)", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    await type(page, "note-one");
    await destChip(page).click();
    await page.getByPlaceholder("Capture into…").fill("Bravo");
    await page.getByRole("option", { name: "Bravo" }).click();
    await expect(destChip(page)).toHaveAttribute(
      "data-quick-add-dest",
      "Bravo",
    );
    await commitNext(page); // files note-one under Bravo, keeps the overlay open

    // The fresh draft must be back on Today, not still Bravo.
    await expect(destChip(page)).toHaveAttribute(
      "data-quick-add-dest",
      "Today",
    );
    await type(page, "note-two");
    await commitNext(page);

    await expect(dialog(page)).toContainText("note-two");
    await page.keyboard.press("Escape");

    await expect(rowWithText(page, "note-one")).toBeVisible({
      timeout: 10_000,
    });
    await expect(rowWithText(page, "note-two")).toBeVisible({
      timeout: 10_000,
    });
    expect(await parentIdOf(page, "note-one")).toBe("bravo");
    // note-two must NOT have inherited Bravo -- it belongs to today's note.
    expect(await parentIdOf(page, "note-two")).not.toBe("bravo");
  });

  test("retarget DURING an in-flight born lands under the pick (bug 3)", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    await holdResolve(page);
    await type(page, "relocated"); // born starts, blocked
    await destChip(page).click(); // retarget while borning
    await page.getByPlaceholder("Capture into…").fill("Charlie");
    await page.getByRole("option", { name: "Charlie" }).click();
    await releaseResolve(page); // born resolves under the NEW target

    await commitNext(page);
    await expect(dialog(page)).toContainText("relocated");
    await page.keyboard.press("Escape");

    await expect(rowWithText(page, "relocated")).toBeVisible({
      timeout: 10_000,
    });
    expect(await parentIdOf(page, "relocated")).toBe("charlie");
  });

  test("/todo during an in-flight born makes a task, not a throw (bug 4)", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await load(page);
    await openQuickAdd(page);

    await holdResolve(page);
    await type(page, "buy milk"); // born starts, blocked; node id is the placeholder
    await page.keyboard.type(" /todo");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Enter"); // selects To-do -> intent queued, not applied to placeholder
    await releaseResolve(page); // born creates the node + applies the queued task intent

    await commitNext(page); // commit, keep the overlay open to read the session list
    await expect(dialog(page)).toContainText("buy milk");
    await page.keyboard.press("Escape");
    await todayButton(page).click();

    const row = rowWithText(page, "buy milk");
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.locator(".checkbox")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("rapid-fire Cmd+Enter preserves order under a slow resolve (bug 6)", async ({
    page,
  }) => {
    await load(page);
    await openQuickAdd(page);

    await holdResolve(page);
    await type(page, "alpha-cap");
    await commitNext(page);
    // resetDraft clears the editor synchronously even while the born is held;
    // wait for that before the next type so keystrokes aren't dropped by the
    // post-commit re-render under load.
    await expect(editor(page)).toHaveText("");
    await type(page, "beta-cap");
    await commitNext(page);
    await releaseResolve(page); // both borns unblock; creates must run in order

    await expect(dialog(page)).toContainText("alpha-cap");
    await expect(dialog(page)).toContainText("beta-cap");
    await page.keyboard.press("Escape");
    await todayButton(page).click();

    const first = rowWithText(page, "alpha-cap");
    const second = rowWithText(page, "beta-cap");
    await expect(first).toBeVisible({ timeout: 10_000 });
    await expect(second).toBeVisible({ timeout: 10_000 });
    const firstIdx = await first.evaluate((el) =>
      Array.from(document.querySelectorAll("li[data-node-id]")).indexOf(
        el.closest("li[data-node-id]")!,
      ),
    );
    const secondIdx = await second.evaluate((el) =>
      Array.from(document.querySelectorAll("li[data-node-id]")).indexOf(
        el.closest("li[data-node-id]")!,
      ),
    );
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});

// The FAB is a coarse-pointer surface (ADR 0030's presence seam), so drive it in
// Chromium mobile emulation where `(pointer: coarse)` actually matches. The
// keyboard-anchored overlay positioning (visualViewport) is NOT exercisable here
// (no real software keyboard) -- that's the PR's manual iPhone checklist. This
// covers the FAB's mount gating: coarse-only, and its not-editing visibility.
test.describe("quick-add mobile FAB (coarse pointer)", () => {
  test.use({ hasTouch: true, isMobile: true });

  const fab = (page: Page) => page.locator("[data-quick-add-fab]");

  test("mobile emulation actually reports a coarse pointer", async ({
    page,
  }) => {
    await load(page);
    const coarse = await page.evaluate(
      () => window.matchMedia("(pointer: coarse)").matches,
    );
    expect(coarse).toBe(true);
  });

  test("mounts when not editing and opens the overlay on tap", async ({
    page,
  }) => {
    await load(page);
    await expect(fab(page)).toBeVisible();
    await fab(page).tap();
    await expect(dialog(page)).toBeVisible();
  });

  test("is hidden while a bullet is being edited (complement of the mobile bar)", async ({
    page,
  }) => {
    await load(page);
    await expect(fab(page)).toBeVisible();
    // Focus a bullet -> editing -> the FAB yields to the mobile actions bar.
    const bullet = page.locator(
      'li[data-node-id="alpha"] > .outline-row .node-text',
    );
    await bullet.tap();
    await expect(bullet).toBeFocused();
    await expect(fab(page)).toBeHidden();
    // Blur back out -> the FAB returns.
    await bullet.evaluate((el) => (el as HTMLElement).blur());
    await expect(fab(page)).toBeVisible();
  });
});
