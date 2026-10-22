import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  placeCaret,
  seedOutline,
  type ApiNode,
  type SeedNode,
} from "./fixtures";

// Rich links (ADR 0005): markdown `[label](url)` in node.text that folds to a
// clean <a> while the bullet is blurred and BRACKET-reveals while the caret is
// on it -- `[label]` editable, the url folded behind a `(✎)` chip; the raw url
// never expands into the line. These specs cover the fold/reveal swap,
// click-to-open, the Edit Link popover, copy/cut-as-source, and the paste paths.

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row .node-text`);

async function load(page: Page, tree: SeedNode[]) {
  // Record window.open calls so we can assert click-to-open without juggling
  // real popups.
  await page.addInitScript(() => {
    // SAFETY: This init script owns these observation fields on its page's window.
    const state = window as typeof window & {
      __opened: string[];
      __focusedTabs: number;
    };
    state.__opened = [];
    state.__focusedTabs = 0;
    // SAFETY: The link opener only uses the returned tab's opener and focus method.
    window.open = ((url?: string | URL) => {
      state.__opened.push(String(url));
      return {
        opener: window,
        focus: () => {
          state.__focusedTabs += 1;
        },
      };
    }) as typeof window.open;
  });
  // Inline-link behavior with the Embed display-choice menu disabled.
  const fixture = await seedOutline(page, tree, {
    kv: {
      "account-prefs": [
        {
          key: "editor-feature:embeds",
          value: { key: "editor-feature:embeds", enabled: false },
        },
      ],
    },
  });
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible({ timeout: 15000 });
  return fixture;
}

// Live descriptor lookup stays in the Worker suite; frame isolation needs a browser.
test("provider Embed frames render isolated from their child notes", async ({
  page,
}) => {
  for (const [provider, url, src] of [
    [
      "youtube",
      "https://www.youtube.com/watch?v=M7lc1UVf-VE&t=90",
      "https://www.youtube.com/embed/M7lc1UVf-VE?start=90",
    ],
    [
      "vimeo",
      "https://vimeo.com/22439234",
      "https://player.vimeo.com/video/22439234",
    ],
    [
      "spotify",
      "https://open.spotify.com/episode/7makk4oTQel546B0PZlDM5",
      "https://open.spotify.com/embed/episode/7makk4oTQel546B0PZlDM5",
    ],
  ]) {
    await seedOutline(
      page,
      [
        {
          id: "media",
          parentId: null,
          prevSiblingId: null,
          text: url!,
          kind: "embed",
        },
        {
          id: "note",
          parentId: "media",
          prevSiblingId: null,
          text: "My notes remain separate from the provider.",
        },
      ],
      {
        kv: {
          "account-prefs": [
            {
              key: "external-embeds",
              value: { key: "external-embeds", enabled: true },
            },
          ],
        },
      },
    );
    await page.route("**/api/embeds?**", (route) =>
      route.fulfill({
        json: {
          embed: { provider, src, width: 480, height: 360, title: "Provider" },
        },
      }),
    );
    await page.route(src!, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<html><body>Provider frame</body></html>",
      }),
    );
    await page.goto("/");
    const frame = page.locator('[data-node-body="media"] iframe');
    await expect(frame).toHaveCSS("opacity", "1", { timeout: 25000 });
    await expect(frame).toHaveAttribute("src", src!);
    expect(
      await frame.evaluate((el: HTMLIFrameElement) => el.contentDocument),
    ).toBeNull();
    await expect(text(page, "note")).toContainText("My notes remain separate");
    await page.unroute("**/api/embeds?**");
  }
});

test("prose paste enriches new URLs only and preserves protected content", async ({
  page,
}) => {
  const requested: string[] = [];
  await page.route("**/api/unfurl?*", async (route) => {
    const url = new URL(route.request().url()).searchParams.get("url")!;
    requested.push(url);
    await route.fulfill({
      json: {
        title: url.includes("first") ? "First article" : "Second article",
      },
    });
  });
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: "Old https://old.test ",
    },
  ]);
  await focusBullet(page, "n");
  await text(page, "n").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  await pasteInto(text(page, "n"), {
    plain:
      "Read https://first.test and https://second.test. `https://code.test` ||https://spoiler.test|| [Mine](https://custom.test)",
  });
  await blurActive(page);
  await expect(
    text(page, "n").getByRole("link", { name: "First article" }),
  ).toBeVisible();
  await expect(
    text(page, "n").getByRole("link", { name: "Second article" }),
  ).toBeVisible();
  await expect(text(page, "n")).toContainText("Old https://old.test");
  expect(requested.sort()).toEqual([
    "https://first.test",
    "https://second.test",
  ]);
});

