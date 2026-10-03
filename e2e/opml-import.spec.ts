import { expect, test, type FileChooser, type Page } from "@playwright/test";
// App OPML import (ADR 0037, issue #126): "Import OPML…" (More menu + Cmd+K)
// opens a hidden file input; parse is client-side; ONE dialog carries
// summary/confirm (with the core's degradation disclosures), modal progress,
// and success/error. The commit is one history capture + ONE runStructural
// batch, landing under a fresh top-level container created collapsed. A
// malformed file errors cleanly at the summary step and writes NOTHING.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { seedOutline, STANDARD_TREE } from "./fixtures";

const SAMPLE_PATH = fileURLToPath(
  new URL(
    "../docs/spec-assets/opml/workflowy-crafted-sample.opml",
    import.meta.url,
  ),
);

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

// The freshly-created import container row (its id is minted at import time,
// so locate it by its "Imported from Workflowy — {date}" text).
const containerRow = (page: Page) =>
  page.locator("li[data-node-id]", { hasText: "Imported from Workflowy" });

async function load(page: Page) {
  await seedOutline(page, STANDARD_TREE);
  await page.goto("/");
  await expect(text(page, "alpha")).toBeVisible();
}

// Run "Import OPML…" via Cmd+K (the More menu's import moved to /settings with
// #171; the Cmd+K global action is the same `openOpmlImport()` opener), then
// answer the native file picker.
async function pickFile(
  page: Page,
  files: Parameters<FileChooser["setFiles"]>[0],
) {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder(/Search nodes and actions/);
  await expect(input).toBeVisible();
  await input.fill("import opml");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("option", { name: /Import OPML/ }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}

test.describe("OPML import", () => {
  test("crafted sample: summary discloses degradations; import lands one collapsed container that persists", async ({
    page,
  }) => {
    await load(page);
    await pickFile(page, SAMPLE_PATH);

    // Summary/confirm: counts + every degradation line from the core's tally.
    const summary = page.getByTestId("opml-summary");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("23 bullets");
    const disclosures = page.getByTestId("opml-disclosures");
    await expect(disclosures).toContainText("1 note became 2 child bullets");
    await expect(disclosures).toContainText(
      "2× nested <mark> dropped (outermost wins)",
    );
    await expect(disclosures).toContainText(
      "1× <mention> -> @mention(id) (name unrecoverable)",
    );

    // Confirm -> (modal progress flashes by) -> success.
    await page.getByTestId("opml-confirm").click();
    await expect(page.getByTestId("opml-success")).toBeVisible();
    await expect(page.getByTestId("opml-success")).toContainText("23 bullets");

    // "Go to imported" zooms into the container; the imported subtree renders
    // (zooming shows a collapsed root's children).
    await page.getByRole("button", { name: "Go to imported" }).click();
    await expect(page.locator("h2.zoomed-title")).toContainText(
      "Imported from Workflowy",
    );
    const sampleRoot = page.locator("li[data-node-id]", {
      hasText: "dotflowy OPML sample (safe to delete)",
    });
    await expect(sampleRoot.first()).toBeVisible();
    // Inline mapping applied (folded bold token renders its interior) and the
    // _note became child bullets.
    await expect(
      page.locator(".node-text", { hasText: "bold text" }).first(),
    ).toBeVisible();
    await expect(
      page
        .locator(".node-text", {
          hasText: "note line two after a hard newline",
        })
        .first(),
    ).toBeVisible();
    await expect(
      page.locator(".node-text", { hasText: "level 6 deepest" }).first(),
    ).toBeVisible();

    // Back home (a full reload): the container is a NEW top-level row appended
    // after the seeded tree, created collapsed — none of its 23 descendants
    // render. Surviving the reload proves the batch persisted to the (mock)
    // server store, not just the optimistic overlay.
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible();
    const container = containerRow(page);
    await expect(container).toHaveCount(1);
    await expect(container).not.toHaveAttribute("data-parent-id", /.+/);
    await expect(
      page.locator("li[data-node-id]", {
        hasText: "dotflowy OPML sample",
      }),
    ).toHaveCount(0);
  });

  test("one Cmd+Z removes the whole import (single pre-batch capture)", async ({
    page,
  }) => {
    await load(page);
    await pickFile(page, SAMPLE_PATH);
    await page.getByTestId("opml-confirm").click();
    await expect(page.getByTestId("opml-success")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    // The collapsed container landed at home. (No reload here — the undo stack
    // is session state; a reload would wipe it by design.)
    await expect(containerRow(page)).toHaveCount(1);

    await text(page, "alpha").click();
    await expect(text(page, "alpha")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(containerRow(page)).toHaveCount(0);
    // The seeded outline is intact.
    for (const id of ["alpha", "bravo", "charlie"]) {
      await expect(text(page, id)).toBeVisible();
    }
    // And the undo's restore batch persisted: a reload still shows no container.
    await page.reload();
    await expect(text(page, "alpha")).toBeVisible();
    await expect(containerRow(page)).toHaveCount(0);
    await expect(page.locator("li[data-node-id]")).toHaveCount(
      STANDARD_TREE.length,
    );
  });

  test("a multi-slice import (>500 nodes) applies in yielding slices yet lands as ONE atomic batch", async ({
    page,
  }) => {
    // Delay the batch POST *response* so the dialog rests in its post-apply
    // "saving" phase — deterministic proof the sliced optimistic apply
    // finished (applied === count) while the single wire batch is in flight.
    await seedOutline(page, STANDARD_TREE, { postDelayMs: 600 });
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible();

    // 1,250 bullets -> 1 container slice + 3 chunk slices of <=500.
    const bullets = Array.from(
      { length: 1250 },
      (_, i) => `    <outline text="imported bullet ${i + 1}" />`,
    ).join("\n");
    const big = `<?xml version="1.0"?>\n<opml version="2.0">\n  <head><title>big</title></head>\n  <body>\n${bullets}\n  </body>\n</opml>\n`;
    await pickFile(page, {
      name: "big.opml",
      mimeType: "text/xml",
      buffer: Buffer.from(big),
    });

    await expect(page.getByTestId("opml-summary")).toContainText(
      "1,250 bullets",
    );
    await page.getByTestId("opml-confirm").click();
    await expect(page.getByTestId("opml-importing")).toContainText(
      "Saving 1,250 bullets as one atomic batch.",
    );
    await expect(page.getByTestId("opml-success")).toBeVisible();
    await expect(page.getByTestId("opml-success")).toContainText(
      "1,250 bullets",
    );
    await page.getByRole("button", { name: "Done" }).click();

    // ONE collapsed container, nothing rendered from inside it, and the whole
    // batch persisted to the (mock) server store across a reload.
    await page.goto("/");
    await expect(text(page, "alpha")).toBeVisible();
    await expect(containerRow(page)).toHaveCount(1);
    await expect(
      page.locator("li[data-node-id]", { hasText: "imported bullet" }),
    ).toHaveCount(0);
  });

  test("a truncated file shows the parse error (line/column) and writes nothing", async ({
    page,
  }) => {
    await load(page);
    const truncated = readFileSync(SAMPLE_PATH, "utf8").slice(0, 400);
    await pickFile(page, {
      name: "truncated.opml",
      mimeType: "text/xml",
      buffer: Buffer.from(truncated),
    });

    const error = page.getByTestId("opml-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText(/line \d+, column \d+/);
    await expect(error).toContainText("Nothing was imported");
    // No summary, no confirm — the flow never reaches a write.
    await expect(page.getByTestId("opml-confirm")).toHaveCount(0);

    await page.getByTestId("opml-error-close").click();
    await expect(containerRow(page)).toHaveCount(0);
    // Reload: the (mock) server store received no write at all.
    await page.reload();
    await expect(text(page, "alpha")).toBeVisible();
    await expect(containerRow(page)).toHaveCount(0);
    await expect(page.locator("li[data-node-id]")).toHaveCount(
      STANDARD_TREE.length,
    );
  });

  test("Cmd+K runs the same Import OPML action (the ADR 0034 bridge)", async ({
    page,
  }) => {
    await load(page);
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByPlaceholder(/Search nodes and actions/);
    await expect(input).toBeVisible();
    await input.fill("import opml");
    await expect(
      page.getByRole("option", { name: /Import OPML/ }),
    ).toBeVisible();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("option", { name: /Import OPML/ }).click();
    // The action fired the same hidden file input — the picker opening IS the
    // proof both surfaces share one entry point.
    await chooserPromise;
  });
});
