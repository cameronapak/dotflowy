import { expect, test, type Page } from "@playwright/test";

import {
  openSeededOutline,
  placeCaret,
  seedOutline,
  type ApiNode,
  type SeedNode,
} from "./fixtures";

test.use({ deviceScaleFactor: 2 });

const URL = "https://www.youtube.com/watch?v=M7lc1UVf-VE&t=90";
const SRC = "https://www.youtube.com/embed/M7lc1UVf-VE?start=90";
const TREE: SeedNode[] = [
  {
    id: "media",
    parentId: null,
    prevSiblingId: null,
    text: URL,
    kind: "embed",
  },
  {
    id: "note",
    parentId: "media",
    prevSiblingId: null,
    text: "My notes stay editable",
  },
  {
    id: "next",
    parentId: null,
    prevSiblingId: "media",
    text: "Continue writing here",
  },
];
const allowed = {
  key: "external-embeds",
  value: { key: "external-embeds", enabled: true },
};
const body = (page: Page) => page.locator('[data-node-body="media"]');
const note = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] .node-text`);

async function openPermission(page: Page) {
  await body(page).getByRole("button", { name: "Load embed" }).click();
  return page.getByRole("dialog", { name: "Allow external embeds?" });
}

async function mockProvider(page: Page) {
  let requests = 0;
  await page.route("**/api/embeds?**", (route) => {
    requests++;
    return route.fulfill({
      json: {
        embed: {
          provider: "youtube",
          src: SRC,
          width: 480,
          height: 360,
          title: "Official player test fixture",
        },
      },
    });
  });
  await page.route("https://www.youtube.com/embed/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0;background:#202020;color:white;display:grid;place-items:center;height:100vh;font:18px sans-serif">Provider frame (test fixture)</body></html>',
    }),
  );
  return () => requests;
}

test("consent defaults off, persists before loading, revokes and survives reload", async ({
  page,
}) => {
  const requests = await mockProvider(page);
  await seedOutline(page, TREE);
  await page.goto("/");
  await expect(
    body(page).getByRole("button", { name: "Load embed" }),
  ).toBeEnabled({ timeout: 15000 });
  expect(requests()).toBe(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.screenshot({ path: ".amp/in/artifacts/embed-consent.png" });

  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/kv**", async (route) => {
    if (route.request().method() === "POST") await hold;
    await route.fallback();
  });
  const permission = await openPermission(page);
  await permission.getByRole("button", { name: "Allow embeds" }).click();
  await expect(
    permission.getByRole("button", { name: "Saving permission" }),
  ).toBeDisabled();
  expect(requests()).toBe(0);
  release();
  await expect(body(page).locator("iframe")).toHaveAttribute("src", SRC);
  await expect(body(page).locator("iframe")).toHaveCSS("opacity", "1");
  const frame = await body(page).locator("iframe").boundingBox();
  expect(frame!.width / frame!.height).toBeCloseTo(4 / 3, 1);
  await expect(note(page, "note")).toHaveText("My notes stay editable");
  await page.screenshot({ path: ".amp/in/artifacts/embed-loaded.png" });
  await page.evaluate(async () => {
    const modulePath = "/src/data/editor-features.ts";
    const { setExternalEmbeds } = await import(modulePath);
    await setExternalEmbeds(false);
  });
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.reload();
  await expect(
    body(page).getByRole("button", { name: "Load embed" }),
  ).toBeEnabled();
  expect(requests()).toBe(1);
});

test("failed permission write makes zero embed requests", async ({ page }) => {
  const requests = await mockProvider(page);
  await seedOutline(page, TREE);
  await page.route("**/api/kv**", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 403, json: { error: "test rejection" } })
      : route.fallback(),
  );
  await page.goto("/");
  const permission = await openPermission(page);
  await permission.getByRole("button", { name: "Allow embeds" }).click();
  await expect(permission.getByRole("alert")).toContainText(
    "Couldn't save permission",
  );
  expect(requests()).toBe(0);
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("disabled plugin keeps source links and children without provider requests", async ({
  page,
}) => {
  const requests = await mockProvider(page);
  await seedOutline(page, TREE, {
    kv: {
      "account-prefs": [
        allowed,
        {
          key: "editor-feature:embeds",
          value: { key: "editor-feature:embeds", enabled: false },
        },
      ],
    },
  });
  await openSeededOutline(page, { anchorId: "media" });
  await expect(note(page, "media").getByRole("link")).toHaveAttribute(
    "href",
    URL,
  );
  await expect(body(page).locator("[data-embed-body]")).toHaveCount(0);
  expect(requests()).toBe(0);
  await expect(note(page, "note")).toBeVisible();
  await page.goto("/media");
  await expect(
    page.locator(".zoomed-title-text").getByRole("link"),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("provider failure keeps notes and falls back to Link", async ({
  page,
}) => {
  await page.route("**/api/embeds?**", (route) =>
    route.fulfill({ json: { embed: null } }),
  );
  await page.route("**/api/unfurl?**", (route) =>
    route.fulfill({ json: { title: "Fallback title" } }),
  );
  await seedOutline(page, TREE, { kv: { "account-prefs": [allowed] } });
  await page.goto("/");
  await expect(
    page.getByText("URL couldn’t be embedded, kept as a link instead."),
  ).toBeVisible();
  await expect(note(page, "media").getByRole("link")).toHaveText(
    "Fallback title",
  );
  await expect(note(page, "note")).toBeVisible();
  await page.screenshot({ path: ".amp/in/artifacts/embed-unavailable.png" });
  await expect(page.locator("iframe")).toHaveCount(0);
  const nodes: ApiNode[] = await page.evaluate(() =>
    fetch("/api/nodes").then((r) => r.json()),
  );
  expect(nodes.find((node) => node.id === "media")).toMatchObject({
    kind: null,
    text: `[Fallback title](${URL})`,
  });
});

test("X uses the official client widget without sending tweet data to the Worker", async ({
  page,
}) => {
  let workerRequests = 0;
  await page.route("**/api/embeds?**", (route) => {
    workerRequests++;
    return route.fulfill({ json: { embed: null } });
  });
  await page.route("https://platform.twitter.com/widgets.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.twttr={widgets:{createTweet:async(id,element,options)=>{const tweet=document.createElement("article");tweet.setAttribute("data-testid","official-x-widget");tweet.style.cssText="float:left;width:100%;height:225px;margin:10px 0";tweet.textContent="Tweet "+id+" (dnt: "+options.dnt+", align: "+options.align+")";element.append(tweet);return tweet}}};`,
    }),
  );
  await seedOutline(
    page,
    [
      {
        id: "media",
        parentId: null,
        prevSiblingId: null,
        text: "https://x.com/user/status/123456",
        kind: "embed",
      },
    ],
    { kv: { "account-prefs": [allowed] } },
  );
  await openSeededOutline(page, { anchorId: "media" });
  await expect(page.getByTestId("official-x-widget")).toHaveText(
    "Tweet 123456 (dnt: true, align: left)",
  );
  // The real left-aligned widget floats and grows after its initial render.
  // Both the body and following rows must accommodate its full outer height.
  const reveal = body(page).locator("[data-embed-reveal]");
  await expect(reveal).toHaveCSS("height", "245px");
  await page.getByTestId("official-x-widget").evaluate((el) => {
    el.style.height = "310px";
  });
  await expect(reveal).toHaveCSS("height", "330px");
  expect(workerRequests).toBe(0);
});

