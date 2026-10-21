import { expect, test, type Page } from "@playwright/test";
import { Schema } from "effect";
import { readFileSync } from "node:fs";

import { openSeededOutline, seedOutline, STANDARD_TREE } from "./fixtures";

/**
 * The changelog (ADR 0046): a "What's new" dialog reached from the App menu and
 * Cmd+K, with an unread signal (a dot on the avatar, plus emphasis on the
 * "What's new" item) driven by a synced cursor.
 *
 * The release array is BUILD-TIME data (`virtual:dotflowy-changelog`), so there
 * is no fixture to seed. `package.json`'s version IS the latest release — that
 * equality is the build-time invariant this whole feature rests on, so leaning
 * on it here costs nothing and never goes stale.
 *
 * An archived older release exercises the avatar's unread signal and clearing.
 * Unknown-version handling belongs to `src/data/changelog.test.ts`.
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
const cursor = (lastSeenVersion: string) => ({
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
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            rows: Schema.Array(
              Schema.Struct({
                value: Schema.Struct({ lastSeenVersion: Schema.String }),
              }),
            ),
          }),
        )(route.request().postDataJSON());
        for (const row of body.rows ?? []) {
          if (row.value?.lastSeenVersion)
            writes.push(row.value.lastSeenVersion);
        }
      }
      await route.fallback();
    },
  );

  await openSeededOutline(page, { anchorId: "alpha" });
  return writes;
}

test("a fresh account is seeded silently -- no badge for a release it never missed", async ({
  page,
}) => {
  const writes = await load(page);

  // The seed is the assertion: the cursor jumps straight to the latest release
  // and the badge never appears. Firing it here would teach a brand-new user,
  // on day one, that the badge isn't about change.
  await expect.poll(() => writes).toEqual([LATEST]);
  await expect(badge(page)).toHaveCount(0);

  await page.getByRole("button", { name: /Account and help/ }).click();
  await whatsNewItem(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId("changelog-release").first()).toContainText(
    LATEST,
  );
});

test("a caught-up account shows no badge, and does not re-seed", async ({
  page,
}) => {
  const writes = await load(page, cursor(LATEST));

  // Open + close the App menu so the header has demonstrably settled: "not
  // rendered yet" must not masquerade as "correctly hidden".
  await page.getByRole("button", { name: /Account and help/ }).click();
  await expect(whatsNewItem(page)).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(badge(page)).toHaveCount(0);
  expect(writes).toEqual([]);

  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("changelog");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
});

test("opening What's new clears the avatar's unread signal and advances the cursor", async ({
  page,
}) => {
  const writes = await load(page, cursor("0.1.0"));
  const app = page.getByRole("button", { name: /Account and help/ });
  await expect(app.locator("[data-changelog-dot]")).toHaveCount(1);
  await expect(
    page
      .getByRole("button", { name: "View options" })
      .locator("[data-changelog-dot]"),
  ).toHaveCount(0);
  expect(writes).toEqual([]);

  await app.click();
  const unread = page.getByRole("menuitem", { name: /What's new/ });
  await expect(unread).toHaveAttribute("data-unseen");
  await expect(unread).toContainText(/\d+/);
  await unread.click();
  await expect(dialog(page)).toBeVisible();

  await expect.poll(() => writes).toEqual([LATEST]);
  await expect(badge(page)).toHaveCount(0);
});
