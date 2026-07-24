import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

import { isE2eLunora, seedOutline, STANDARD_TREE } from "./fixtures";

/**
 * The changelog (ADR 0046): a "What's new" dialog reached from the More menu and
 * Cmd+K, with an unread signal (a dot on the More trigger, plus emphasis on the
 * "What's new" item) driven by a synced cursor.
 *
 * The release array is BUILD-TIME data (`virtual:dotflowy-changelog`), so there
 * is no fixture to seed. `package.json`'s version IS the latest release — that
 * equality is the build-time invariant this whole feature rests on, so leaning
 * on it here costs nothing and never goes stale.
 *
 * The **badge-visible** branch is not reachable from here yet: it needs a cursor
 * pointing at a release that is older than the latest AND still archived, and
 * with a single archived release no such value exists (an unknown cursor stays
 * quiet, deliberately). It is covered by `unseenCount` in
 * `src/data/changelog.test.ts`, and becomes reachable here at the second release.
 */

const LATEST: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const badge = (page: Page) => page.locator("[data-changelog-dot]");
const dialog = (page: Page) => page.getByTestId("changelog-dialog");
const whatsNewItem = (page: Page) =>
  page.getByRole("menuitem", { name: "What's new" });

type Kv = Record<string, { key: string; value: unknown }[]>;

/** The kv row shape `changelog-cursor.ts` reads. */
const cursor = (lastSeenVersion: string): Kv => ({
  changelog: [{ key: "cursor", value: { id: "cursor", lastSeenVersion } }],
});

/**
 * Boot the app, and return every `lastSeenVersion` it writes (newest last).
 *
 * The spy is registered AFTER `seedOutline` on purpose: Playwright runs the
 * most-recently-registered matching handler first, so this one observes the
 * request and then `fallback()`s into the fixture's kv mock, which actually
 * stores it. Registering it first would let the fixture fulfil the route and
 * this handler would never run.
 */
async function load(page: Page, kv?: Kv): Promise<string[]> {
  await seedOutline(page, STANDARD_TREE, kv ? { kv } : {});

  const writes: string[] = [];
  await page.route(
    (url) =>
      url.pathname === "/api/kv" &&
      url.searchParams.get("collection") === "changelog",
    async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as {
          rows?: { value?: { lastSeenVersion?: string } }[];
        };
        for (const row of body.rows ?? []) {
          if (row.value?.lastSeenVersion)
            writes.push(row.value.lastSeenVersion);
        }
      }
      await route.fallback();
    },
  );

  await page.goto("/");
  await expect(page.locator('li[data-node-id="alpha"]')).toBeVisible();
  return writes;
}

test.describe("changelog", () => {
  test("a fresh account is seeded silently -- no badge for a release it never missed", async ({
    page,
  }) => {
    const writes = await load(page);

    // The seed is the assertion: the cursor jumps straight to the latest release
    // and the badge never appears. Firing it here would teach a brand-new user,
    // on day one, that the badge isn't about change.
    await expect.poll(() => writes).toEqual([LATEST]);
    await expect(badge(page)).toHaveCount(0);
  });

  test("a caught-up account shows no badge, and does not re-seed", async ({
    page,
  }) => {
    test.skip(
      isE2eLunora(),
      "seeds the cursor through the classic /api/kv mock",
    );
    const writes = await load(page, cursor(LATEST));

    // Open + close the More menu so the header has demonstrably settled: "not
    // rendered yet" must not masquerade as "correctly hidden".
    await page.getByTitle("More").click();
    await expect(whatsNewItem(page)).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(badge(page)).toHaveCount(0);
    expect(writes).toEqual([]);
  });

  test("the More menu opens the dialog, newest release first", async ({
    page,
  }) => {
    await load(page);
    await page.getByTitle("More").click();
    await whatsNewItem(page).click();

    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId("changelog-release").first()).toContainText(
      LATEST,
    );
  });

  test("Cmd+K opens the dialog", async ({ page }) => {
    await load(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("changelog");
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
  });

  test("opening it advances the cursor to the latest release", async ({
    page,
  }) => {
    test.skip(
      isE2eLunora(),
      "asserts cursor writes through the classic /api/kv mock",
    );
    // A cursor this build has never heard of: no badge (an unknown version stays
    // quiet) and no silent seed (a row already exists) -- so the only write that
    // can happen is the one the dialog itself makes.
    const writes = await load(page, cursor("0.0.0-not-a-real-release"));
    await expect(badge(page)).toHaveCount(0);
    expect(writes).toEqual([]);

    await page.getByTitle("More").click();
    await whatsNewItem(page).click();
    await expect(dialog(page)).toBeVisible();

    await expect.poll(() => writes).toEqual([LATEST]);
  });
});