test("paste waits for a choice and the same menu transforms every pure display", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let unfurlRequests = 0;
  await seedOutline(page, [
    { id: "plain", parentId: null, prevSiblingId: null, text: "" },
    { id: "link", parentId: null, prevSiblingId: "plain", text: "" },
    { id: "media", parentId: null, prevSiblingId: "link", text: "" },
  ]);
  await page.route("**/api/unfurl?**", async (route) => {
    unfurlRequests++;
    await hold;
    await route.fulfill({ json: { title: "Late title" } });
  });
  await page.goto("/");
  const paste = async (id: string) => {
    await note(page, id).focus();
    await note(page, id).evaluate((el, url) => {
      const data = new DataTransfer();
      data.setData("text/plain", url);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, URL);
    await expect(
      page.getByRole("menuitemradio", { name: "Link Title", exact: true }),
    ).toBeFocused();
  };

  await paste("plain");
  expect(unfurlRequests).toBe(0);
  await expect(
    page.getByRole("menuitemradio", { name: "Plain URL" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(note(page, "plain")).toHaveText(URL);
  expect(unfurlRequests).toBe(0);

  await paste("link");
  expect(unfurlRequests).toBe(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => unfurlRequests).toBe(1);
  release();
  await expect(note(page, "link")).toContainText("Late title");

  await paste("media");
  expect(unfurlRequests).toBe(1);
  await page.getByRole("menuitemradio", { name: "Embed" }).click();
  expect(unfurlRequests).toBe(1);
  await expect(note(page, "media")).toHaveText(URL);
  await expect(
    page.getByRole("dialog", { name: "Allow external embeds?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();

  await note(page, "media").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(note(page, "media")).toHaveText(URL);
  const nodes: ApiNode[] = await page.evaluate(() =>
    fetch("/api/nodes").then((r) => r.json()),
  );
  expect(nodes.filter((n) => n.kind === "embed")).toHaveLength(1);
  expect(nodes.find((n) => n.id !== "media" && n.text === "")?.text).toBe("");

  const displayButton = page
    .locator('li[data-node-id="media"]')
    .getByRole("button", { name: "Edit link" });
  await displayButton.click();
  const editor = page.getByRole("dialog", { name: "Edit link" });
  await expect(
    editor.getByRole("button", { name: "Embed", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await editor.getByRole("button", { name: "Link Title", exact: true }).click();
  await expect(note(page, "media")).toHaveText(URL);
  expect(unfurlRequests).toBe(1);
  await editor.getByRole("button", { name: "Done" }).click();
  await note(page, "media").blur();
  await expect(note(page, "media").getByRole("link")).toHaveText("Late title");
  expect(unfurlRequests).toBe(2);
  await expect(editor).toHaveCount(0);

  // Link keeps the same affordance, so conversion is reversible without paste.
  await displayButton.click();
  await expect(
    editor.getByRole("button", { name: "Link Title", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await editor.getByRole("button", { name: "Plain URL" }).click();
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(note(page, "media")).toHaveText(URL);
  await expect(displayButton).toBeVisible();
  const converted: ApiNode[] = await page.evaluate(() =>
    fetch("/api/nodes").then((r) => r.json()),
  );
  expect(converted.find((node) => node.id === "media")).toMatchObject({
    kind: null,
    text: URL,
  });
});

test("unsupported URLs offer display choices without fetching until Link Title is chosen", async ({
  page,
}) => {
  let requests = 0;
  await seedOutline(page, [
    { id: "plain", parentId: null, prevSiblingId: null, text: "" },
  ]);
  await page.route("**/api/unfurl?**", (route) => {
    requests++;
    return route.fulfill({ json: { title: "YouVersion Platform" } });
  });
  await page.goto("/");
  await note(page, "plain").focus();
  await note(page, "plain").evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "https://platform.youversion.com/");
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(
    page.getByRole("menuitemradio", { name: "Link Title" }),
  ).toBeFocused();
  await expect(
    page.getByRole("menuitemradio", { name: "Embed", exact: true }),
  ).toBeDisabled();
  expect(requests).toBe(0);
  await page.screenshot({
    path: ".amp/in/artifacts/embed-unsupported-paste.png",
  });
  await page.getByRole("menuitemradio", { name: "Link Title" }).click();
  await note(page, "plain").blur();
  await expect(note(page, "plain").getByRole("link")).toHaveText(
    "YouVersion Platform",
  );
  expect(requests).toBe(1);
});

test("title and narrow viewport retain aspect ratio and reduced-motion fades are disabled", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await mockProvider(page);
  await seedOutline(page, TREE, { kv: { "account-prefs": [allowed] } });
  await page.goto("/media");
  const frame = body(page).locator("iframe");
  await expect(frame).toHaveCSS("opacity", "1", { timeout: 15000 });
  await expect(frame).toHaveCSS("transition-duration", "0s");
  await expect(note(page, "note")).toBeVisible();
  const frameBox = await frame.boundingBox();
  const noteBox = await note(page, "note").boundingBox();
  expect(frameBox!.width).toBeGreaterThanOrEqual(340);
  expect(noteBox!.y).toBeGreaterThan(frameBox!.y + frameBox!.height);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: ".amp/in/artifacts/embed-mobile-title.png" });
});

test("mobile row embed aligns with its node content", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 590 });
  await mockProvider(page);
  await seedOutline(page, TREE, { kv: { "account-prefs": [allowed] } });
  await page.goto("/");
  const frame = body(page).locator("iframe");
  await expect(frame).toHaveCSS("opacity", "1", { timeout: 15000 });
  const frameBox = await frame.boundingBox();
  const contentBox = await page
    .locator('li[data-node-id="media"] .row-body')
    .boundingBox();
  expect(frameBox!.x).toBeCloseTo(contentBox!.x, 0);
  expect(frameBox!.width).toBeCloseTo(contentBox!.width, 0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.screenshot({ path: ".amp/in/artifacts/embed-mobile-row.png" });
});

test.describe("narrow touch provider layout", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("Spotify and X embeds fit the full mobile outline width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 590 });
    await page.route("**/api/embeds?**", (route) =>
      route.fulfill({
        json: {
          embed: {
            provider: "spotify",
            src: "https://open.spotify.com/embed/episode/4rOoJ6Egrf8K2IrywzwOMk",
            width: 456,
            height: 152,
            title: "Spotify player test fixture",
          },
        },
      }),
    );
    await page.route("https://open.spotify.com/embed/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "Spotify fixture" }),
    );
    await page.route("https://platform.twitter.com/widgets.js", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `window.twttr={widgets:{createTweet:async(id,element)=>{const tweet=document.createElement("article");tweet.setAttribute("data-testid","official-x-widget");tweet.style.cssText="width:100%;min-width:250px;height:180px;display:grid;place-items:center;border:1px solid #555;border-radius:8px;background:#202020;color:white";tweet.textContent="Tweet "+id;element.append(tweet);return tweet}}};`,
      }),
    );
    await seedOutline(
      page,
      [
        {
          id: "media",
          parentId: null,
          prevSiblingId: null,
          text: "https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk",
          kind: "embed",
        },
        {
          id: "tweet",
          parentId: null,
          prevSiblingId: "media",
          text: "https://x.com/jack/status/20",
          kind: "embed",
        },
      ],
      { kv: { "account-prefs": [allowed] } },
    );
    await page.goto("/");
    const spotify = body(page).locator(".embed-frame");
    const x = page.locator('[data-node-body="tweet"] [data-x-embed]');
    await expect(spotify.locator("iframe")).toHaveCSS("opacity", "1", {
      timeout: 15000,
    });
    await expect(page.getByTestId("official-x-widget")).toBeVisible();
    for (const embed of [spotify, x]) {
      const box = await embed.boundingBox();
      const contentBox = await embed.evaluate((el) => {
        const cell = el.closest(".row-body")!;
        const rect = cell.getBoundingClientRect();
        return {
          x: rect.x,
          width:
            rect.width - parseFloat(getComputedStyle(cell).paddingInlineEnd),
        };
      });
      expect(box!.x).toBeCloseTo(contentBox.x, 0);
      expect(box!.width).toBeCloseTo(contentBox.width, 0);
    }
    // The real widget has a 250px minimum, even if its host is narrower. Its
    // border must fit inside the reveal, not merely inside the scrollable canvas.
    const widget = await page.getByTestId("official-x-widget").boundingBox();
    const reveal = await x.locator("..").boundingBox();
    expect(widget!.x + widget!.width).toBeLessThanOrEqual(
      reveal!.x + reveal!.width,
    );
    expect((await spotify.boundingBox())!.height).toBe(152);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await page.screenshot({
      path: ".amp/in/artifacts/embed-mobile-providers.png",
    });
  });
});

test("a preview resolving above the edited row preserves caret and screen position", async ({
  page,
}) => {
  await mockProvider(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/embeds?**", async (route) => {
    await hold;
    await route.fallback();
  });
  await seedOutline(
    page,
    [
      ...TREE,
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `tail${i}`,
        parentId: null,
        prevSiblingId: i ? `tail${i - 1}` : "next",
        text: `Following note ${i}`,
      })),
    ],
    { kv: { "account-prefs": [allowed] } },
  );
  await page.goto("/");
  await expect(body(page).getByLabel("Loading preview")).toBeVisible({
    timeout: 15000,
  });
  await note(page, "next").focus();
  await page.keyboard.press("End");
  await page.keyboard.type(" steadily");
  const before = await note(page, "next").boundingBox();
  const heights = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const samples: number[] = [];
        const start = performance.now();
        const sample = () => {
          const el = document.querySelector(
            '[data-node-body="media"] [data-embed-reveal]',
          )!;
          samples.push(el.getBoundingClientRect().height);
          if (performance.now() - start < 1_000) requestAnimationFrame(sample);
          else resolve(samples);
        };
        sample();
      }),
  );
  release();
  await expect(body(page).locator("iframe")).toHaveCSS("opacity", "1");
  await expect(note(page, "next")).toBeFocused();
  await page.keyboard.type(".");
  await expect(note(page, "next")).toHaveText(
    "Continue writing here steadily.",
  );
  const after = await note(page, "next").boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(3);
  const samples = await heights;
  const finalHeight = samples.at(-1)!;
  expect(finalHeight).toBeGreaterThan(150);
  expect(
    samples.some((height) => height > 100 && height < finalHeight - 5),
  ).toBe(true);
});