test("structural paste unfurls newly persisted nodes, but literal paste never fetches", async ({
  page,
}) => {
  const requested: string[] = [];
  await page.route("**/api/unfurl?*", async (route) => {
    requested.push(new URL(route.request().url()).searchParams.get("url")!);
    await route.fulfill({ json: { title: "Pasted article" } });
  });
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "" },
  ]);
  await focusBullet(page, "n");
  await pasteInto(text(page, "n"), {
    plain:
      "- First https://first.test\n```\nhttps://fenced.test\n```\n- Second https://second.test",
  });
  await blurActive(page);
  await expect(
    page.locator(".outline-row a[data-link]", { hasText: "Pasted article" }),
  ).toHaveCount(2);
  await expect(
    page.locator(".node-text").filter({ hasText: "https://fenced.test" }),
  ).toHaveText("https://fenced.test");
  await focusBullet(page, "n");
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "V",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    ),
  );
  await pasteInto(text(page, "n"), { plain: " https://literal.test " });
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "V" })),
  );
  await expect(text(page, "n")).toContainText("https://literal.test");
  expect(requested.sort()).toEqual([
    "https://first.test",
    "https://second.test",
  ]);
});

test("Add Link with an empty label fetches a title", async ({ page }) => {
  await page.route("**/api/unfurl?*", (route) =>
    route.fulfill({ json: { title: "Created article" } }),
  );
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "" },
  ]);
  await focusBullet(page, "n");
  await page.keyboard.type("/link");
  await page.keyboard.press("Enter");
  const popover = page.locator("[data-link-edit-popover]");
  await expect(popover).toBeVisible();
  await popover.getByPlaceholder("https://…").fill("https://created.test");
  await popover.getByRole("button", { name: "Done" }).click();
  await blurActive(page);
  await expect(
    text(page, "n").getByRole("link", { name: "Created article" }),
  ).toBeVisible();
});

// Dispatch a synthetic paste carrying clipboard data at the current selection.
async function pasteInto(
  locator: Locator,
  data: { plain?: string; html?: string },
) {
  await locator.evaluate((el, d) => {
    const dt = new DataTransfer();
    if (d.plain) dt.setData("text/plain", d.plain);
    if (d.html) dt.setData("text/html", d.html);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, data);
}

// Focus a bullet WITHOUT clicking it (a click might land on a folded <a> and
// open it). Focusing reveals the raw markdown via the onFocus handler.
async function focusBullet(page: Page, id: string) {
  await text(page, id).evaluate((el: HTMLElement) => el.focus());
}

async function blurActive(page: Page) {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
}

const opened = (page: Page) =>
  page.evaluate(() => {
    // SAFETY: load's init script populates this field before the app runs.
    return (window as typeof window & { __opened: string[] }).__opened;
  });
const focusedTabs = (page: Page) =>
  page.evaluate(() => {
    // SAFETY: load's init script populates this field before the app runs.
    return (window as typeof window & { __focusedTabs: number }).__focusedTabs;
  });
const activeNodeId = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement
        ?.closest<HTMLElement>("[data-node-id]")
        ?.getAttribute("data-node-id") ?? null,
  );

