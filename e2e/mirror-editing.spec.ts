import { expect, test, type Locator, type Page } from "@playwright/test";

import { seedOutline, type SeedNode } from "./fixtures";

// Node mirrors (ADR 0022), slice 2c: full editing parity INSIDE a mirror. Stage 1
// shipped render + the field split; 2a/2b made focus + caret nav path-addressed.
// 2c makes STRUCTURAL edits behave per the field split -- position ops target the
// INSTANCE, content + child inserts target the SOURCE -- and lands focus in the
// instance the user was editing (never teleporting to the source's far copy).
//
// Tree (display order, flag on, nothing collapsed):
//   A  "alphasource"
//     a1 "childone"
//     a2 "childtwo"
//   P  "project"
//     M  (mirrorOf=A)  -> windows a1, a2
//
// So a1/a2 each render TWICE: once under the real source A (document order first =
// nth(0)) and once windowed under the mirror M (nth(1)). Text is space-free so
// `toHaveText` (which normalizes whitespace) compares exactly.
const MIRROR_TREE: SeedNode[] = [
  { id: "A", parentId: null, prevSiblingId: null, text: "alphasource" },
  { id: "P", parentId: null, prevSiblingId: "A", text: "project" },
  { id: "a1", parentId: "A", prevSiblingId: null, text: "childone" },
  { id: "a2", parentId: "A", prevSiblingId: "a1", text: "childtwo" },
  {
    id: "M",
    parentId: "P",
    prevSiblingId: null,
    text: "placeholder",
    mirrorOf: "A",
  },
];

// All copies of a node's editable span (a windowed source child has two).
const spans = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);
const focused = (page: Page) => page.locator(".node-text:focus");

// Platform Cmd/Ctrl, matching the app's `Mod+...` hotkeys (Playwright has no
// "Mod" alias). Mirrors the helper in the other specs.
function modifier() {
  return process.platform === "darwin" ? "Meta" : "Control";
}

// The flat-list order of node ids as rendered (document order === visible order).
// A windowed source child appears twice, so the same id repeats -- exactly what
// lets us prove a reorder lands in BOTH the source and the mirror.
const nodeOrder = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("li[data-node-id]")).map((li) =>
      li.getAttribute("data-node-id"),
    ),
  );

async function load(page: Page, tree: SeedNode[], mirrors: boolean) {
  await page.addInitScript(() => {
    localStorage.setItem("dotflowy:flag:virtualized", "on");
  });
  // Set the mirrors flag EXPLICITLY -- the compiled default is ON (flags.ts), so
  // relying on "don't set it" for the off case actually leaves mirrors on and the
  // parity tests run against the wrong path. Always write the concrete value.
  await page.addInitScript((on) => {
    localStorage.setItem("dotflowy:flag:mirrors", on ? "on" : "off");
  }, mirrors);
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(spans(page, "A")).toBeVisible();
}

// Focus a SPECIFIC span (a Locator, so we can target one of two duplicate copies)
// and drop the caret at absolute offset `col`. Sets the Selection range directly:
// Home/Arrow keys are unreliable in macOS Chromium contentEditable, and a plain
// click lands past the text. Mirrors the caretAt helper in enter-split.spec.ts.
async function caretIn(locator: Locator, col: number) {
  await locator.click();
  await locator.evaluate((el, target) => {
    const sel = window.getSelection();
    if (!sel) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = target as number;
    let node = walker.nextNode();
    const range = document.createRange();
    while (node) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= len;
      node = walker.nextNode();
    }
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }, col);
}