test("saved consent waits for the initial account read", async ({ page }) => {
  const requests = await mockProvider(page);
  await seedOutline(page, TREE, { kv: { "account-prefs": [allowed] } });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/kv?collection=account-prefs", async (route) => {
    if (route.request().method() === "GET") await hold;
    await route.fallback();
  });
  await page.goto("/");
  await expect(note(page, "media").getByRole("link")).toBeVisible();
  expect(requests()).toBe(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  release();
  await expect(body(page).locator("iframe")).toHaveCSS("opacity", "1");
  expect(requests()).toBe(1);
});

for (const scenario of ["row", "title", "disabled", "edited"] as const) {
  test(`standalone paste waits for initial preferences (${scenario})`, async ({
    page,
  }) => {
    await seedOutline(
      page,
      [
        { id: "plain", parentId: null, prevSiblingId: null, text: "" },
        { id: "child", parentId: "plain", prevSiblingId: null, text: "Notes" },
      ],
      {
        kv: {
          "account-prefs":
            scenario === "disabled"
              ? [
                  {
                    key: "editor-feature:embeds",
                    value: { key: "editor-feature:embeds", enabled: false },
                  },
                ]
              : [],
        },
      },
    );
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/kv?collection=account-prefs", async (route) => {
      await hold;
      await route.fallback();
    });
    let requests = 0;
    await page.route("**/api/unfurl?**", (route) => {
      requests++;
      return route.fulfill({ json: { title: "Chosen title" } });
    });
    await page.goto(scenario === "title" ? "/plain" : "/");
    const target =
      scenario === "title"
        ? page.locator(".zoomed-title .node-text")
        : note(page, "plain");
    await target.focus();
    await target.evaluate((el, url) => {
      const data = new DataTransfer();
      data.setData("text/plain", url);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, URL);
    await expect(target).toHaveText(URL);
    expect(requests).toBe(0);
    await expect(page.getByRole("menu", { name: "Paste as" })).toHaveCount(0);
    if (scenario === "edited") await page.keyboard.type(" changed");
    release();
    if (scenario === "disabled") {
      await target.blur();
      await expect(target.getByRole("link")).toHaveText("Chosen title");
      expect(requests).toBe(1);
    } else if (scenario === "edited") {
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const path = "/src/data/editor-features.ts";
            return (await import(path)).getEditorFeatures().ready;
          }),
        )
        .toBe(true);
      await expect(target).toHaveText(`${URL} changed`);
      expect(requests).toBe(0);
    } else {
      await expect(
        page.getByRole("menuitemradio", { name: "Link Title" }),
      ).toBeFocused();
      expect(requests).toBe(0);
      await page.keyboard.press("Escape");
      await expect(target).toHaveText(URL);
    }
    await expect(page.getByRole("menu", { name: "Paste as" })).toHaveCount(0);
  });
}