const LINK = "[Anthropic](https://anthropic.com)";

test("typing around folded links keeps their loaded favicons connected", async ({
  page,
}) => {
  await page.route("https://www.google.com/s2/favicons?**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>',
    }),
  );
  const source = `Before ${LINK} between [[n_target_example]] [Example](https://example.com) after`;
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: source },
    {
      id: "n_target_example",
      parentId: null,
      prevSiblingId: "n",
      text: "Reference target",
    },
  ]);
  const editor = text(page, "n");
  await expect(editor.locator("dotflowy-widget")).toContainText(
    "Reference target",
  );
  const icons = await editor.locator("img.link-favicon").elementHandles();
  expect(icons).toHaveLength(2);
  for (const icon of icons) {
    await expect
      .poll(() =>
        icon.evaluate(
          (el) =>
            el instanceof HTMLImageElement &&
            el.complete &&
            el.naturalWidth > 0,
        ),
      )
      .toBe(true);
  }

  // A detach/reinsert can flash even when it reuses the same image object.
  // Observe removals as well as identity, including the link's ancestors.
  await editor.evaluate((el) => {
    el.setAttribute("data-favicon-removals", "0");
    new MutationObserver((records) => {
      const removals = records
        .flatMap((record) => [...record.removedNodes])
        .filter(
          (node) =>
            node instanceof Element &&
            (node.matches("img.link-favicon") ||
              node.querySelector("img.link-favicon")),
        ).length;
      if (removals)
        el.setAttribute(
          "data-favicon-removals",
          String(Number(el.getAttribute("data-favicon-removals")) + removals),
        );
    }).observe(el, { childList: true, subtree: true });
  });

  // Exercise changed plain text, a newly formatted token before both links,
  // and text between links. A whole-line HTML rebuild fails on the first key.
  for (const [offset, input] of [
    [source.length, " more"],
    [0, "**Note** "],
    ["**Note** Before ".length + LINK.length + " between".length, " extra"],
  ] as const) {
    await placeCaret(editor, offset);
    for (const key of input) {
      await page.keyboard.type(key);
      for (const icon of icons) {
        expect(await icon.evaluate((el) => el.isConnected)).toBe(true);
      }
      await expect(editor).toHaveAttribute("data-favicon-removals", "0");
    }
  }
  await blurActive(page);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const nodes: ApiNode[] = await fetch("/api/nodes").then((response) =>
          response.json(),
        );
        return nodes.find((node) => node.id === "n")?.text;
      }),
    )
    .toBe(
      `**Note** Before ${LINK} between extra [[n_target_example]] [Example](https://example.com) after more`,
    );
});

test("a blurred bullet folds the link to a clean <a>; focusing bracket-reveals it", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: LINK },
  ]);

  // Folded on load (nothing focused): a single <a> showing only the label.
  const anchor = text(page, "n").locator("a[data-link]");
  await expect(anchor).toHaveText("Anthropic");
  await expect(anchor).toHaveAttribute("href", "https://anthropic.com");

  // It leads with the host's favicon (Google s2/favicons), inside the anchor
  // so a click on it still opens the link, and trails the edit pencil. Both
  // carry no text, so the anchor's text stays the label.
  const favicon = anchor.locator("img.link-favicon");
  await expect(favicon).toHaveAttribute(
    "src",
    "https://www.google.com/s2/favicons?domain=anthropic.com&sz=64",
  );
  await expect(
    text(page, "n").getByRole("button", { name: "Edit link" }),
  ).toHaveCount(1);

  // Focus reveals the BRACKETS around the editable label, but the url stays
  // folded behind the `(✎)` chip (its data-src is the bare url) -- it never
  // expands into the line (ADR 0005, bracket reveal). The parens around the
  // chip are REAL text (the caret walks through them). The <a> is gone.
  await focusBullet(page, "n");
  await expect(text(page, "n").locator(".link-reveal .link-label")).toHaveText(
    "Anthropic",
  );
  await expect(text(page, "n")).toHaveText("[Anthropic]()");
  await expect(text(page, "n").locator(".link-url-chip")).toHaveAttribute(
    "data-src",
    "https://anthropic.com",
  );
  await expect(text(page, "n").locator("a[data-link]")).toHaveCount(0);

  // Blur folds it back.
  await blurActive(page);
  await expect(text(page, "n").locator("a[data-link]")).toHaveText("Anthropic");
});