test.describe("node mirrors -- editing parity inside a mirror (ADR 0022, 2c)", () => {
  test("Enter-split inside a mirror splits the source and lands focus under the mirror", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, true);
    await expect(spans(page, "a1")).toHaveCount(2);

    // Split the WINDOWED copy of a1 (under M) at "child|one". The split edits the
    // real node a1, so it shows in BOTH instances; the tail seeds a new sibling.
    await caretIn(spans(page, "a1").nth(1), 5);
    await page.keyboard.press("Enter");

    // a1 truncated to "child" in every instance.
    await expect(spans(page, "a1").nth(0)).toHaveText("child");
    await expect(spans(page, "a1").nth(1)).toHaveText("child");
    // The new "one" node windows into both instances (real under A + under M).
    const ones = page.locator(".node-text").filter({ hasText: /^one$/ });
    await expect(ones).toHaveCount(2);
    // Focus landed on the WINDOWED copy (doc order: nth(0)=under source, nth(1)=
    // under the mirror), NOT the source's row -- no cross-instance focus bleed.
    await expect(ones.nth(1)).toBeFocused();
  });

  test("Enter at the end of a mirror's own row adds a child to the source", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, true);

    // The mirror row shows the SOURCE's text; pressing Enter at its end dives in,
    // adding a child to the source (windows into every instance), not a local
    // sibling next to the mirror.
    await expect(spans(page, "M")).toHaveText("alphasource");
    await caretIn(spans(page, "M"), 99);
    await page.keyboard.press("Enter");
    await page.keyboard.type("newkid");

    // "newkid" now exists under the real source A AND windowed under M.
    const kids = page.locator(".node-text").filter({ hasText: /^newkid$/ });
    await expect(kids).toHaveCount(2);
    await expect(kids.nth(1)).toBeFocused(); // editing instance keeps focus
  });

  test("indent + outdent inside a mirror restructures the source in every instance", async ({
    page,
  }) => {
    // Gate the structural-write invariant: indent/outdent must never produce a
    // self-referencing sibling chain (the DEV tripwire in structural.ts). This is
    // the regression guard for the indent fix -- the tripwire only logs, so we
    // assert it stayed silent.
    const chainErrors: string[] = [];
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        msg.text().includes("sibling-chain invariant broken")
      ) {
        chainErrors.push(msg.text());
      }
    });
    await load(page, MIRROR_TREE, true);

    // Tab on the windowed a2 indents it under a1. a2 is a real node, so its parent
    // changes everywhere -- both copies now hang under a1.
    await spans(page, "a2").nth(1).click();
    await expect(spans(page, "a2").nth(1)).toBeFocused();
    await page.keyboard.press("Tab");

    await expect(page.locator('li[data-node-id="a2"]').nth(0)).toHaveAttribute(
      "data-parent-id",
      "a1",
    );
    await expect(page.locator('li[data-node-id="a2"]').nth(1)).toHaveAttribute(
      "data-parent-id",
      "a1",
    );
    // Focus stayed on the windowed a2 (the editing instance), not the source copy.
    await expect(spans(page, "a2").nth(1)).toBeFocused();

    // Shift+Tab outdents it back to a child of A, again in both instances.
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator('li[data-node-id="a2"]').nth(0)).toHaveAttribute(
      "data-parent-id",
      "A",
    );
    await expect(page.locator('li[data-node-id="a2"]').nth(1)).toHaveAttribute(
      "data-parent-id",
      "A",
    );
    await expect(spans(page, "a2").nth(1)).toBeFocused();

    expect(chainErrors).toEqual([]);
  });

  test("Tab on a node whose PREV SIBLING is a mirror parents it into the SOURCE, not the vanishing instance", async ({
    page,
  }) => {
    // The reported bug: indenting under a mirror sent the node under the INSTANCE
    // id, whose row windows the SOURCE's children and never the node -> it
    // disappeared. The drag path resolved the mirror boundary; keyboard indent
    // did not. Fix: `indent(index, id, resolveMirror)` parents into the source,
    // so the node windows into every instance (matching drag). Guard the chain
    // tripwire too -- a bad reparent could tear the sibling chain.
    const chainErrors: string[] = [];
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        msg.text().includes("sibling-chain invariant broken")
      )
        chainErrors.push(msg.text());
    });

    // X sits directly after the mirror M under P, so X's prev sibling IS the
    // mirror instance -- the exact trigger.
    const tree: SeedNode[] = [
      { id: "A", parentId: null, prevSiblingId: null, text: "alphasource" },
      { id: "P", parentId: null, prevSiblingId: "A", text: "project" },
      { id: "a1", parentId: "A", prevSiblingId: null, text: "childone" },
      {
        id: "M",
        parentId: "P",
        prevSiblingId: null,
        text: "ph",
        mirrorOf: "A",
      },
      { id: "X", parentId: "P", prevSiblingId: "M", text: "extranode" },
    ];
    await load(page, tree, true);
    await expect(page.locator('li[data-node-id="X"]')).toHaveCount(1);

    // Tab X. It must parent into A (M's source), NOT the instance id.
    await spans(page, "X").click();
    await expect(spans(page, "X")).toBeFocused();
    await page.keyboard.press("Tab");

    // X is still here (not vanished) and now windows into BOTH instances: the
    // real copy under source A and the windowed copy under mirror M -- so it
    // renders twice, both parented to the content node A.
    await expect(page.locator('li[data-node-id="X"]')).toHaveCount(2);
    await expect(page.locator('li[data-node-id="X"]').nth(0)).toHaveAttribute(
      "data-parent-id",
      "A",
    );
    await expect(page.locator('li[data-node-id="X"]').nth(1)).toHaveAttribute(
      "data-parent-id",
      "A",
    );
    // Focus survived on X (never dropped into the void).
    await expect(focused(page)).toHaveText("extranode");
    expect(chainErrors).toEqual([]);
  });

  test("flag OFF: Tab under a mirrorOf node indents normally (no source redirect)", async ({
    page,
  }) => {
    // The escape hatch must run today's exact code: OFF, a `mirrorOf` node is a
    // plain leaf, so X indents under IT (not the phantom source). Proves the fix
    // is gated on the flag, not an unconditional `mirrorOf` read.
    const tree: SeedNode[] = [
      { id: "A", parentId: null, prevSiblingId: null, text: "alphasource" },
      { id: "P", parentId: null, prevSiblingId: "A", text: "project" },
      { id: "a1", parentId: "A", prevSiblingId: null, text: "childone" },
      {
        id: "M",
        parentId: "P",
        prevSiblingId: null,
        text: "placeholder",
        mirrorOf: "A",
      },
      { id: "X", parentId: "P", prevSiblingId: "M", text: "extranode" },
    ];
    await load(page, tree, false);
    await expect(spans(page, "a1")).toHaveCount(1); // no windowing

    await spans(page, "X").click();
    await expect(spans(page, "X")).toBeFocused();
    await page.keyboard.press("Tab");

    // X indented under the plain M, rendering once. No redirect to A.
    await expect(page.locator('li[data-node-id="X"]')).toHaveCount(1);
    await expect(page.locator('li[data-node-id="X"]')).toHaveAttribute(
      "data-parent-id",
      "M",
    );
  });

  test("edge reparent (Cmd+Shift+Up) into a mirror UNCLE lands in the source, not the vanishing instance", async ({
    page,
  }) => {
    // moveUp at the first-child edge reparents into the parent's PREVIOUS sibling
    // (the "uncle"). When that uncle is a mirror, the same boundary applies as Tab:
    // land in the SOURCE so the node windows into every instance, never under the
    // instance id (which would orphan it).
    const chainErrors: string[] = [];
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        msg.text().includes("sibling-chain invariant broken")
      )
        chainErrors.push(msg.text());
    });

    // Q's prev sibling is the mirror M; X is Q's FIRST child, so Cmd+Shift+Up on X
    // hits the edge and reparents into the uncle M -> its source A.
    const tree: SeedNode[] = [
      { id: "A", parentId: null, prevSiblingId: null, text: "alphasource" },
      { id: "P", parentId: null, prevSiblingId: "A", text: "project" },
      { id: "a1", parentId: "A", prevSiblingId: null, text: "childone" },
      {
        id: "M",
        parentId: "P",
        prevSiblingId: null,
        text: "ph",
        mirrorOf: "A",
      },
      { id: "Q", parentId: "P", prevSiblingId: "M", text: "queue" },
      { id: "X", parentId: "Q", prevSiblingId: null, text: "extranode" },
    ];
    await load(page, tree, true);
    await expect(page.locator('li[data-node-id="X"]')).toHaveCount(1);

    await spans(page, "X").click();
    await expect(spans(page, "X")).toBeFocused();
    await page.keyboard.press(`${modifier()}+Shift+ArrowUp`);

    // X windows into both instances now (child of source A, appended after a1).
    await expect(page.locator('li[data-node-id="X"]')).toHaveCount(2);
    await expect(page.locator('li[data-node-id="X"]').nth(0)).toHaveAttribute(
      "data-parent-id",
      "A",
    );
    await expect(page.locator('li[data-node-id="X"]').nth(1)).toHaveAttribute(
      "data-parent-id",
      "A",
    );
    await expect(focused(page)).toHaveText("extranode");
    expect(chainErrors).toEqual([]);
  });

  test("multi-select Tab under a mirror indents the whole run into the source (indentManyNodes)", async ({
    page,
  }) => {
    // The selection-mode Tab path (indentManyNodes) derives its target the same
    // way single indent does -- the run's prev sibling. A mirror there must
    // redirect the entire run to the source, not strand it under the instance.
    const chainErrors: string[] = [];
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        msg.text().includes("sibling-chain invariant broken")
      )
        chainErrors.push(msg.text());
    });

    // X, Y are a contiguous run under P whose prev sibling (the node before the
    // run) is the mirror M.
    const tree: SeedNode[] = [
      { id: "A", parentId: null, prevSiblingId: null, text: "alphasource" },
      { id: "P", parentId: null, prevSiblingId: "A", text: "project" },
      { id: "a1", parentId: "A", prevSiblingId: null, text: "childone" },
      {
        id: "M",
        parentId: "P",
        prevSiblingId: null,
        text: "ph",
        mirrorOf: "A",
      },
      { id: "X", parentId: "P", prevSiblingId: "M", text: "extraone" },
      { id: "Y", parentId: "P", prevSiblingId: "X", text: "extratwo" },
    ];
    await load(page, tree, true);
    await expect(page.locator('li[data-node-id="X"]')).toHaveCount(1);
    await expect(page.locator('li[data-node-id="Y"]')).toHaveCount(1);

    // Select the run X..Y: focus X, first Shift+Down selects X, second extends to
    // Y. Both roots now carry the selection edge (top/bottom) -- proves the
    // MULTI-node path (indentManyNodes), not single indent.
    await caretIn(spans(page, "X"), 99);
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(page.locator('li[data-node-id="X"]')).toHaveAttribute(
      "data-selected",
      "top",
    );
    await expect(page.locator('li[data-node-id="Y"]')).toHaveAttribute(
      "data-selected",
      "bottom",
    );

    await page.keyboard.press("Tab");

    // The whole run landed under the source A and windows into both instances.
    await expect(page.locator('li[data-node-id="X"]')).toHaveCount(2);
    await expect(page.locator('li[data-node-id="Y"]')).toHaveCount(2);
    await expect(page.locator('li[data-node-id="X"]').nth(0)).toHaveAttribute(
      "data-parent-id",
      "A",
    );
    await expect(page.locator('li[data-node-id="Y"]').nth(0)).toHaveAttribute(
      "data-parent-id",
      "A",
    );
    await expect(page.locator('li[data-node-id="X"]').nth(1)).toHaveAttribute(
      "data-parent-id",
      "A",
    );
    await expect(page.locator('li[data-node-id="Y"]').nth(1)).toHaveAttribute(
      "data-parent-id",
      "A",
    );
    expect(chainErrors).toEqual([]);
  });

  test("Tab on a node whose prev sibling is a mirror OF ITSELF is a safe no-op (cycle guard)", async ({
    page,
  }) => {
    // Mirror resolution turns the prev-sibling id into its SOURCE. If that prev
    // sibling is a mirror of the moving node itself (or a descendant), the source
    // resolves back to the node -> parenting it under itself corrupts the tree.
    // `indent` splices raw (not via moveNode), so it must guard the way moveNode
    // does. This proves the guard: Tab is refused, X stays put, chain intact.
    const chainErrors: string[] = [];
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        msg.text().includes("sibling-chain invariant broken")
      )
        chainErrors.push(msg.text());
    });

    // M mirrors X and sits directly before it, so X's prev sibling resolves to X.
    const tree: SeedNode[] = [
      { id: "A", parentId: null, prevSiblingId: null, text: "alphasource" },
      { id: "P", parentId: null, prevSiblingId: "A", text: "project" },
      {
        id: "M",
        parentId: "P",
        prevSiblingId: null,
        text: "ph",
        mirrorOf: "X",
      },
      { id: "X", parentId: "P", prevSiblingId: "M", text: "targetnode" },
    ];
    await load(page, tree, true);
    await expect(page.locator('li[data-node-id="X"]')).toHaveCount(1);

    await spans(page, "X").click();
    await expect(spans(page, "X")).toBeFocused();
    await page.keyboard.press("Tab");

    // No-op: X is still a single row under P, never self-parented, chain clean.
    await expect(page.locator('li[data-node-id="X"]')).toHaveCount(1);
    await expect(page.locator('li[data-node-id="X"]')).toHaveAttribute(
      "data-parent-id",
      "P",
    );
    await expect(focused(page)).toHaveText("targetnode");
    expect(chainErrors).toEqual([]);
  });

  test("deleting a mirror instance removes only that instance, not the source", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, true);
    await expect(spans(page, "a1")).toHaveCount(2);

    // Delete the mirror's own row. The keymap hands the command the SOURCE's id,
    // but the delete targets the focused INSTANCE -- so the mirror goes and the
    // source survives (promote-on-source-delete is Stage 3, not this).
    await spans(page, "M").click();
    await expect(spans(page, "M")).toBeFocused();
    await page.keyboard.press(`${modifier()}+Shift+Backspace`);

    await expect(page.locator('li[data-mirror="instance"]')).toHaveCount(0);
    await expect(spans(page, "A")).toBeVisible();
    // a1/a2 now render once -- only under the surviving source.
    await expect(spans(page, "a1")).toHaveCount(1);
    await expect(spans(page, "a2")).toHaveCount(1);
  });

  test("selecting a mirror selects the INSTANCE, so delete removes only the mirror", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, true);
    await expect(spans(page, "a1")).toHaveCount(2);

    // Enter node selection on the mirror's own row (Shift+Down from line end is
    // the direction-agnostic single-node entry). Pre-2e the keymap selected the
    // SOURCE's id (content), so the SOURCE row lit up and a select+delete removed
    // the source, orphaning every instance ("deletes both"). It must select the
    // INSTANCE: the mirror row carries the edge, the source row does not.
    await caretIn(spans(page, "M"), 99);
    await page.keyboard.press("Shift+ArrowDown");
    // M windows a1/a2, so the windowed-subtree-tint fix (2e-2) covers all three
    // rows -- the slab rounds at M (top) and a2's windowed copy, its last visible
    // descendant (bottom), not just at M alone.
    await expect(page.locator('li[data-node-id="M"]')).toHaveAttribute(
      "data-selected",
      "top",
    );
    await expect(spans(page, "a1").nth(1)).toBeVisible(); // sanity: nth(1) is the windowed copy
    await expect(page.locator('li[data-node-id="a1"]').nth(1)).toHaveAttribute(
      "data-selected",
      "middle",
    );
    await expect(page.locator('li[data-node-id="a2"]').nth(1)).toHaveAttribute(
      "data-selected",
      "bottom",
    );
    // No cross-instance bleed: the real source A and its OWN (canonical) a1/a2
    // rows are a totally different branch of the walk, never covered.
    await expect(page.locator('li[data-node-id="A"]')).not.toHaveAttribute(
      "data-selected",
      /.*/,
    );
    await expect(
      page.locator('li[data-node-id="a1"]').nth(0),
    ).not.toHaveAttribute("data-selected", /.*/);
    await expect(
      page.locator('li[data-node-id="a2"]').nth(0),
    ).not.toHaveAttribute("data-selected", /.*/);

    // Delete the selection (selection-mode Backspace). Only the mirror goes; the
    // source and its children survive, now rendering once.
    await page.keyboard.press("Backspace");
    await expect(page.locator('li[data-mirror="instance"]')).toHaveCount(0);
    await expect(spans(page, "A")).toBeVisible();
    await expect(spans(page, "a1")).toHaveCount(1);
    await expect(spans(page, "a2")).toHaveCount(1);
  });

  test("deleting a SOURCE that has a live mirror is blocked (no orphaned instances)", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, true);
    await expect(spans(page, "a1")).toHaveCount(2); // source + windowed under M

    // Try to delete the real source A. Removing it would strand the mirror M
    // (promote-on-delete is Stage 3), so the core blocks it: A and the mirror
    // both survive, and a1/a2 still render twice.
    await caretIn(spans(page, "A"), 0);
    await page.keyboard.press(`${modifier()}+Shift+Backspace`);

    await expect(spans(page, "A")).toBeVisible();
    await expect(page.locator('li[data-mirror="instance"]')).toHaveCount(1);
    await expect(spans(page, "a1")).toHaveCount(2);
    await expect(spans(page, "a2")).toHaveCount(2);
  });

  test("zoom morph names ONE element when a source and its mirror are both visible (no duplicate view-transition-name)", async ({
    page,
  }) => {
    // Dogfood crash repro. pivotId is a node id; the old `content.id === pivotId`
    // tagged the source's OWN row AND every visible mirror row with
    // `view-transition-name: zoom-target`. That name must be unique per document,
    // so the duplicate logged a console error and the next zoom threw "Transition
    // was aborted". Pivot is now keyed by the per-instance rowKey, so only the
    // source's canonical row morphs (key === id); mirror rows never collide.
    const morphErrors: string[] = [];
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        /duplicate view-transition-name|Transition was aborted/.test(msg.text())
      )
        morphErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      if (
        /Transition was aborted|duplicate view-transition-name/.test(
          err.message,
        )
      )
        morphErrors.push(err.message);
    });

    await load(page, MIRROR_TREE, true);
    await expect(spans(page, "a1")).toHaveCount(2); // source + windowed under M

    // Zoom INTO the source A (bullet click -> A becomes the title), then back OUT
    // one level (Mod+,). Zooming out sets the morph pivot to A while rooting at the
    // top, so A's own row AND the mirror M (which windows A) are both visible with
    // pivotId === A -- the exact collision the user hit.
    await page.locator('li[data-node-id="A"] .bullet').first().click();
    await expect(page.locator(".zoomed-title-text")).toHaveText("alphasource");
    await page.keyboard.press(`${modifier()}+Comma`);

    // Back at the top level with both rows visible. The source's row carrying the
    // morph name proves pivotId === A took effect (precondition -- fails loudly if
    // the zoom-out didn't land, so the assertions below can't false-green).
    await expect(spans(page, "A")).toBeVisible();
    await expect(page.locator('li[data-mirror="instance"]')).toHaveCount(1);
    await expect(spans(page, "A")).toHaveAttribute("style", /zoom-target/);

    // Exactly ONE element carries the morph name, and it is NOT the mirror row.
    const named = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll<HTMLElement>(".node-text")).filter(
          (el) => el.style.viewTransitionName === "zoom-target",
        ).length,
    );
    expect(named).toBe(1);
    await expect(spans(page, "M")).not.toHaveAttribute("style", /zoom-target/);
    expect(morphErrors).toEqual([]);
  });

  test("dragging a windowed child inside a mirror reorders the SOURCE in every instance (2d)", async ({
    page,
  }) => {
    // The structural-write tripwire only console.errors; assert it stayed silent
    // (a reorder that read a stale post-update index would tear the chain).
    const chainErrors: string[] = [];
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        msg.text().includes("sibling-chain invariant broken")
      )
        chainErrors.push(msg.text());
    });
    // Three children so the drop lands UNAMBIGUOUSLY off the top: dropping the
    // grabbed a1 past every row puts it after a2/a3 -- no longer first -- which
    // survives the virtualizer's estimate-vs-measured geometry offset (the reason
    // a precise gap can't be aimed from a synthetic-pointer test).
    const tree: SeedNode[] = [
      { id: "A", parentId: null, prevSiblingId: null, text: "alphasource" },
      { id: "P", parentId: null, prevSiblingId: "A", text: "project" },
      { id: "a1", parentId: "A", prevSiblingId: null, text: "childone" },
      { id: "a2", parentId: "A", prevSiblingId: "a1", text: "childtwo" },
      { id: "a3", parentId: "A", prevSiblingId: "a2", text: "childthree" },
      {
        id: "M",
        parentId: "P",
        prevSiblingId: null,
        text: "ph",
        mirrorOf: "A",
      },
    ];
    await load(page, tree, true);
    await expect(spans(page, "a1")).toHaveCount(2);
    expect(await nodeOrder(page)).toEqual([
      "A",
      "a1",
      "a2",
      "a3",
      "P",
      "M",
      "a1",
      "a2",
      "a3",
    ]);

    // Drag the WINDOWED a1 (under M, nth(1)) DOWN past every row so it lands after
    // the last windowed child. a1 is a REAL node, so reordering it restructures
    // the source -> the move shows under BOTH the source and the mirror. Pre-2d
    // the windowed rows had no virtualizer geometry (hit-test keyed by bare id,
    // not row.key) so the drop projected off only the non-mirror rows ("way off").
    // Drop near the viewport bottom (above the 72px auto-scroll edge band): that's
    // below every row's virtualizer position regardless of the estimate offset,
    // so the gap is unambiguously the end of the list.
    {
      const grab = page.locator('li[data-node-id="a1"] .bullet').nth(1);
      const g = await grab.boundingBox();
      if (!g) throw new Error("grab handle not laid out");
      const gx = g.x + g.width / 2;
      const dropY = (page.viewportSize()?.height ?? 720) - 100;
      await page.mouse.move(gx, g.y + g.height / 2);
      await page.mouse.down();
      await page.mouse.move(gx, g.y + g.height / 2 + 12, { steps: 5 });
      await page.mouse.move(gx, dropY, { steps: 12 });
      await page.mouse.up();
    }

    // a1 left the top in BOTH instances, and the two blocks stay in lockstep (one
    // real reorder, windowed everywhere). The exact landing slot (after a2 or a3)
    // is left loose -- either proves the source was restructured.
    const childBlocks = async () => {
      const order = await nodeOrder(page);
      const p = order.indexOf("P");
      const m = order.indexOf("M");
      return { source: order.slice(1, p), mirror: order.slice(m + 1) };
    };
    await expect.poll(async () => (await childBlocks()).source[0]).toBe("a2");
    const { source, mirror } = await childBlocks();
    expect(source).not.toEqual(["a1", "a2", "a3"]); // a1 moved off the top
    expect(mirror).toEqual(source); // reflected in the mirror
    expect(source).toContain("a1"); // still present, just relocated
    expect(chainErrors).toEqual([]);
  });

  test("flag OFF: a mirrorOf node Enter-splits as an ordinary leaf (parity)", async ({
    page,
  }) => {
    await load(page, MIRROR_TREE, false);

    // Mirrors disabled: M is a plain node showing its own text, no windowing.
    await expect(spans(page, "M")).toHaveText("placeholder");
    await expect(spans(page, "a1")).toHaveCount(1);

    await caretIn(spans(page, "M"), 4);
    await page.keyboard.press("Enter");

    await expect(spans(page, "M")).toHaveText("plac");
    await expect(focused(page)).toHaveText("eholder");
    // Still no windowing -- a1 stays single.
    await expect(spans(page, "a1")).toHaveCount(1);
  });
});
