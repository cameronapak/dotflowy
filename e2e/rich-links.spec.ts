import { expect, test, type Locator, type Page } from "@playwright/test";
import { seedOutline, type SeedNode } from "./fixtures";

// Rich links (ADR 0017): markdown `[label](url)` in node.text that folds to a
// clean <a> while the bullet is blurred and reveals to raw markdown while it's
// focused. These specs cover the fold/reveal swap, click-to-open, and the four
// paste paths.

const text = (page: Page, id: string) =>
  page.locator(`li[data-node-id="${id}"] > .outline-row > .node-text`);

async function load(page: Page, tree: SeedNode[]) {
  // Record window.open calls so we can assert click-to-open without juggling
  // real popups (noopener tabs are flaky to capture).
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await seedOutline(page, tree);
  await page.goto("/");
  await expect(text(page, tree[0]!.id)).toBeVisible();
}

// Dispatch a synthetic paste carrying clipboard data. The caret/selection must
// already be set on `locator` -- the handler splices into the current range.
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
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

const opened = (page: Page) =>
  page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

const LINK = "[Anthropic](https://anthropic.com)";

test.describe("Rich links fold and reveal", () => {
  test("a blurred bullet folds the link to a clean <a>; focusing reveals raw markdown", async ({
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
    // so a click on it still opens the link. The img carries no text, so the
    // anchor's text stays the label.
    const favicon = anchor.locator("img.link-favicon");
    await expect(favicon).toHaveAttribute(
      "src",
      "https://www.google.com/s2/favicons?domain=anthropic.com&sz=64",
    );

    // Focus reveals the literal markdown for editing, and the <a> is gone.
    await focusBullet(page, "n");
    await expect(text(page, "n")).toHaveText(LINK);
    await expect(text(page, "n").locator("a[data-link]")).toHaveCount(0);

    // Blur folds it back.
    await blurActive(page);
    await expect(text(page, "n").locator("a[data-link]")).toHaveText(
      "Anthropic",
    );
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
    // Still folded -- the click opened, it didn't focus into edit mode.
    await expect(text(page, "n").locator("a[data-link]")).toBeVisible();
  });
});

test.describe("Per-link reveal", () => {
  const A = "[A](https://a.com)";
  const B = "[B](https://b.com)";
  const TWO = `${A} ${B}`;

  test("focusing a multi-link line reveals only the link under the caret", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: TWO },
    ]);

    // Blurred: both links folded.
    await expect(text(page, "n").locator("a[data-link]")).toHaveCount(2);

    // Focus with no prior caret lands at offset 0, on the first link only.
    await focusBullet(page, "n");
    // First link revealed (raw, decorated), second still folded.
    await expect(text(page, "n").locator(".link-reveal")).toHaveText(A);
    const folded = text(page, "n").locator("a[data-link]");
    await expect(folded).toHaveCount(1);
    await expect(folded).toHaveText("B");
  });

  test("moving the caret onto the other link reveals it and folds the first", async ({
    page,
  }) => {
    await load(page, [
      { id: "n", parentId: null, prevSiblingId: null, text: TWO },
    ]);

    await focusBullet(page, "n");
    await expect(text(page, "n").locator(".link-reveal")).toHaveText(A);

    // Move the caret to just before the still-folded second link. Setting the
    // selection fires selectionchange, which drives the per-link reflow (the
    // same path an ArrowRight across the boundary would take).
    await text(page, "n").evaluate((el: HTMLElement) => {
      const anchor = el.querySelector("a[data-link]")!;
      const range = document.createRange();
      range.setStartBefore(anchor);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });

    // Now the SECOND link is raw and the FIRST has folded back.
    await expect(text(page, "n").locator(".link-reveal")).toHaveText(B);
    const folded = text(page, "n").locator("a[data-link]");
    await expect(folded).toHaveCount(1);
    await expect(folded).toHaveText("A");
  });
});

test.describe("Click caret near a folded link", () => {
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
        const e = n as HTMLElement;
        if (e.hasAttribute?.("data-link") && e.hasAttribute("data-src")) {
          out += e.getAttribute("data-src") ?? "";
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
    await load(page, [{ id: "n", parentId: null, prevSiblingId: null, text: LONG }]);
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
    expect(await readSource(page, "n")).toBe(LONG + "!");
  });
});

test.describe("Creating links by paste", () => {
  // Mirror of readSource: a folded <a> contributes its data-src, every other
  // node its textContent. A just-pasted link folds immediately, so the raw
  // markdown lives only in data-src (plus the trailing space we append).
  const readSrc = (page: Page, id: string) =>
    text(page, id).evaluate((el: HTMLElement) => {
      let out = "";
      const visit = (n: Node) => {
        if (n.nodeType === 3) {
          out += n.textContent ?? "";
          return;
        }
        const e = n as HTMLElement;
        if (e.hasAttribute?.("data-link") && e.hasAttribute("data-src")) {
          out += e.getAttribute("data-src") ?? "";
          return;
        }
        n.childNodes.forEach(visit);
      };
      el.childNodes.forEach(visit);
      return out;
    });

  test("pasting a bare URL auto-links it and folds it immediately", async ({
    page,
  }) => {
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
    // Source is the link plus the appended space.
    expect(await readSrc(page, "n")).toBe(
      "[https://example.com](https://example.com) ",
    );
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

    await expect(text(page, "n")).toHaveText(LINK);
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
    expect(await readSrc(page, "n")).toBe(`${LINK} `);
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
    expect(await readSrc(page, "n")).toBe(
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
    expect(await readSrc(page, "n")).toBe("[Anthropic](https://anthropic.com) ");
  });

  test("a failed title fetch keeps the url placeholder", async ({ page }) => {
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
    await pasteInto(text(page, "n"), { plain: "https://anthropic.com" });

    // Nothing swaps, the spinner clears, the url-label placeholder stands -- it
    // is the graceful fallback, already a working folded link.
    const anchor = text(page, "n").locator("a[data-link]");
    await expect(anchor).toHaveText("https://anthropic.com");
    await expect(anchor).not.toHaveClass(/link-unfurling/);
    expect(await readSrc(page, "n")).toBe(
      "[https://anthropic.com](https://anthropic.com) ",
    );
  });
});