test("clicking a folded link opens it in a new tab and does NOT reveal/edit", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: LINK },
  ]);

  await text(page, "n").locator("a[data-link]").click();

  // The resolved href (anchor.href) is what we open -- a bare domain
  // normalizes to a trailing slash, which is the correct target.
  expect(await opened(page)).toEqual(["https://anthropic.com/"]);
  expect(await focusedTabs(page)).toBe(1);
  // Still folded until the user returns to this tab.
  await expect(text(page, "n").locator("a[data-link]")).toBeVisible();
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => activeNodeId(page)).toBe("n");
  await expect(text(page, "n").locator(".link-reveal")).toBeVisible();
});

test("Mod+Enter inside a markdown link opens it instead of completing the node", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: LINK },
  ]);

  await focusBullet(page, "n");
  await placeCaret(text(page, "n").locator(".link-label"), 1);

  await page.keyboard.press("ControlOrMeta+Enter");

  expect(await opened(page)).toEqual(["https://anthropic.com"]);
  expect(await focusedTabs(page)).toBe(1);
  await expect(text(page, "n")).toHaveAttribute("data-completed", "false");
});

test("Mod+Enter inside a revealed link's parens opens the edit popover", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: LINK },
  ]);

  await focusBullet(page, "n");
  await expect(text(page, "n").locator(".link-url-chip")).toBeVisible();
  await placeCaret(
    text(page, "n")
      .locator(".link-url-chip")
      .locator("xpath=preceding-sibling::*[1]"),
    "end",
  );

  await page.keyboard.press("ControlOrMeta+Enter");

  await expect(page.locator("[data-link-edit-popover]")).toBeVisible();
  await expect(page.getByLabel("Link URL")).toHaveValue(
    "https://anthropic.com",
  );
  expect(await opened(page)).toEqual([]);
  expect(await focusedTabs(page)).toBe(0);

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-link-edit-popover]")).toHaveCount(0);
  await expect.poll(() => activeNodeId(page)).toBe("n");
});

test("Mod+Enter after a revealed link's closing paren opens the link", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: LINK },
  ]);

  await focusBullet(page, "n");
  await expect(text(page, "n").locator(".link-url-chip")).toBeVisible();
  await placeCaret(
    text(page, "n").locator(".link-reveal > :last-child"),
    "end",
  );

  await page.keyboard.press("ControlOrMeta+Enter");

  expect(await opened(page)).toEqual(["https://anthropic.com"]);
  expect(await focusedTabs(page)).toBe(1);
  await expect(page.locator("[data-link-edit-popover]")).toHaveCount(0);
});

test("Mod-click behind a revealed link's closing paren opens and focuses it", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: LINK },
  ]);

  await focusBullet(page, "n");
  await expect(text(page, "n").locator(".link-url-chip")).toBeVisible();

  await placeCaret(
    text(page, "n").locator(".link-reveal > :last-child"),
    "end",
  );
  await text(page, "n").evaluate((el: HTMLElement) => {
    el.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      }),
    );
  });

  expect(await opened(page)).toEqual(["https://anthropic.com"]);
  expect(await focusedTabs(page)).toBe(1);
});
const A = "[A](https://a.com)";
const B = "[B](https://b.com)";
const TWO = `${A} ${B}`;