test("failed revocation stays locally off and Settings retries revocation, not approval", async ({
  page,
}) => {
  await mockProvider(page);
  await seedOutline(page, TREE, { kv: { "account-prefs": [allowed] } });
  let reject = true;
  const saved: boolean[] = [];
  await page.route("**/api/kv?collection=account-prefs", async (route) => {
    if (route.request().method() === "POST") {
      const rows = route.request().postDataJSON().rows;
      const consent = rows.find(
        (row: { key: string }) => row.key === "external-embeds",
      );
      if (consent) {
        saved.push(consent.value.enabled);
        if (reject)
          return route.fulfill({
            status: 403,
            json: { error: "test rejection" },
          });
      }
    }
    await route.fallback();
  });
  await page.goto("/settings");
  const permission = page.getByRole("switch", {
    name: "Allow external embeds",
  });
  await permission.waitFor({ state: "visible" });
  await expect(permission).toBeChecked();
  await permission.click();
  await expect(permission).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Retry revocation" }),
  ).toBeVisible();
  await page.screenshot({
    path: ".amp/in/artifacts/embed-settings-revoke.png",
    fullPage: true,
  });
  reject = false;
  await page.getByRole("button", { name: "Retry revocation" }).click();
  await expect(permission).toBeEnabled();
  expect(saved).toEqual([false, false]);
  await page.goto("/");
  await expect(
    body(page).getByRole("button", { name: "Load embed" }),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
});

