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
    page.locator('li[data-node-id="alpha"] > .outline-row .node-text'),
  ).toBeVisible();
}

// The breadcrumb's leading icon button zooms back to the top. It's a CLIENT
// navigation, so the seedOutline init script does not re-run and wipe the nodes
// created at runtime (a full reload would).
async function goHome(page: Page) {
  await page.locator("nav.breadcrumb button").first().click();
  await expect(page).toHaveURL(/\/$/);
}

async function clientNavigate(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

// Open the Cmd+K node switcher and type a query. cmdk autofocuses its input a
// beat AFTER the dialog mounts; when Cmd+K fires right after a navigation, the
// editor's post-nav focus effect can win that race and the dialog input never
// takes focus, so typed keys land on the outline and are dropped (harmless at
// human speed — seconds pass before you type — but deterministic at test speed).
// Click the input to deterministically own focus, confirm it stuck, then type.
async function openSwitcherAndType(page: Page, text: string) {
  await page.keyboard.press(`${modifier()}+k`);
  const input = page.getByPlaceholder("Search nodes and actions...");
  await expect(input).toBeVisible();
  await input.click();
  await expect(input).toBeFocused();
  await page.keyboard.type(text);
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
    // Today's badge wears the distinct (primary) treatment -- the data hook the
    // variant swap sets only when the key is today.
    await expect(badge).toHaveAttribute("data-daily-today", "");
  });

  test("/today seeds an entry line and lands the caret on it (write-intent, ADR 0041)", async ({
    page,
  }) => {
    await load(page);
    // Client-nav to /today so the seedOutline mock survives (a full reload
    // re-runs the init script). The route creates today's note, seeds ONE empty
    // entry line, and redirects to /$nodeId?focus=last.
    await clientNavigate(page, "/today");

    // Redirected off /today, into today's note (title = the full date).
    await expect(page).not.toHaveURL(/today/);
    const year = String(new Date().getFullYear());
    await expect(page.locator("h2.zoomed-title .node-text")).toContainText(year);

    // A single empty entry line was seeded under the day, and the caret landed
    // ON it (focus=last) -- the day opens ready to append, not on the title.
    // (The old tests only checked the redirect + badge, which is why the dead
    // focus=last shipped green.)
    const entry = page.locator("li[data-node-id] > .outline-row .node-text");
    await expect(entry).toHaveCount(1);
    await expect(entry).toBeFocused();
    await expect(entry).toHaveText("");
  });

  test("only today's note gets the distinct badge; other days stay plain", async ({
    page,
  }) => {
    // A day note from the past renders the muted badge (its short date) with NO
    // `data-daily-today` hook -- the primary highlight is reserved for today.
    // Seeded like the lock test: a real node PLUS its daily-index mapping.
    const d = new Date();
    d.setDate(d.getDate() - 10);
    const pastKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(d.getDate()).padStart(2, "0")}`;

    await seedOutline(
      page,
      [
        { id: "daily-container", parentId: null, prevSiblingId: null, text: "Daily" },
        {
          id: "past-day",
          parentId: "daily-container",
          prevSiblingId: null,
          text: "A past day",
        },
      ],
      {
        kv: {
          "daily-index": [
            {
              key: "container",
              value: { key: "container", nodeId: "daily-container" },
            },
            { key: pastKey, value: { key: pastKey, nodeId: "past-day" } },
          ],
        },
      },
    );
    await page.goto("/");

    const badge = page.locator("[data-daily-date]");
    await expect(badge).toBeVisible();
    // It's the past day's badge: not "Today", and without the today-only hook.
    await expect(badge).not.toHaveText("Today");
    await expect(badge).not.toHaveAttribute("data-daily-today");
  });

  test("the zoomed-in day note carries its date badge in the title", async ({
    page,
  }) => {
    await load(page);

    // Today zooms INTO today's note, so it's the page title (h2), not a list
    // bullet. The badge is a title slot (Seam F, `title:before-text`), so it must
    // render here too -- with the same primary "today" treatment.
    await todayButton(page).click();
    await expect(page).toHaveURL(/\/[^/]+$/);

    const titleBadge = page.locator("h2.zoomed-title [data-daily-date]");
    await expect(titleBadge).toBeVisible();
    await expect(titleBadge).toContainText("Today");
    await expect(titleBadge).toHaveAttribute("data-daily-today", "");
  });

  test("deleting the protected Daily container shakes it instead of removing it", async ({
    page,
  }) => {
    await load(page);

    // Materialize the protected container (+ today's note), then go home so the
    // "Daily" container row sits in the list.
    await todayButton(page).click();
    await expect(page).toHaveURL(/\/[^/]+$/);
    await goHome(page);

    const container = rowWithText(page, "Daily");
    await expect(container).toBeVisible();

    // The protected row wears an always-on lock signifier.
    await expect(container.locator(".protected-lock")).toBeVisible();

    // Focus the container's own text and fire the subtree-delete hotkey
    // (Mod+Shift+Backspace -> the single onDeleteNode funnel).
    await container.locator(".node-text").click();
    await page.keyboard.press(`${modifier()}+Shift+Backspace`);

    // It refuses: the row carries the one-shot reject class bound to the shake
    // keyframe (confirms rejectRow wired through the isProtected branch), and
    // the container is still present -- nothing was deleted.
    await expect(container).toHaveClass(/node-rejected/);
    await expect(
      container.evaluate((el) => getComputedStyle(el).animationName),
    ).resolves.toBe("node-rejected-shake");
    await expect(container).toBeVisible();

    // ...and a toast spells out *why* it can't go (the plugin's reason).
    await expect(page.getByText(/can't be deleted/i)).toBeVisible();

    // The class clears itself when the animation ends (so it can re-trigger).
    await expect(container).not.toHaveClass(/node-rejected/, { timeout: 4000 });
  });

  test("an existing Daily container shows its lock on first load, before any zoom", async ({
    page,
  }) => {
    // The container is already here from a prior session: a real outline node
    // PLUS the daily-index `container -> nodeId` mapping that marks it protected.
    // That mapping loads async (the kv GET), and this load never navigates -- so
    // the lock must appear when the index resolves, NOT only after a re-render
    // forced by zooming in and back out. (The bug this guards: a render-time
    // `isProtected` read with no subscription to the index, so the lock showed
    // late.) The other protection specs always navigate first, masking it.
    await seedOutline(
      page,
      [{ id: "daily-container", parentId: null, prevSiblingId: null, text: "Daily" }],
      {
        kv: {
          "daily-index": [
            {
              key: "container",
              value: { key: "container", nodeId: "daily-container" },
            },
          ],
        },
      },
    );
    await page.goto("/");

    const container = rowWithText(page, "Daily");
    await expect(container).toBeVisible();
    await expect(container.locator(".protected-lock")).toBeVisible();
  });

  test("blanking the protected Daily container restores its name and explains on blur", async ({
    page,
  }) => {
    await load(page);

    await todayButton(page).click();
    await expect(page).toHaveURL(/\/[^/]+$/);
    await goHome(page);

    // The container's id is a UUID; capture it so we can target the row even
    // while its text is momentarily empty.
    const containerId = await rowWithText(page, "Daily").evaluate(
      (el) => el.closest("li[data-node-id]")?.getAttribute("data-node-id") ?? "",
    );
    expect(containerId).not.toBe("");
    const containerText = page.locator(
      `li[data-node-id="${containerId}"] > .outline-row .node-text`,
    );

    // Select the whole word and delete it through the real input path (selecting
    // the contents directly -- arrow/select-all keys are unreliable in macOS
    // Chromium contentEditable; see enter-split.spec).
    await containerText.click();
    await containerText.evaluate((el) => {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    await page.keyboard.press("Backspace");
    // Editing is unfought: the field is allowed to sit empty mid-edit (no
    // silent instant snap-back that would hide the reason).
    await expect(containerText).toHaveText("");

    // Blur by focusing another bullet -> the name heals AND a toast explains
    // why, so the restore isn't a mystery.
    await page
      .locator('li[data-node-id="alpha"] > .outline-row .node-text')
      .click();
    await expect(containerText).toHaveText("Daily");
    await expect(page.getByText(/needs a name/i)).toBeVisible();
  });

  test("the protected Daily container can't be turned into a to-do", async ({
    page,
  }) => {
    await load(page);

    await todayButton(page).click();
    await expect(page).toHaveURL(/\/[^/]+$/);
    await goHome(page);

    const containerId = await rowWithText(page, "Daily").evaluate(
      (el) => el.closest("li[data-node-id]")?.getAttribute("data-node-id") ?? "",
    );
    expect(containerId).not.toBe("");
    const containerRow = page.locator(
      `li[data-node-id="${containerId}"] > .outline-row`,
    );

    // Run /todo on the container (the conversion the daily plugin forbids).
    await containerRow.locator(".node-text").click();
    await page.keyboard.type(" /todo");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("option", { name: /Turn into a To-do/i }).click();

    // Rejected: it stays a plain bullet (no checkbox) and a toast explains why.
    await expect(containerRow.locator(".checkbox")).toHaveCount(0);
    await expect(page.getByText(/can't be a to-do/i)).toBeVisible();
    // ...and it still wears its lock, now leading the text.
    await expect(containerRow.locator(".protected-lock")).toBeVisible();
  });

  test("the protected Daily container can't be completed", async ({ page }) => {
    await load(page);

    await todayButton(page).click();
    await expect(page).toHaveURL(/\/[^/]+$/);
    await goHome(page);

    const containerId = await rowWithText(page, "Daily").evaluate(
      (el) => el.closest("li[data-node-id]")?.getAttribute("data-node-id") ?? "",
    );
    expect(containerId).not.toBe("");
    const containerRow = page.locator(
      `li[data-node-id="${containerId}"] > .outline-row`,
    );
    const containerText = containerRow.locator(".node-text");

    // Mod+Enter (the completion hotkey, Seam D) on the container: completing it
    // would strike through every day note under it, so the daily plugin forbids
    // it. The single onToggleCompleted funnel rejects.
    await containerText.click();
    await page.keyboard.press(`${modifier()}+Enter`);

    // Rejected: it stays un-done, the row shakes, and a toast explains why.
    await expect(containerText).toHaveAttribute("data-completed", "false");
    await expect(containerRow).toHaveClass(/node-rejected/);
    await expect(page.getByText(/can't be completed/i)).toBeVisible();
  });

  test("the protected Daily container can't be completed when zoomed in as the title", async ({
    page,
  }) => {
    await load(page);

    await todayButton(page).click();
    await expect(page).toHaveURL(/\/[^/]+$/);
    await goHome(page);

    // Zoom INTO the container so it becomes the page title (not a list bullet).
    await rowWithText(page, "Daily").locator(".bullet").click();
    const title = page.locator("h2.zoomed-title");
    const titleText = title.locator(".node-text");
    await expect(titleText).toHaveText("Daily");
    // The protection affordance follows the node when zoomed: the title wears
    // the same lock.
    await expect(title.locator(".protected-lock")).toBeVisible();

    // The completion rule applies to the zoomed node too: Mod+Enter on the
    // title routes through the same funnel and is rejected.
    await titleText.click();
    await page.keyboard.press(`${modifier()}+Enter`);

    await expect(titleText).toHaveAttribute("data-completed", "false");
    await expect(page.getByText(/can't be completed/i)).toBeVisible();
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
      'li[data-node-id="charlie"] > .outline-row .node-text',
    );
    await charlie.click();
    await expect(charlie).toBeFocused();
    await page.keyboard.type(" /today");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Enter");

    // Confirming toast, and the node -- a top-level sibling before -- now nests
    // under the Daily container's today note (creating both on first use).
    await expect(page.getByText("Moved to Today")).toBeVisible();
    // charlie now nests under TODAY's note (itself a child of the Daily
    // container). The flat render has no nested <li> (ADR 0019), so assert
    // charlie's real parent is the today note -- located by its "today" badge.
    const todayId = await page
      .locator("li[data-node-id] [data-daily-today]")
      .first()
      .evaluate(
        (el) =>
          el.closest("li[data-node-id]")?.getAttribute("data-node-id") ?? "",
      );
    expect(todayId).not.toBe("");
    await expect(
      page.locator(`li[data-node-id="charlie"][data-parent-id="${todayId}"]`),
    ).toBeVisible();
  });

  test("Cmd+K 'today' offers a create-today action when the note is absent", async ({
    page,
  }) => {
    await load(page);

    await openSwitcherAndType(page, "today");

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
    // Let the create+zoom settle before going home: the daily nav is async
    // (fire-and-forget from the click), so without this wait it can race the
    // home nav and land last, leaving us on the day. See the other Today tests.
    await expect(page).toHaveURL(/\/[^/]+$/);
    await goHome(page);

    await openSwitcherAndType(page, "today");

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
      page.locator('li[data-node-id="alpha"] > .outline-row .node-text'),
    ).toBeVisible();

    await todayButton(page).click();

    // Adopted the winner -> navigated to race-today, never a freshly minted id.
    // The Today button is a write-intent surface (ADR 0041), so it lands with
    // ?focus=last -- match race-today whether or not the query trails.
    await expect(page).toHaveURL(/race-today(\?|$)/);

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
      page.locator('li[data-node-id="alpha"] > .outline-row .node-text'),
    ).toBeVisible();

    await todayButton(page).click();

    // Write-intent nav (ADR 0041) lands with ?focus=last; match either way.
    await expect(page).toHaveURL(/ghost-today(\?|$)/);
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
    // Settle the async create+zoom before going home (see the other Today tests).
    await expect(page).toHaveURL(/\/[^/]+$/);
    await goHome(page);

    // Force-delete (Mod+Shift+Backspace) the protected container: a no-op.
    await rowWithText(page, "Daily").locator(".node-text").click();
    await page.keyboard.press(`${modifier()}+Shift+Backspace`);
    await expect(rowWithText(page, "Daily")).toBeVisible();

    // The same gesture DOES delete an ordinary node -- the guard is specific.
    await page
      .locator('li[data-node-id="bravo"] > .outline-row .node-text')
      .click();
    await page.keyboard.press(`${modifier()}+Shift+Backspace`);
    await expect(page.locator('li[data-node-id="bravo"]')).toHaveCount(0);
  });

  test("/today redirects to today's daily note, creating it on first visit", async ({
    page,
  }) => {
    await seedOutline(page, STANDARD_TREE);
    await page.goto("/today");

    // The redirect is async (wait for collection ready + get-or-create day),
    // so wait for it to leave /today before asserting the zoom view.
    await expect(page).not.toHaveURL(/\/today$/, { timeout: 15000 });
    await expect(page).not.toHaveURL(/\/$/, { timeout: 10000 });
    const year = String(new Date().getFullYear());
    await expect(page.locator("h2.zoomed-title .node-text")).toContainText(year);

    const titleBadge = page.locator("h2.zoomed-title [data-daily-date]");
    await expect(titleBadge).toBeVisible();
    await expect(titleBadge).toHaveAttribute("data-daily-today", "");
  });

  test("/today is idempotent: a second visit lands on the same note", async ({
    page,
  }) => {
    await seedOutline(page, STANDARD_TREE);
    await page.goto("/today");
    await expect(page).not.toHaveURL(/\/today$/, { timeout: 15000 });
    const firstUrl = page.url();

    await goHome(page);
    await clientNavigate(page, "/today");
    await expect(page).toHaveURL(firstUrl);

    await goHome(page);
    await expect(page.locator("[data-daily-date]")).toHaveCount(1);
  });
});