test("focus reveals one link and moving the caret refolds it for the next", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: TWO },
  ]);

  // Blurred: both links folded.
  await expect(text(page, "n").locator("a[data-link]")).toHaveCount(2);

  // Focus with no prior caret lands at offset 0, on the first link only.
  await focusBullet(page, "n");
  // First link bracket-revealed (label editable, url chip folded), second
  // still a folded <a>.
  await expect(text(page, "n").locator(".link-reveal .link-label")).toHaveText(
    "A",
  );
  await expect(text(page, "n").locator(".link-url-chip")).toHaveAttribute(
    "data-src",
    "https://a.com",
  );
  const folded = text(page, "n").locator("a[data-link]");
  await expect(folded).toHaveCount(1);
  await expect(folded).toHaveText("B");

  // Move the caret to just before the still-folded second link. Setting the
  // selection fires selectionchange, which drives the per-link reflow (the
  // same path an ArrowRight across the boundary would take).
  await placeCaret(text(page, "n"), A.length + 1);

  // Now the SECOND link is bracket-revealed and the FIRST has folded back.
  await expect(text(page, "n").locator(".link-reveal .link-label")).toHaveText(
    "B",
  );
  await expect(folded).toHaveCount(1);
  await expect(folded).toHaveText("A");
});

test("typing between ] and ( splits the link open into raw text", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: LINK },
  ]);

  await focusBullet(page, "n");
  await expect(text(page, "n").locator(".link-url-chip")).toBeVisible();

  // The revealed frame's parens are REAL text, so the caret can sit between
  // `]` and `(` (arrow keys walk through; set the position directly here --
  // arrows are unreliable in headless contentEditable). Typing there breaks
  // the `](` adjacency the token regex needs, so the whole construct falls
  // back to plain text: `[Anthropic] (https://anthropic.com)`.
  await placeCaret(
    text(page, "n")
      .locator(".link-url-chip")
      .locator("xpath=preceding-sibling::*[1]"),
    "start",
  );
  await page.keyboard.type(" ");

  // Split open: no link construct left, the raw url is in the line.
  await expect(text(page, "n").locator(".link-reveal")).toHaveCount(0);
  await expect(text(page, "n").locator("a[data-link]")).toHaveCount(0);
  await expect(text(page, "n")).toHaveText(
    "[Anthropic] (https://anthropic.com)",
  );
});
// Read the markdown SOURCE back from the DOM (mirrors readSource in
// inline-code.ts): a folded <a> contributes its data-src, everything else its
// textContent. After typing past a link the link re-folds, so its textContent
// (the label) is no longer the source -- only data-src is.
const readSource = (page: Page, id: string) =>
  text(page, id).evaluate((el: HTMLElement) => {
    let out = "";
    const visit = (n: Node) => {
      if (n.nodeType === 3) {
        out += n.textContent ?? "";
        return;
      }
      if (n instanceof Element && n.hasAttribute("data-src")) {
        out += n.getAttribute("data-src") ?? "";
        return;
      }
      n.childNodes.forEach(visit);
    };
    el.childNodes.forEach(visit);
    return out;
  });

// The folded label is far shorter than the raw source. When focus revealed the
// link SYNCHRONOUSLY, the line expanded under the pointer mid-click and the
// browser then placed the caret geometrically at the click point -- now in the
// middle of the long URL. The fix defers the reveal to the next frame so the
// click's caret settles against the FOLDED layout first. (A synthetic
// Playwright click can't reproduce the browser's post-reveal re-placement, so
// we assert the fix's guarantee directly: focus must not expand the link
// synchronously.)
const LONG = "Go [docs](https://example.com/a/very/long/path/that/keeps/going)";