test("Embed mirrors share the body while collapsing only their own child instance", async ({
  page,
}) => {
  const requests = await mockProvider(page);
  await seedOutline(
    page,
    [
      ...TREE,
      {
        id: "mirror",
        parentId: null,
        prevSiblingId: "next",
        text: "",
        mirrorOf: "media",
      },
    ],
    { kv: { "account-prefs": [allowed] } },
  );
  await page.goto("/");
  await expect(body(page).locator("iframe")).toHaveCount(2);
  await expect(note(page, "note")).toHaveCount(2);
  const mirrorToggle = page.locator(
    'li[data-node-id="mirror"] > .outline-row > .collapse-toggle',
  );
  await mirrorToggle.evaluate((el) =>
    window.scrollTo({
      top: el.getBoundingClientRect().top + window.scrollY - 100,
    }),
  );
  await mirrorToggle.click();
  await expect(note(page, "note")).toHaveCount(1);
  await expect(body(page).locator("iframe")).toHaveCount(2);
  expect(requests()).toBe(1);

  await page
    .locator('li[data-node-id="media"]')
    .getByRole("button", { name: "Edit link" })
    .click();
  await expect(page.getByText("Changes all 2 instances")).toBeVisible();
});

test("deep nodes keep readable width and focus reveals them horizontally", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 590 });
  await mockProvider(page);
  const chain: SeedNode[] = Array.from({ length: 9 }, (_, depth) => ({
    id: `depth-${depth}`,
    parentId: depth === 0 ? null : `depth-${depth - 1}`,
    prevSiblingId: null,
    text: depth === 8 ? URL : `Depth ${depth}`,
    kind: depth === 8 ? "embed" : null,
  }));
  await seedOutline(page, chain, { kv: { "account-prefs": [allowed] } });
  await page.goto("/");
  const viewport = page.locator(".outline-canvas-viewport");
  const frame = page.locator('[data-node-body="depth-8"] iframe');
  await expect(frame).toHaveCSS("opacity", "1", { timeout: 15000 });
  const dimensions = await viewport.evaluate((el) => ({
    clientWidth: el.clientWidth,
    contentWidth:
      el.clientWidth -
      Number.parseFloat(getComputedStyle(el).paddingInlineStart),
    scrollWidth: el.scrollWidth,
  }));
  expect(dimensions.clientWidth).toBeGreaterThanOrEqual(250);
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth + 150);
  expect((await frame.boundingBox())!.width).toBeGreaterThanOrEqual(
    dimensions.contentWidth - 34,
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);

  await note(page, "depth-8").focus();
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(100);
  const visible = await page
    .locator('li[data-node-id="depth-8"] > .outline-row')
    .evaluate((row) => {
      const viewport = row.closest(".outline-canvas-viewport")!;
      const rowRect = row.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      return {
        left: rowRect.left - viewportRect.left,
        right: viewportRect.right - rowRect.right,
        scrollbarGutter: viewportRect.width - viewport.clientWidth,
      };
    });
  expect(visible.left).toBeGreaterThanOrEqual(-visible.scrollbarGutter - 1);
  expect(visible.right).toBeGreaterThanOrEqual(-1);
  await page.screenshot({ path: ".amp/in/artifacts/embed-deep-canvas.png" });
});

