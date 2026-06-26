import { expect, test, type Page } from "@playwright/test";
import { seedOutline, STANDARD_TREE, type SeedNode } from "./fixtures";

// Cmd on macOS, Control elsewhere.
function modifier() {
  return process.platform === "darwin" ? "Meta" : "Control";
}

const todayButton = (page: Page) =>
  page.getByRole("button", { name: "Today's daily note" });

// A daily node's id is a generated UUID, so locate rows by their visible text.
const rowWithText = (page: Page, t: string) =>
  page.locator("li[data-node-id] > .outline-row", { hasText: t });

async function load(page: Page, tree: SeedNode[] = STANDARD_TREE) {
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(
    page.locator('li[data-node-id="alpha"] > .outline-row > .node-text'),
  ).toBeVisible();
}

// The breadcrumb's leading icon button zooms back to the top. It's a CLIENT
// navigation, so the seedOutline init script does not re-run and wipe the nodes
// created at runtime (a full reload would).
async function goHome(page: Page) {
  await page.locator("nav.breadcrumb button").first().click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe("daily notes", () => {
  test("Today creates the Daily container + today's note and zooms in", async ({
    page,
  }) => {
    await load(page);

    await expect(todayButton(page)).toBeVisible();
    await todayButton(page).click();

    // Zoomed into a node (URL left "/"); its title is today's full date.
    await expect(page).toHaveURL(/\/[^/]+$/);
    await expect(page).not.toHaveURL(/\/$/);
    const year = String(new Date().getFullYear());
    await expect(page.locator("h2.zoomed-title .node-text")).toContainText(year);

    // Home: the protected "Daily" container holds today's note, badged "Today".
    await goHome(page);
    await expect(rowWithText(page, "Daily")).toBeVisible();
    const badge = page.locator("[data-daily-date]");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("Today");
  });

  test("clicking Today twice reuses the same note (no duplicates)", async ({
    page,
  }) => {
    await load(page);

    await todayButton(page).click();
    // get-or-create is now async (an atomic claim round-trip on first create),
    // so wait for the zoom nav to settle before capturing the URL.
    await expect(page).toHaveURL(/\/[^/]+$/);
    await expect(page).not.toHaveURL(/\/$/);
    const firstUrl = page.url();

    await goHome(page);
    await todayButton(page).click();

    // Same note -> same URL, and still exactly one daily badge in the tree.
    await expect(page).toHaveURL(firstUrl);
    await goHome(page);
    await expect(page.locator("[data-daily-date]")).toHaveCount(1);
  });

  test("the `/` command moves a node under today's note", async ({ page }) => {
    await load(page);

    // Run the slash command from a top-level node. The leading space makes the
    // "/" follow whitespace so detectSlash fires; "/today" uniquely matches
    // "Move to Today" (see move-dialog.spec for the pattern).
    const charlie = page.locator(
      'li[data-node-id="charlie"] > .outline-row > .node-text',
    );
    await charlie.click();
    await expect(charlie).toBeFocused();
    await page.keyboard.type(" /today");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Enter");

    // Confirming toast, and the node -- a top-level sibling before -- now nests
    // under the Daily container's today note (creating both on first use).
    await expect(page.getByText("Moved to Today")).toBeVisible();
    const dailyContainer = page.locator("li[data-node-id]", {
      hasText: "Daily",
    });
    await expect(
      dailyContainer.locator('li[data-node-id="charlie"]'),
    ).toBeVisible();
  });

  test("Cmd+K 'today' offers a create-today action when the note is absent", async ({
    page,
  }) => {
    await load(page);

    await page.keyboard.press(`${modifier()}+k`);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.type("today");

    // The virtual (non-node) action -- today's note doesn't exist yet.
    const go = page.getByRole("option", { name: /Go to Today/ });
    await expect(go).toBeVisible();
    await go.click();

    // It created + navigated to today's note (URL left "/"; year in the title).
    await expect(page).toHaveURL(/\/[^/]+$/);
    await expect(page).not.toHaveURL(/\/$/);
    const year = String(new Date().getFullYear());
    await expect(page.locator("h2.zoomed-title .node-text")).toContainText(year);
    await goHome(page);
    await expect(page.locator("[data-daily-date]")).toHaveText("Today");
  });

  test("Cmd+K 'today' surfaces the existing note by its label, with no dup action", async ({
    page,
  }) => {
    await load(page);
    await todayButton(page).click(); // create today's note
    await goHome(page);

    await page.keyboard.press(`${modifier()}+k`);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.type("today");

    // The create-action is suppressed (the note exists)...
    await expect(
      page.getByRole("option", { name: /Go to Today/ }),
    ).toHaveCount(0);

    // ...and the real day note is found via its "Today" alias even though its
    // text is the full date (the row displays that date, hence the year). The
    // row also carries a "(Today)" suffix (Seam J annotation) for clarity.
    const year = String(new Date().getFullYear());
    const hit = page.getByRole("option", { name: new RegExp(year) });
    await expect(hit).toBeVisible();
    await expect(
      page.getByRole("option", { name: /\(Today\)/ }),
    ).toBeVisible();
    await hit.click();
    await expect(page).toHaveURL(/\/[^/]+$/);
    await expect(page.locator("h2.zoomed-title .node-text")).toContainText(year);
  });

  test("a lost claim adopts the winner's note (no duplicate on a race)", async ({
    page,
  }) => {
    // Simulate the race: this device's local daily-index replica is empty (it
    // GETs an empty /api/kv below), so it thinks today is absent and CLAIMS --
    // but another device already created the container + today's note, so the
    // atomic claim returns THEIR winning ids. The device must adopt those, not
    // mint duplicates. We pre-seed the winners as real nodes (so navigation +
    // badge resolve) and force ?op=claim to return them.
    const d = new Date();
    const todayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(d.getDate()).padStart(2, "0")}`;
    const winners: Record<string, string> = {
      container: "race-container",
      [todayKey]: "race-today",
    };

    await seedOutline(page, [
      ...STANDARD_TREE,
      {
        id: "race-container",
        parentId: null,
        prevSiblingId: "charlie",
        text: "Daily",
      },
      {
        id: "race-today",
        parentId: "race-container",
        prevSiblingId: null,
        text: `Note for ${d.getFullYear()}`,
      },
    ]);

    // Override only `?op=claim` to return the pre-existing winners; everything
    // else (the empty daily-index GET, the setMapping POST) falls through to the
    // seedOutline mock -- which is what keeps the local replica "stale".
    await page.route(
      (url) => url.pathname === "/api/kv",
      async (route) => {
        const req = route.request();
        if (
          req.method() === "POST" &&
          new URL(req.url()).searchParams.get("op") === "claim"
        ) {
          const { key } = req.postDataJSON() as { key: string };
          const nodeId = winners[key];
          if (nodeId) {
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ value: { key, nodeId } }),
            });
          }
        }
        return route.fallback();
      },
    );

    await page.goto("/");
    await expect(
      page.locator('li[data-node-id="alpha"] > .outline-row > .node-text'),
    ).toBeVisible();

    await todayButton(page).click();

    // Adopted the winner -> zoomed to race-today, never a freshly minted id.
    await expect(page).toHaveURL(/race-today$/);

    await goHome(page);
    // Exactly one day badge and one "Daily" container: no duplicate was created
    // despite this device having claimed.
    await expect(page.locator("[data-daily-date]")).toHaveCount(1);
    await expect(page.locator("[data-daily-date]")).toHaveText("Today");
    await expect(rowWithText(page, "Daily")).toHaveCount(1);
    await expect(page.locator('li[data-node-id="race-today"]')).toHaveCount(1);
  });

  test("orphaned kv mapping materializes the node instead of zooming to a ghost", async ({
    page,
  }) => {
    // daily-index points at ids with no matching outline rows (stale mapping).
    // Today must create those nodes under the claimed ids, not show the
    // "That bullet doesn't exist" empty state.
    const d = new Date();
    const todayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(d.getDate()).padStart(2, "0")}`;
    const orphans = {
      container: "ghost-container",
      [todayKey]: "ghost-today",
    };

    await seedOutline(page, STANDARD_TREE);

    const kvStore = new Map<string, { key: string; nodeId: string }>([
      ["container", { key: "container", nodeId: orphans.container }],
      [todayKey, { key: todayKey, nodeId: orphans[todayKey] }],
    ]);

    await page.route(
      (url) => url.pathname === "/api/kv",
      async (route) => {
        const req = route.request();
        const collection = new URL(req.url()).searchParams.get("collection");
        if (collection !== "daily-index") return route.fallback();

        switch (req.method()) {
          case "GET":
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify([...kvStore.values()]),
            });
          case "POST": {
            if (new URL(req.url()).searchParams.get("op") === "claim") {
              const { key, value } = req.postDataJSON() as {
                key: string;
                value: { key: string; nodeId: string };
              };
              if (!kvStore.has(key)) kvStore.set(key, value);
              return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ value: kvStore.get(key) }),
              });
            }
            const { rows } = req.postDataJSON() as {
              rows: { key: string; value: { key: string; nodeId: string } }[];
            };
            for (const r of rows ?? []) kvStore.set(r.key, r.value);
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ ok: true }),
            });
          }
          default:
            return route.fallback();
        }
      },
    );

    await page.goto("/");
    await expect(
      page.locator('li[data-node-id="alpha"] > .outline-row > .node-text'),
    ).toBeVisible();

    await todayButton(page).click();

    await expect(page).toHaveURL(/ghost-today$/);
    await expect(page.getByText("That bullet doesn't exist")).toHaveCount(0);
    const year = String(d.getFullYear());
    await expect(page.locator("h2.zoomed-title .node-text")).toContainText(year);

    await goHome(page);
    await expect(page.locator('li[data-node-id="ghost-container"]')).toHaveCount(
      1,
    );
    await expect(page.locator('li[data-node-id="ghost-today"]')).toHaveCount(1);
    await expect(page.locator("[data-daily-date]")).toHaveText("Today");
  });

  test("the Daily container resists deletion; ordinary nodes still delete", async ({
    page,
  }) => {
    await load(page);
    await todayButton(page).click();
    await goHome(page);

    // Force-delete (Mod+Shift+Backspace) the protected container: a no-op.
    await rowWithText(page, "Daily").locator(".node-text").click();
    await page.keyboard.press(`${modifier()}+Shift+Backspace`);
    await expect(rowWithText(page, "Daily")).toBeVisible();

    // The same gesture DOES delete an ordinary node -- the guard is specific.
    await page
      .locator('li[data-node-id="bravo"] > .outline-row > .node-text')
      .click();
    await page.keyboard.press(`${modifier()}+Shift+Backspace`);
    await expect(page.locator('li[data-node-id="bravo"]')).toHaveCount(0);
  });
});