test("focusing does not synchronously expand a folded link", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: LONG },
  ]);
  await expect(text(page, "n").locator("a[data-link]")).toHaveCount(1);

  // Put the caret on the trailing link (end) while still blurred, then focus,
  // and check IN THE SAME TICK whether the folded <a> survived. The old
  // synchronous reveal would have already swapped it for raw spans.
  const stillFolded = await text(page, "n").evaluate((el: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // caret at the very end, on the link
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    el.focus(); // the editor's onFocus runs synchronously here
    return el.querySelectorAll("a[data-link]").length === 1;
  });
  expect(stillFolded).toBe(true);

  // It still reveals on the next frame, caret preserved at the end: a sentinel
  // typed now lands AFTER the link, leaving the token intact.
  await expect(text(page, "n").locator(".link-reveal")).toBeVisible();
  await page.keyboard.type("!");
  await expect.poll(() => readSource(page, "n")).toBe(LONG + "!");
});
test("bare URL paste folds immediately and keeps its URL when no title is returned", async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === "/api/unfurl",
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ title: null }),
      }),
  );
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "" },
  ]);

  await focusBullet(page, "n");
  await pasteInto(text(page, "n"), { plain: "https://example.com" });

  // Folds on the spot even while focused: the trailing space puts the caret
  // PAST the link, so it's no longer the revealed one. No click-away needed.
  const anchor = text(page, "n").locator("a[data-link]");
  await expect(anchor).toHaveText("https://example.com");
  await expect(anchor).toHaveAttribute("href", "https://example.com");
  await expect(anchor).not.toHaveClass(/link-unfurling/);
  // Source is the link plus the appended space.
  await expect
    .poll(() => readSource(page, "n"))
    .toBe("[https://example.com](https://example.com) ");
});

test("pasting a URL over a selection wraps the selection as the label", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "Anthropic" },
  ]);

  await focusBullet(page, "n");
  await text(page, "n").evaluate((el: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await pasteInto(text(page, "n"), { plain: "https://anthropic.com" });

  // The caret keeps the end-of-link position, so the new link is bracket-
  // revealed: `[Anthropic]()` visible, the url folded into the `(✎)` chip.
  await expect(text(page, "n")).toHaveText("[Anthropic]()");
  await expect(text(page, "n").locator(".link-url-chip")).toHaveAttribute(
    "data-src",
    "https://anthropic.com",
  );
  await expect.poll(() => readSource(page, "n")).toBe(LINK);
});

test("pasting a rich link (single anchor) inserts [title](url) and folds it", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "" },
  ]);

  await focusBullet(page, "n");
  await pasteInto(text(page, "n"), {
    html: '<meta charset="utf-8"><a href="https://anthropic.com">Anthropic</a>',
    plain: "Anthropic",
  });

  const anchor = text(page, "n").locator("a[data-link]");
  await expect(anchor).toHaveText("Anthropic");
  await expect(anchor).toHaveAttribute("href", "https://anthropic.com");
  await expect.poll(() => readSource(page, "n")).toBe(`${LINK} `);
});

test("URLs with parens are percent-encoded so the link still parses", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "" },
  ]);

  await focusBullet(page, "n");
  await pasteInto(text(page, "n"), {
    plain: "https://en.wikipedia.org/wiki/Foo_(bar)",
  });

  // Folds immediately to one anchor with the encoded href.
  const anchor = text(page, "n").locator("a[data-link]");
  await expect(anchor).toHaveAttribute(
    "href",
    "https://en.wikipedia.org/wiki/Foo_%28bar%29",
  );
  // Source keeps the literal label, the encoded url, and the trailing space.
  await expect
    .poll(() => readSource(page, "n"))
    .toBe(
      "[https://en.wikipedia.org/wiki/Foo_(bar)](https://en.wikipedia.org/wiki/Foo_%28bar%29) ",
    );
});