for (const width of [1168, 320]) {
  test(`nested embed keeps its size when its children toggle at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 650 });
    await mockProvider(page);
    const chain: SeedNode[] = Array.from({ length: 18 }, (_, depth) => ({
      id: depth === 17 ? "media" : `ancestor-${depth}`,
      parentId: depth === 0 ? null : `ancestor-${depth - 1}`,
      prevSiblingId: null,
      text: depth === 17 ? URL : `Depth ${depth}`,
      kind: depth === 17 ? "embed" : null,
      collapsed: depth === 17,
    }));
    await seedOutline(page, [...chain, TREE[1]!], {
      kv: { "account-prefs": [allowed] },
    });
    await page.goto("/");
    const frame = body(page).locator("iframe");
    await expect(frame).toHaveCSS("opacity", "1", { timeout: 15000 });
    await note(page, "media").focus();
    const initial = await frame.evaluate((el) => {
      const { width, height } = el.getBoundingClientRect();
      return { width, height };
    });
    const row = page.locator('li[data-node-id="media"]');
    const viewport = page.locator(".outline-canvas-viewport");
    // The pencil now trails the URL, not the row's leading edge. Bring that
    // control into view before measuring whether interaction moves the canvas.
    const pencil = row.getByRole("button", { name: "Edit link" });
    await pencil.scrollIntoViewIfNeeded();
    const scrollLeft = await viewport.evaluate((el) => el.scrollLeft);
    const viewportWidth = await viewport.evaluate((el) => el.clientWidth);
    await pencil.click();
    const editor = page.getByRole("dialog", { name: "Edit link" });
    await expect(editor).toBeVisible();
    if (width < 768)
      await expect(page.locator(".menu-sheet-overlay")).toHaveAttribute(
        "data-expanded",
      );
    await expect(viewport).toHaveJSProperty("clientWidth", viewportWidth);
    await expect(viewport).toHaveJSProperty("scrollLeft", scrollLeft);
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await note(page, "ancestor-16").click({ position: { x: 3, y: 8 } });
    await expect(viewport).toHaveJSProperty("scrollLeft", scrollLeft);
    for (const action of ["Expand", "Collapse", "Expand", "Collapse"]) {
      await row.getByRole("button", { name: action, exact: true }).click();
      await expect(note(page, "note")).toHaveCount(action === "Expand" ? 1 : 0);
      await expect(viewport).toHaveJSProperty("scrollLeft", scrollLeft);
      // Sample the transition, not just its final frame: no intermediate resize
      // should make the provider reflow while its notes open or close.
      const sizes = await frame.evaluate(async (el) => {
        const sizes: { width: number; height: number }[] = [];
        for (let i = 0; i < 30; i++) {
          await new Promise(requestAnimationFrame);
          const { width, height } = el.getBoundingClientRect();
          sizes.push({ width, height });
        }
        return sizes;
      });
      for (const size of sizes) {
        expect(size.width).toBeCloseTo(initial.width, 0);
        expect(size.height).toBeCloseTo(initial.height, 0);
      }
    }
    // Deliberate keyboard navigation into the next node still reveals it.
    // Reset the editor-control scroll so the next row needs revealing again.
    await viewport.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await note(page, "ancestor-16").focus();
    const beforeNavigation = await viewport.evaluate((el) => el.scrollLeft);
    await page.keyboard.press("ArrowDown");
    await expect(note(page, "media")).toBeFocused();
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(beforeNavigation);

    await page.keyboard.press("ControlOrMeta+ArrowDown");
    await expect(note(page, "note")).toHaveCount(1);
    const expandedOffset = await viewport.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
      return el.scrollLeft;
    });
    await page.keyboard.press("ControlOrMeta+ArrowUp");
    await expect(note(page, "note")).toHaveCount(0);
    const clamped = await viewport.evaluate((el) => ({
      offset: el.scrollLeft,
      limit: el.scrollWidth - el.clientWidth,
    }));
    expect(clamped.offset).toBeLessThan(expandedOffset);
    expect(clamped.offset).toBe(clamped.limit);
    await expect(note(page, "media")).toBeInViewport();
  });
}

for (const width of [1280, 390]) {
  test(`pencil drafts commit together across mirrors and keep child notes at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    let unfurls = 0;
    await page.route("**/api/unfurl?**", (route) => {
      unfurls++;
      return route.fulfill({ json: { title: "Must not replace my title" } });
    });
    await seedOutline(page, [
      ...TREE,
      {
        id: "mirror",
        parentId: null,
        prevSiblingId: "next",
        text: "",
        mirrorOf: "media",
      },
    ]);
    await page.goto("/");
    const pencil = note(page, "mirror").getByRole("button", {
      name: "Edit link",
    });
    const editor = page.getByRole("dialog", { name: "Edit link" });
    const settleEditor = async () => {
      if (width < 768)
        await expect(page.locator(".menu-sheet-overlay")).toHaveAttribute(
          "data-expanded",
        );
    };
    const saved = () =>
      page.evaluate(
        // SAFETY: seedOutline owns the /api/nodes fixture's ApiNode[] contract.
        () => fetch("/api/nodes").then((r) => r.json()) as Promise<ApiNode[]>,
      );
    await expect(pencil).toBeVisible({ timeout: 15000 });
    await pencil.click();
    await settleEditor();
    const editedEmbedUrl = "https://vimeo.com/22439234";
    await editor.getByLabel("Link URL").fill(editedEmbedUrl);
    await editor.getByRole("button", { name: "Done" }).click();
    await expect(editor).toHaveCount(0);
    await page.getByRole("button", { name: "Not now" }).click();
    await note(page, "mirror").blur();
    await expect(note(page, "media").getByRole("link")).toHaveAttribute(
      "href",
      editedEmbedUrl,
    );
    await expect(note(page, "mirror").getByRole("link")).toHaveAttribute(
      "href",
      editedEmbedUrl,
    );
    expect((await saved()).find((n) => n.id === "media")).toMatchObject({
      kind: "embed",
      text: editedEmbedUrl,
    });
    // Restore the starting resource through the same-kind edit too.
    await pencil.click();
    await settleEditor();
    await editor.getByLabel("Link URL").fill(URL);
    await editor.getByRole("button", { name: "Done" }).click();
    await expect(editor).toHaveCount(0);
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(note(page, "note")).toHaveCount(2);
    expect(unfurls).toBe(0);
    await pencil.focus();
    await page.keyboard.press("Enter");
    await expect(editor).toBeVisible();
    await settleEditor();
    await expect(editor.getByText("Changes all 2 instances")).toBeVisible();
    await editor
      .getByRole("button", { name: "Link Title", exact: true })
      .click();
    await editor.getByLabel("Link text").fill("My chosen title");
    const changedUrl = "https://www.youtube.com/watch?v=M7lc1UVf-VE&t=120";
    await editor.getByLabel("Link URL").fill(changedUrl);
    expect((await saved()).find((n) => n.id === "media")).toMatchObject({
      kind: "embed",
      text: URL,
    });
    expect(unfurls).toBe(0);
    await editor.getByRole("button", { name: "Cancel" }).click();
    await expect(editor).toHaveCount(0);
    expect((await saved()).find((n) => n.id === "media")).toMatchObject({
      kind: "embed",
      text: URL,
    });

    await pencil.click();
    await settleEditor();
    await expect(
      editor.getByRole("button", { name: "Embed", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await editor
      .getByRole("button", { name: "Link Title", exact: true })
      .click();
    await editor.getByLabel("Link text").fill("My chosen title");
    await editor.getByLabel("Link URL").fill(changedUrl);
    await editor.getByRole("button", { name: "Done" }).click();
    await note(page, "mirror").blur();
    await expect(note(page, "media").getByRole("link")).toHaveText(
      "My chosen title",
    );
    await expect(note(page, "mirror").getByRole("link")).toHaveAttribute(
      "href",
      changedUrl,
    );
    expect(unfurls).toBe(0);
    await expect(note(page, "note")).toHaveCount(2);

    await pencil.click();
    await settleEditor();
    const linkTile = editor.getByRole("button", {
      name: "Link Title",
      exact: true,
    });
    await linkTile.focus();
    await page.keyboard.press("ArrowRight");
    const plainTile = editor.getByRole("button", {
      name: "Plain URL",
      exact: true,
    });
    await expect(plainTile).toBeFocused();
    await page.keyboard.press("Space");
    await expect(plainTile).toHaveAttribute("aria-pressed", "true");
    await expect(editor.getByLabel("Link text")).toBeDisabled();
    await editor.getByRole("button", { name: "Done" }).click();
    await expect(note(page, "mirror")).toHaveText(changedUrl);
    expect((await saved()).find((n) => n.id === "media")).toMatchObject({
      kind: null,
      text: changedUrl,
    });
    await expect(note(page, "note")).toHaveCount(2);
    expect(unfurls).toBe(0);
    await pencil.click();
    await settleEditor();
    await expect(plainTile).toHaveAttribute("aria-pressed", "true");
    await editor.getByRole("button", { name: "Embed", exact: true }).click();
    await editor.getByRole("button", { name: "Done" }).click();
    await expect(
      page.getByRole("dialog", { name: "Allow external embeds?" }),
    ).toBeVisible();
    expect((await saved()).find((n) => n.id === "media")).toMatchObject({
      kind: "embed",
      text: changedUrl,
    });
  });
}

test("pencil preserves surrounding prose and explains unavailable Embed", async ({
  page,
}) => {
  const prose = `Watch [My video](${URL}) with me`;
  await seedOutline(page, [
    { id: "prose", parentId: null, prevSiblingId: null, text: prose },
    {
      id: "unsupported",
      parentId: null,
      prevSiblingId: "prose",
      text: "https://example.com/",
    },
  ]);
  await page.goto("/");
  const editor = page.getByRole("dialog", { name: "Edit link" });
  await note(page, "prose").getByRole("button", { name: "Edit link" }).click();
  await expect(
    editor.getByRole("button", { name: "Embed", exact: true }),
  ).toBeDisabled();
  await expect(
    editor.getByText(
      "Embed needs a node with only one URL, without surrounding text.",
    ),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Plain URL" }).click();
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(note(page, "prose")).toHaveText(`Watch ${URL} with me`);
  await note(page, "prose").getByRole("button", { name: "Edit link" }).click();
  await editor.getByRole("button", { name: "Link Title", exact: true }).click();
  await editor.getByLabel("Link text").fill("Back to my title");
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(note(page, "prose")).toHaveText(
    "Watch Back to my title with me",
  );
  await note(page, "unsupported")
    .getByRole("button", { name: "Edit link" })
    .click();
  await expect(
    editor.getByRole("button", { name: "Embed", exact: true }),
  ).toBeDisabled();
  await expect(
    editor.getByText("This URL doesn’t support embeds."),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(note(page, "unsupported")).toHaveText("https://example.com/");
});

test.describe("mobile link editor sheet", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("pencils stay beside their links without inflating line height", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 590 });
    await seedOutline(page, [
      {
        id: "short",
        parentId: null,
        prevSiblingId: null,
        text: "[Vimeo](https://vimeo.com/22439234)",
      },
      {
        id: "medium",
        parentId: null,
        prevSiblingId: "short",
        text: "[Kody MCP endpoint](https://kody.codes/mcp)",
      },
      {
        id: "long",
        parentId: null,
        prevSiblingId: "medium",
        text: `[YouTube Developers Live: Embedded Web Player Customization](${URL})`,
      },
      {
        id: "plain",
        parentId: null,
        prevSiblingId: "long",
        text: "https://vimeo.com/22439234",
      },
      {
        id: "inline",
        parentId: null,
        prevSiblingId: "plain",
        text: "WWWWWWWW [https://vimeo.com/22439234](https://vimeo.com/22439234)",
      },
      { id: "prose", parentId: null, prevSiblingId: "inline", text: "Vimeo" },
    ]);
    await page.goto("/");
    await expect(note(page, "short")).toBeVisible({ timeout: 15000 });
    const prose = await note(page, "prose").boundingBox();
    for (const id of ["short", "medium", "long", "plain"]) {
      const geometry = await note(page, id).evaluate((el) => {
        const anchor = el.querySelector("a")!;
        const button = el.querySelector("button")!;
        const label = anchor.lastChild!;
        const end = label.textContent!.length;
        const range = document.createRange();
        range.setStart(label, end - 1);
        range.setEnd(label, end);
        return {
          text: el.getBoundingClientRect().toJSON(),
          lastGlyph: range.getBoundingClientRect().toJSON(),
          button: button.getBoundingClientRect().toJSON(),
          icon: button.firstElementChild!.getBoundingClientRect().toJSON(),
        };
      });
      expect(geometry.button.y).toBeLessThan(geometry.lastGlyph.bottom);
      expect(geometry.button.bottom).toBeGreaterThan(geometry.lastGlyph.y);
      expect(geometry.icon.x - geometry.lastGlyph.right).toBeGreaterThanOrEqual(
        0,
      );
      expect(geometry.icon.x - geometry.lastGlyph.right).toBeLessThan(12);
      if (id === "short" || id === "medium")
        expect(geometry.text.height).toBeCloseTo(prose!.height, 0);
    }
    // A favicon at the end of a nearly full line must move with the URL's
    // first glyph, without turning the entire URL into an unbreakable run.
    const start = await note(page, "inline").evaluate((el) => {
      const anchor = el.querySelector("a")!;
      const first = document
        .createTreeWalker(anchor, NodeFilter.SHOW_TEXT)
        .nextNode()!;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(first, 1);
      return {
        icon: anchor.querySelector("img")!.getBoundingClientRect().toJSON(),
        glyph: range.getBoundingClientRect().toJSON(),
        cell: el.getBoundingClientRect().toJSON(),
      };
    });
    expect(start.icon.y).toBeLessThan(start.glyph.bottom);
    expect(start.icon.bottom).toBeGreaterThan(start.glyph.y);
    expect(start.glyph.x - start.icon.right).toBeLessThan(6);
    expect(start.glyph.right).toBeLessThanOrEqual(start.cell.right);
    // The vertically expanded touch area opens the sheet without contributing
    // 44px to the text's line box or stealing horizontal space from the link.
    const pencil = note(page, "short").getByRole("button", {
      name: "Edit link",
    });
    const box = await pencil.boundingBox();
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y - 5);
    const editor = page.getByRole("dialog", { name: "Edit link" });
    await expect(editor).toBeVisible();
    await expect
      .poll(() =>
        editor.evaluate((el) => Math.round(el.getBoundingClientRect().bottom)),
      )
      .toBe(await page.evaluate(() => innerHeight));
    await editor.getByRole("button", { name: "Cancel", exact: true }).tap();
    await expect(pencil).toBeFocused();

    await placeCaret(note(page, "short"), "end");
    const chip = note(page, "short").getByRole("button", { name: "Edit link" });
    await expect(note(page, "short").locator(".link-url-chip")).toBeVisible();
    const gaps = await chip.evaluate((el) => {
      const icon = el.firstElementChild!.getBoundingClientRect();
      return {
        before:
          icon.left - el.previousElementSibling!.getBoundingClientRect().right,
        after: el.nextElementSibling!.getBoundingClientRect().left - icon.right,
      };
    });
    expect(gaps.before).toBeLessThan(1);
    expect(gaps.after).toBeLessThan(1);
    const chipBox = await chip.boundingBox();
    await page.touchscreen.tap(chipBox!.x + chipBox!.width / 2, chipBox!.y - 8);
    await expect(editor).toBeVisible();
  });

  test("native dismissals discard the draft and restore its pencil", async ({
    page,
  }) => {
    const source = `[My video](${URL})`;
    await seedOutline(page, [
      { id: "link", parentId: null, prevSiblingId: null, text: source },
    ]);
    await page.goto("/");
    const pencil = note(page, "link").getByRole("button", {
      name: "Edit link",
    });
    const editor = page.getByRole("dialog", { name: "Edit link" });
    for (const dismiss of ["Cancel", "Close", "Escape", "backdrop", "swipe"]) {
      await pencil.tap();
      await expect(page.locator(".menu-sheet-overlay")).toHaveAttribute(
        "data-expanded",
      );
      await expect(editor).toBeVisible();
      await expect
        .poll(() =>
          editor.evaluate((el) =>
            Math.round(el.getBoundingClientRect().bottom),
          ),
        )
        .toBe(await page.evaluate(() => innerHeight));
      // Opening the choices should not summon the keyboard before a field is tapped.
      await expect(editor.getByLabel("Link text")).not.toBeFocused();
      await editor.getByLabel("Link text").fill("Discard this title");
      await editor.getByRole("button", { name: "Plain URL" }).tap();
      if (dismiss === "Escape") await page.keyboard.press("Escape");
      else if (dismiss === "backdrop") await page.touchscreen.tap(4, 4);
      else if (dismiss === "swipe") {
        const handle = await page.locator(".sheet-handle").boundingBox();
        const x = handle!.x + handle!.width / 2;
        const y = handle!.y + handle!.height / 2;
        // Native snap positions are a viewport apart. A short partial pull is
        // allowed to snap back; this gesture deliberately crosses that boundary.
        const distance = await page.evaluate(() => innerHeight * 0.7);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (let step = 1; step <= 5; step++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: y + (step * distance) / 5 }],
          });
          // Send a real multi-frame gesture, not several moves in one paint.
          await page.evaluate(() => new Promise(requestAnimationFrame));
        }
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await cdp.detach();
      } else
        await editor.getByRole("button", { name: dismiss, exact: true }).tap();
      await expect(editor, dismiss).toHaveCount(0);
      await expect(pencil).toBeFocused();
      const nodes = await page.evaluate(
        // SAFETY: seedOutline owns the /api/nodes fixture's ApiNode[] contract.
        () => fetch("/api/nodes").then((r) => r.json()) as Promise<ApiNode[]>,
      );
      expect(nodes.find((node) => node.id === "link")?.text).toBe(source);
    }
  });

  test("width changes keep one draft and unsupported Embed remains explained", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 767, height: 844 });
    await seedOutline(page, [
      {
        id: "link",
        parentId: null,
        prevSiblingId: null,
        text: "[Original title](https://example.com/)",
      },
    ]);
    await page.goto("/");
    await note(page, "link").getByRole("button", { name: "Edit link" }).tap();
    const editor = page.getByRole("dialog", { name: "Edit link" });
    await expect(page.locator(".menu-sheet-overlay")).toHaveAttribute(
      "data-expanded",
    );
    await editor.getByLabel("Link text").fill("Keep my draft");
    await editor.getByRole("button", { name: "Plain URL", exact: true }).tap();
    await page.setViewportSize({ width: 768, height: 844 });
    await expect(page.locator(".sheet-surface")).toHaveCount(0);
    await expect(editor.getByLabel("Link text")).toHaveValue("Keep my draft");
    await expect(editor.getByLabel("Link text")).toBeDisabled();
    await expect(editor.getByLabel("Link URL")).toBeFocused();
    await page.setViewportSize({ width: 320, height: 640 });
    await expect(page.locator(".menu-sheet-overlay")).toHaveAttribute(
      "data-expanded",
    );
    await expect(editor.getByLabel("Link text")).toHaveValue("Keep my draft");
    await expect(
      editor.getByRole("button", { name: "Embed", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByText("This URL doesn’t support embeds."),
    ).toBeVisible();
    const box = await editor.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(312);
    await editor.getByRole("button", { name: "Link Title", exact: true }).tap();
    await editor.getByRole("button", { name: "Done" }).tap();
    await expect(editor).toHaveCount(0);
    await expect(note(page, "link").getByRole("link")).toHaveText(
      "Keep my draft",
    );
  });
});