// Title unfurl (ADR 0016): after a bare-url paste, /api/unfurl is asked for the
// page title and it's swapped into the label. The verbatim-match-or-drop logic
// is unit-tested (swapLinkLabel, links.test.ts); these two cover the live
// fetch -> swap / fallback integration through the real plugin path.
test("pasting a bare URL fetches its title and swaps it into the label", async ({
  page,
}) => {
  // Hold the unfurl response until we release it, so we can observe the
  // in-flight spinner state before the title lands.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route(
    (url) => url.pathname === "/api/unfurl",
    async (route) => {
      await gate;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ title: "Anthropic" }),
      });
    },
  );

  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: "" },
  ]);
  await focusBullet(page, "n");
  await pasteInto(text(page, "n"), { plain: "https://anthropic.com" });

  // In flight: the folded link wears the spinner class and still shows the url.
  const anchor = text(page, "n").locator("a[data-link]");
  await expect(anchor).toHaveClass(/link-unfurling/);
  await expect(anchor).toHaveText("https://anthropic.com");

  release(); // let the title come back

  // The label swaps to the fetched title, the spinner clears, and the source
  // carries the new label (+ the trailing space).
  const swapped = text(page, "n").locator("a[data-link]");
  await expect(swapped).toHaveText("Anthropic");
  await expect(swapped).not.toHaveClass(/link-unfurling/);
  await expect
    .poll(() => readSource(page, "n"))
    .toBe("[Anthropic](https://anthropic.com) ");
});

const popover = (page: Page) => page.locator("[data-link-edit-popover]");

test("the pencil on a folded link opens the editor; Done rewrites label and url", async ({
  page,
}) => {
  await load(page, [
    {
      id: "n",
      parentId: null,
      prevSiblingId: null,
      text: `before ${LINK} after`,
    },
  ]);

  const pencil = text(page, "n").getByRole("button", { name: "Edit link" });
  const buttonBox = await pencil.boundingBox();
  await pencil.click();

  // The popover opens prefilled -- and the pencil click did NOT open the url.
  await expect(popover(page)).toBeVisible();
  await expect
    .poll(async () => {
      const box = await popover(page).boundingBox();
      return Math.round(box!.x + box!.width / 2);
    })
    .toBe(Math.round(buttonBox!.x + buttonBox!.width / 2));
  await expect
    .poll(async () => Math.round((await popover(page).boundingBox())!.y))
    .toBe(Math.round(buttonBox!.y + buttonBox!.height + 6));
  await expect(popover(page).getByLabel("Link text")).toHaveValue("Anthropic");
  await expect(popover(page).getByLabel("Link URL")).toHaveValue(
    "https://anthropic.com",
  );
  expect(await opened(page)).toEqual([]);

  await popover(page).getByLabel("Link text").fill("Claude");
  await popover(page).getByLabel("Link URL").fill("https://claude.ai");
  await popover(page).getByRole("button", { name: "Done" }).click();

  // Closed, and the token was rewritten in place (a field edit).
  await expect(popover(page)).toHaveCount(0);
  await expect.poll(() => activeNodeId(page)).toBe("n");
  const anchor = text(page, "n").locator("a[data-link]");
  await expect(anchor).toHaveText("Claude");
  await expect(anchor).toHaveAttribute("href", "https://claude.ai");
  await expect
    .poll(() => readSource(page, "n"))
    .toBe("before [Claude](https://claude.ai) after");
});

test("Cancel leaves the link untouched", async ({ page }) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: LINK },
  ]);

  await text(page, "n").getByRole("button", { name: "Edit link" }).click();
  await popover(page).getByLabel("Link text").fill("changed");
  await popover(page).getByRole("button", { name: "Cancel" }).click();

  await expect(popover(page)).toHaveCount(0);
  await expect.poll(() => activeNodeId(page)).toBe("n");
  await expect.poll(() => readSource(page, "n")).toBe(LINK);
});

for (const revealed of [false, true]) {
  test(`editing the second URL preserves earlier destinations (${revealed ? "revealed" : "folded"})`, async ({
    page,
  }) => {
    const url = "https://example.com/";
    const prefix = `[Earlier](${url}) and `;
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: prefix + url },
    ]);
    if (revealed) {
      await placeCaret(text(page, "n"), "end");
      await page.keyboard.press("ArrowLeft");
      await expect(text(page, "n").locator(".link-url-chip")).toHaveCount(0);
    }
    await text(page, "n")
      .getByRole("button", { name: "Edit link" })
      .nth(1)
      .click();
    await popover(page).getByLabel("Link URL").fill("https://later.example/");
    await popover(page).getByRole("button", { name: "Done" }).click();
    await expect
      .poll(() => readSource(page, "n"))
      .toBe(`${prefix}https://later.example/`);

    // Identical Markdown links are separate source occurrences too.
    const fixture = await load(page, [
      {
        id: "n",
        parentId: null,
        prevSiblingId: null,
        text: `${LINK} and ${LINK}`,
      },
    ]);
    if (revealed) {
      await placeCaret(text(page, "n"), "end");
      await page.keyboard.press("ArrowLeft");
      await expect(text(page, "n").locator(".link-url-chip")).toBeVisible();
    }
    await text(page, "n")
      .getByRole("button", { name: "Edit link" })
      .nth(1)
      .click();
    await popover(page).getByLabel("Link text").fill("Second");
    await popover(page).getByRole("button", { name: "Done" }).click();
    await expect
      .poll(() => readSource(page, "n"))
      .toBe(`${LINK} and [Second](https://anthropic.com)`);
    await text(page, "n")
      .getByRole("button", { name: "Edit link" })
      .nth(1)
      .click();
    await popover(page).getByLabel("Link text").fill("Stale draft");
    const nodes: ApiNode[] = await page.evaluate(() =>
      fetch("/api/nodes").then((response) => response.json()),
    );
    const movedSource = `New prefix ${LINK} and [Second](https://anthropic.com)`;
    await fixture.injectExternalChange([
      {
        op: "update",
        value: { ...nodes[0]!, text: movedSource, updatedAt: 100 },
      },
    ]);
    await expect.poll(() => readSource(page, "n")).toBe(movedSource);
    await popover(page).getByRole("button", { name: "Done" }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect.poll(() => readSource(page, "n")).toBe(movedSource);
  });
}

test("the revealed link's (✎) chip opens the editor too", async ({ page }) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: LINK },
  ]);

  await focusBullet(page, "n");
  await expect(text(page, "n").locator(".link-url-chip")).toBeVisible();
  await text(page, "n").locator(".link-url-chip").click();

  await expect(popover(page)).toBeVisible();
  await expect(popover(page).getByLabel("Link URL")).toHaveValue(
    "https://anthropic.com",
  );

  await popover(page).getByLabel("Link URL").fill("https://claude.ai");
  await popover(page).getByRole("button", { name: "Done" }).click();

  await expect
    .poll(() => readSource(page, "n"))
    .toBe("[Anthropic](https://claude.ai)");
});
const SRC = `before ${LINK} after`;

// Select the whole line and dispatch a synthetic copy/cut carrying a
// DataTransfer, then read back what the handler wrote to it. The folded <a>
// renders only "Anthropic", so a native copy would lose the url half.
const clip = (page: Page, id: string, type: "copy" | "cut") =>
  text(page, id).evaluate((el: HTMLElement, t) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const dt = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent(t, {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
    return dt.getData("text/plain");
  }, type);

test("copy preserves folded-link source and cut removes the same selection", async ({
  page,
}) => {
  await load(page, [
    { id: "n", parentId: null, prevSiblingId: null, text: SRC },
  ]);

  expect(await clip(page, "n", "copy")).toBe(SRC);
  // Copy doesn't disturb the line.
  await expect(text(page, "n").locator("a[data-link]")).toHaveText("Anthropic");
  expect(await clip(page, "n", "cut")).toBe(SRC);
  await expect(text(page, "n")).toHaveText("");
});
