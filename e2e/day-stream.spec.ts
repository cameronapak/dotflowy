import { expect, test, type Page } from "@playwright/test";

import {
  mockKeyboardViewport,
  openSeededOutline,
  placeCaret,
  seedOutline,
  STANDARD_TREE,
  text,
  type ApiNode,
} from "./fixtures";

// ADR 0070: a zoomed day note continues into the days around it. Fixed days far
// from "now", so the stream around them is all Empty days but these two.
const DAY = "2030-06-12";
const PREV = "2030-06-11";
const NEXT = "2030-06-13";

const TREE = [
  ...STANDARD_TREE,
  { id: "the-day", parentId: null, prevSiblingId: "charlie", text: "" },
  { id: "standup", parentId: "the-day", prevSiblingId: null, text: "Standup" },
  { id: "prev-day", parentId: null, prevSiblingId: "the-day", text: "" },
  { id: "dentist", parentId: "prev-day", prevSiblingId: null, text: "Dentist" },
];
const KV = {
  "daily-index": [
    { key: DAY, value: { key: DAY, nodeId: "the-day" } },
    { key: PREV, value: { key: PREV, nodeId: "prev-day" } },
  ],
};

async function clientNavigate(page: Page, path: string) {
  // Client navigation keeps the seeded in-memory store (a reload re-syncs).
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function openDay(page: Page) {
  await seedOutline(page, TREE, { kv: KV });
  await openSeededOutline(page, { anchorId: "alpha" });
  await clientNavigate(page, "/the-day");
  await expect(section(page, DAY, "title")).toBeVisible();
}

/** Hold the daily-index claim for `key` until the returned release runs. */
async function holdClaim(page: Page, key: string) {
  let release = () => {};
  let seen = () => {};
  const claimSeen = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/kv",
    async (route) => {
      const request = route.request();
      // SAFETY: claim POSTs carry a JSON body with a key; others pass through.
      const body = request.postDataJSON() as { key?: string } | null;
      if (
        request.method() === "POST" &&
        new URL(request.url()).searchParams.get("op") === "claim" &&
        body?.key === key
      ) {
        seen();
        await released;
      }
      await route.fallback();
    },
  );
  return { claimSeen, release };
}

const section = (page: Page, key: string, kind: string) =>
  page.locator(`[data-stream-item="${kind}"][data-section="${key}"]`);
const pill = (page: Page, key: string) =>
  page
    .getByRole("navigation", { name: "Week calendar" })
    .locator(`[data-day-key="${key}"]`);

test("dropping on a visible row keeps the scrolled day and reading position", async ({
  page,
}) => {
  const entries = Array.from({ length: 80 }, (_, i) => ({
    id: `entry-${i}`,
    parentId: "prev-day",
    prevSiblingId: i ? `entry-${i - 1}` : "dentist",
    text: `Entry ${i}`,
  }));
  await seedOutline(page, [...TREE, ...entries], { kv: KV });
  await openSeededOutline(page, { anchorId: "alpha" });
  await clientNavigate(page, "/the-day");

  for (const [entry, offset, nest] of [
    [30, 1050, false],
    [30, 1050, true],
    [3, 80, false],
    [4, -80, false],
  ] as const) {
    await pill(page, DAY).click();
    await expect(pill(page, DAY)).toHaveAttribute("data-selected", "");
    await pill(page, PREV).click();
    await expect(page).toHaveURL(new RegExp(`/the-day\\?day=${PREV}$`));
    await expect
      .poll(() =>
        section(page, PREV, "title").evaluate((el) =>
          Math.abs(
            el.getBoundingClientRect().top -
              document.querySelector(".outline-chrome")!.getBoundingClientRect()
                .bottom,
          ),
        ),
      )
      .toBeLessThan(2);
    const seated = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, offset);
    await expect
      .poll(() =>
        page.evaluate(
          ({ seated, offset }) => Math.abs(window.scrollY - seated - offset),
          { seated, offset },
        ),
      )
      .toBeLessThan(2);
    const from = await page
      .locator(`li[data-node-id="entry-${entry}"] .bullet`)
      .boundingBox();
    const target = await page
      .locator(`li[data-node-id="entry-${entry + 4}"]`)
      .boundingBox();
    if (!from || !target) throw new Error("missing visible drag rows");
    const before = await page.evaluate(() => window.scrollY);
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 10, y + 10, { steps: 3 });
    await page.mouse.move(x + (nest ? 80 : 0), target.y, { steps: 5 });
    await expect(page.locator(".drag-indicator")).toBeVisible();
    await page.mouse.up();
    const moved = page.locator(`li[data-node-id="entry-${entry}"]`);
    await expect(moved).toHaveAttribute(
      "data-parent-id",
      nest ? "entry-33" : "prev-day",
    );
    await expect(text(page, `entry-${entry}`)).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const nodes: ApiNode[] = await fetch("/api/nodes").then((r) =>
            r.json(),
          );
          return nodes.find((node) => node.id === id)?.prevSiblingId;
        }, `entry-${entry}`),
      )
      .toBe(nest ? null : `entry-${entry + 3}`);
    // Observe past both the scroll-settle and URL debounce, including transient
    // jumps that a final-position assertion alone would miss.
    const drift = await page.evaluate(async (before) => {
      let maximum = 0;
      const until = performance.now() + 700;
      while (performance.now() < until) {
        maximum = Math.max(maximum, Math.abs(window.scrollY - before));
        await new Promise(requestAnimationFrame);
      }
      return maximum;
    }, before);
    expect(drift).toBeLessThan(2);
    const readingDay = offset < 0 ? "2030-06-10" : PREV;
    await expect(pill(page, readingDay)).toHaveAttribute("data-selected", "");
    await expect(page).toHaveURL(new RegExp(`/the-day\\?day=${readingDay}$`));
  }
});

test.describe("day navigation on touch", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test.beforeEach(async ({ page }) => mockKeyboardViewport(page));

  for (const spotlight of [false, true]) {
    test(`Today owns the title until editing takes over, spotlight ${spotlight}`, async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date("2030-06-12T12:00:00"));
      const entries = Array.from({ length: 80 }, (_, i) => ({
        id: `entry-${i}`,
        parentId: "the-day",
        prevSiblingId: i ? `entry-${i - 1}` : "standup",
        text: `Entry ${i}`,
      }));
      const controller = await seedOutline(
        page,
        [
          ...TREE,
          ...entries,
          {
            id: "hidden-tail",
            parentId: "the-day",
            prevSiblingId: "entry-79",
            text: "Completed final child",
            completed: true,
          },
        ],
        { kv: KV },
      );
      await page.addInitScript((enabled) => {
        localStorage.setItem("dotflowy:spotlight", String(enabled));
        localStorage.setItem("dotflowy:show-completed", "false");
      }, spotlight);
      await openSeededOutline(page, { anchorId: "alpha" });
      // Model a standalone iPhone's nonzero safe-area top inset.
      await page.addStyleTag({ content: ".outline-chrome { top: 24px; }" });
      const today = page.getByRole("button", {
        name: "Today's daily note",
        exact: true,
      });
      const title = section(page, DAY, "title");
      const last = text(page, "entry-79");
      const gap = () =>
        title.evaluate(
          (el) =>
            el.getBoundingClientRect().top -
            document
              .querySelector<HTMLElement>(".outline-chrome")!
              .getBoundingClientRect().bottom,
        );
      const seated = async () => {
        await expect.poll(async () => Math.abs(await gap())).toBeLessThan(2);
        await expect(page.locator(".outline-chrome")).toBeInViewport({
          ratio: 1,
        });
        await expect(last).toBeFocused();
      };

      // Home -> Today uses the same title/focus contract as an in-stream tap.
      // The last child starts far outside the virtual window.
      await today.tap();
      await seated();
      await expect(page.locator(".outline-chrome")).toHaveCSS("top", "24px");
      await expect(text(page, "hidden-tail")).not.toBeAttached();
      expect(await page.locator("li[data-node-id]").count()).toBeLessThan(50);
      const nodes: ApiNode[] = await page.evaluate(() =>
        fetch("/api/nodes").then((r) => r.json()),
      );
      await controller.injectExternalChange([
        {
          op: "update",
          value: {
            ...nodes.find((n) => n.id === "standup")!,
            text: "Delayed content that wraps on a narrow screen. ".repeat(40),
          },
        },
      ]);
      await expect(text(page, "standup")).toContainText("Delayed content");
      await seated();
      await page.setViewportSize({ width: 390, height: 868 });
      await seated();

      await pill(page, PREV).tap();
      await expect(section(page, PREV, "title")).toBeInViewport();
      await controller.injectExternalChange([
        {
          op: "update",
          value: {
            ...nodes.find((n) => n.id === "dentist")!,
            text: "Earlier day content arrives after navigation. ".repeat(20),
          },
        },
      ]);
      await expect(text(page, "dentist")).toContainText("Earlier day content");
      await expect
        .poll(() =>
          section(page, PREV, "title").evaluate((el) =>
            Math.abs(
              el.getBoundingClientRect().top -
                document
                  .querySelector<HTMLElement>(".outline-chrome")!
                  .getBoundingClientRect().bottom,
            ),
          ),
        )
        .toBeLessThan(2);
      await today.tap();
      await seated();
      // Observe every frame, not just a final position that two scroll
      // writers might eventually agree on.
      const drift = await title.evaluate(async (el) => {
        let maximum = 0;
        for (let i = 0; i < 30; i++) {
          await new Promise(requestAnimationFrame);
          maximum = Math.max(
            maximum,
            Math.abs(
              el.getBoundingClientRect().top -
                document
                  .querySelector<HTMLElement>(".outline-chrome")!
                  .getBoundingClientRect().bottom,
            ),
          );
        }
        return maximum;
      });
      expect(drift).toBeLessThan(2);

      // Dictation/replacement and IME paths need no keydown or pointerdown.
      // Each must release before a subsequent layout change.
      for (const event of ["beforeinput", "compositionstart", "input"]) {
        await today.tap();
        await seated();
        await last.evaluate(
          (el, event) =>
            el.dispatchEvent(
              event === "compositionstart"
                ? new CompositionEvent(event, { bubbles: true, data: "" })
                : new InputEvent(event, {
                    bubbles: true,
                    inputType: "insertText",
                    data: "",
                  }),
            ),
          event,
        );
        await expect(page.locator(".outline-chrome")).toHaveCSS(
          "position",
          "relative",
        );
        await expect(last).toBeInViewport({ ratio: 1 });
        await expect
          .poll(() =>
            page.evaluate(() => {
              const caret = window
                .getSelection()!
                .getRangeAt(0)
                .getBoundingClientRect();
              const bar = document
                .querySelector("[data-mobile-bar]")
                ?.getBoundingClientRect();
              return caret.top >= 0 && caret.bottom < (bar?.top ?? innerHeight);
            }),
          )
          .toBe(true);
        const beforeScroll = await page.evaluate(() => window.scrollY);
        await page.evaluate(() => window.scrollBy(0, 260));
        await expect
          .poll(() => page.evaluate(() => window.scrollY))
          .toBeGreaterThan(beforeScroll + 200);
        await expect(last).toBeFocused();
        if (event === "compositionstart")
          await last.dispatchEvent("compositionend", { data: "" });
        // End this editing session before starting the next independent input
        // path. Mobile intentionally unsticks chrome while editing.
        if (event !== "input") await last.evaluate((el) => el.blur());
      }
      // Real input still goes to the last child and persists normally.
      await page.keyboard.insertText(" appended");
      await expect(last).toHaveText("Entry 79 appended");
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const nodes: ApiNode[] = await fetch("/api/nodes").then((r) =>
              r.json(),
            );
            return nodes.find((node) => node.id === "entry-79")?.text;
          }),
        )
        .toBe("Entry 79 appended");
      await last.evaluate((el) => el.blur());
      await pill(page, PREV).tap();
      await expect(page).toHaveURL(/day=2030-06-11/);
      // The node snapshot can beat daily-index on a cold direct focus=last
      // route. Stream adoption must supersede the ordinary outline landing,
      // but keep the saved day rather than letting focus=last reset to Today.
      let releaseIndex!: () => void;
      const indexHeld = new Promise<void>((resolve) => {
        releaseIndex = resolve;
      });
      await page.route(
        (url) =>
          url.pathname === "/api/kv" &&
          url.searchParams.get("collection") === "daily-index",
        async (route) => {
          await indexHeld;
          await route.fallback();
        },
      );
      const releaseSnapshot = controller.holdSnapshots();
      await page.reload();
      // Deliver nodes after the editor mounts empty, before the daily index.
      // Focus must wait for those rows to enter the presentation index too.
      await page.getByRole("status", { name: "Loading outline" }).waitFor();
      releaseSnapshot();
      await expect(last).toHaveText("Entry 79 appended");
      await expect(last).toBeFocused();
      releaseIndex();
      await expect
        .poll(() =>
          section(page, PREV, "title").evaluate((el) =>
            Math.abs(
              el.getBoundingClientRect().top -
                document
                  .querySelector(".outline-chrome")!
                  .getBoundingClientRect().bottom,
            ),
          ),
        )
        .toBeLessThan(2);
      await expect(page).toHaveURL(/day=2030-06-11/);
      await expect(last).toBeFocused();
      await today.tap();
      await seated();
    });

    test(`input reveals a short day's caret behind the toolbar, spotlight ${spotlight}`, async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date("2030-06-12T12:00:00"));
      await seedOutline(page, TREE, { kv: KV });
      await page.addInitScript((enabled) => {
        localStorage.setItem("dotflowy:spotlight", String(enabled));
      }, spotlight);
      await openSeededOutline(page, { anchorId: "alpha" });
      await page
        .getByRole("button", { name: "Today's daily note", exact: true })
        .tap();
      const editor = text(page, "standup");
      await expect(editor).toBeFocused();
      const caretBottom = await editor.evaluate(
        (el) => el.getBoundingClientRect().bottom,
      );
      // A reduced viewport puts this short day's last line inside the screen
      // but behind the toolbar, unlike the long day's fully offscreen caret.
      // The fixture reserves 300px of the layout viewport for the keyboard.
      await page.setViewportSize({
        width: 390,
        height: Math.ceil(caretBottom + 8 + 300),
      });
      const caretClear = () =>
        editor.evaluate((el) => {
          const caret = el.getBoundingClientRect();
          const bar = document
            .querySelector("[data-mobile-bar]")!
            .getBoundingClientRect();
          return {
            inViewport: caret.top >= 0 && caret.bottom < visualViewport!.height,
            aboveToolbar: caret.bottom < bar.top,
          };
        });
      await expect.poll(caretClear).toEqual({
        inViewport: true,
        aboveToolbar: false,
      });
      await page.keyboard.insertText(" appended");
      await expect(editor).toHaveText("Standup appended");
      await expect(editor).toBeFocused();
      await expect.poll(caretClear).toEqual({
        inViewport: true,
        aboveToolbar: true,
      });
      const before = await page.evaluate(() => scrollY);
      await page.evaluate(() => window.scrollBy(0, 100));
      await expect
        .poll(() => page.evaluate(() => scrollY))
        .toBeGreaterThan(before + 90);
    });

    test(`input during a title-held prepend keeps the caret revealed, spotlight ${spotlight}`, async ({
      page,
      browserName,
    }) => {
      await page.clock.install();
      await page.clock.setFixedTime(new Date("2030-06-12T12:00:00"));
      await seedOutline(page, TREE, { kv: KV });
      await page.addInitScript((enabled) => {
        localStorage.setItem("dotflowy:spotlight", String(enabled));
      }, spotlight);
      await openSeededOutline(page, { anchorId: "alpha" });
      // Paused, no stream settle (180ms) can load days before the race below.
      await page.clock.pauseAt(new Date("2030-06-12T12:00:01"));
      await page
        .getByRole("button", { name: "Today's daily note", exact: true })
        .tap();
      const editor = text(page, "standup");
      await expect
        .poll(async () => {
          await page.clock.runFor(1);
          return editor.evaluate((el) => el === document.activeElement);
        })
        .toBe(true);
      // WebKit can deliver the toolbar's visualViewport resize after input.
      // Keep Chromium's ordinary resize path; force the late delivery here.
      const releaseResize =
        browserName === "webkit"
          ? await page.evaluateHandle(() => {
              const viewport = window.visualViewport!;
              const stop = (e: Event) => e.stopImmediatePropagation();
              viewport.addEventListener("resize", stop, true);
              return () => {
                viewport.removeEventListener("resize", stop, true);
                viewport.dispatchEvent(new Event("resize"));
              };
            })
          : null;
      await page.setViewportSize({
        width: 390,
        height: Math.ceil(
          await editor.evaluate(
            (el) => el.getBoundingClientRect().bottom + 8 + 300,
          ),
        ),
      });
      const caretClear = () =>
        editor.evaluate((el) => {
          const caret = el.getBoundingClientRect();
          const bar = document
            .querySelector("[data-mobile-bar]")!
            .getBoundingClientRect();
          return caret.top >= 0 && caret.bottom < bar.top;
        });
      await expect
        .poll(async () => {
          await page.clock.runFor(1);
          return editor.evaluate((el) => {
            const caret = el.getBoundingClientRect();
            const bar = document
              .querySelector("[data-mobile-bar]")!
              .getBoundingClientRect();
            // Positive geometry, not !caretClear: above the viewport would
            // satisfy that too, before the resized title has been seated.
            return (
              caret.top >= 0 &&
              caret.bottom <= visualViewport!.height &&
              (bar.top > visualViewport!.height || caret.bottom > bar.top)
            );
          });
        })
        .toBe(true);
      // CI order: the settle dispatches a prepend while the title still owns
      // corrections, then input releases the title before React commits it.
      // A late resize scroll re-arms the settle, so follow its replacement.
      await page.evaluate(() => {
        const { setTimeout, clearTimeout } = window;
        let settleId = 0;
        const arm = () => {
          // SAFETY: the stream arms its settle as setTimeout(callback, ms).
          window.setTimeout = ((settle: () => void, ms?: number) => {
            window.setTimeout = setTimeout;
            settleId = setTimeout(() => {
              window.clearTimeout = clearTimeout;
              settle();
              // Each keystroke releases again; neither may drop the hold.
              document.execCommand("insertText", false, " ");
              document.execCommand("insertText", false, "appended");
              // A caret reveal can advance before the dispatched prepend
              // commits. Its scroll must not discard that compensation.
              window.scrollBy({ top: 8, behavior: "instant" });
              window.dispatchEvent(new Event("scroll"));
            }, ms);
            return settleId;
          }) as typeof window.setTimeout;
        };
        window.clearTimeout = (id) => {
          if (id === settleId) arm();
          clearTimeout(id);
        };
        arm();
        window.dispatchEvent(new PointerEvent("pointerup"));
      });
      await page.clock.runFor(500);
      await releaseResize?.evaluate((release) => release());
      await releaseResize?.dispose();
      await expect(editor).toHaveText("Standup appended");
      await expect
        .poll(() =>
          page
            .getByRole("toolbar", { name: "Editing actions" })
            .evaluate(
              (el) =>
                el.getBoundingClientRect().bottom <= visualViewport!.height,
            ),
        )
        .toBe(true);
      await expect.poll(caretClear).toBe(true);
      // The raced settle did load the days above.
      await expect(section(page, PREV, "title")).toBeAttached();
    });
  }
});

test.describe("touch momentum", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  for (const input of ["touch", "pointer"] as const) {
    test(`prepending folded days waits for ${input} scrolling to settle`, async ({
      page,
      context,
    }) => {
      await page.addInitScript(() => {
        // Playwright's clock also replaces rAF with timer callbacks, which can
        // sample between layout and its ResizeObserver compensation. Freeze
        // only Date: this gesture needs real browser frames and idle timers.
        const NativeDate = Date;
        const now = new NativeDate("2030-06-12T12:00:00").getTime();
        window.Date = new Proxy(NativeDate, {
          apply: () => new NativeDate(now).toString(),
          construct: (target, args) =>
            Reflect.construct(target, args.length ? args : [now]),
        });
        window.Date.now = () => now;
      });
      const days = Array.from({ length: 22 }, (_, i) => ({
        id: `note-${i}`,
        key: new Date(Date.UTC(2030, 5, 12 - i * 2)).toISOString().slice(0, 10),
      }));
      const controller = await seedOutline(
        page,
        days.flatMap(({ id }, i) => [
          {
            id,
            parentId: null,
            prevSiblingId: i ? `note-${i - 1}` : null,
            text: "",
          },
          {
            id: `${id}-entry`,
            parentId: id,
            prevSiblingId: null,
            text: "A day's entry",
          },
        ]),
        {
          kv: {
            "daily-index": days.map(({ id, key }) => ({
              key,
              value: { key, nodeId: id },
            })),
            "account-prefs": [
              {
                key: "daily:empty-days",
                value: { key: "daily:empty-days", emptyDays: "fold" },
              },
            ],
          },
        },
      );
      await openSeededOutline(page, { path: "/note-0" });
      await expect(section(page, DAY, "title")).toBeInViewport();
      await page
        .getByRole("button", { name: "Previous week", exact: true })
        .tap();
      await page
        .getByRole("button", { name: "Tuesday, June 4, 2030", exact: true })
        .tap();
      await expect(section(page, "2030-06-04", "title")).toBeInViewport();
      await expect(
        page.locator('[data-stream-item="fold"]').first(),
      ).toBeAttached();
      // Start just outside the prepend threshold regardless of how many
      // chunks the cold opening needed. Follow a visible title from here.
      await page.keyboard.press("Escape");
      await page.evaluate(async () => {
        window.scrollTo(0, 1900);
        for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
      });
      const heldKey = await page.evaluate(() => {
        const titles = [
          ...document.querySelectorAll<HTMLElement>(
            '[data-stream-item="title"]',
          ),
        ];
        return titles.find((el) => {
          const top = el.getBoundingClientRect().top;
          return top >= 150 && top < 900;
        })!.dataset.section!;
      });
      const held = section(page, heldKey, "title");
      const before = await held.evaluate((el) => ({
        top: el.getBoundingClientRect().top,
        start: el.getBoundingClientRect().top + scrollY,
      }));

      // CDP sends trusted native touch input. Keep sampling the same title's
      // screen position across the prepend, rather than comparing scrollY,
      // which legitimately grows by the height of the inserted days.
      await page.evaluate((key) => {
        const samples: { top: number; start: number; ended: boolean }[] = [];
        let ended = false;
        let moves = 0;
        addEventListener("touchmove", () => moves++, { passive: true });
        addEventListener(
          "touchend",
          () => {
            ended = true;
          },
          { once: true },
        );
        addEventListener(
          "pointerup",
          () => {
            ended = true;
          },
          { once: true },
        );
        const sample = () => {
          const el = document.querySelector(
            `[data-stream-item="title"][data-section="${key}"]`,
          );
          if (el) {
            const top = el.getBoundingClientRect().top;
            samples.push({ top, start: top + scrollY, ended });
          }
          raf = requestAnimationFrame(sample);
        };
        let raf = requestAnimationFrame(sample);
        Object.assign(window, {
          readTouch: () => ({ samples, moves }),
          stopTouch: () => cancelAnimationFrame(raf),
        });
      }, heldKey);
      const cdp = await context.newCDPSession(page);
      if (input === "touch") {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: 195, y: 230 }],
        });
        for (let y = 270; y <= 750; y += 40) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: 195, y }],
          });
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
        }
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      } else {
        // One pointer gesture, followed by browser offsets without more input
        // events: the same event contract as dragging the native scrollbar.
        await page.mouse.move(388, 230);
        await page.mouse.down();
        // A late content measurement above the viewport must be absorbed by
        // that day's filler before paint, not shift later titles for a frame.
        const above = await page.evaluate(async () => {
          const id = [
            ...document.querySelectorAll<HTMLElement>("li[data-node-id]"),
          ].find((el) => el.getBoundingClientRect().bottom < 0)!.dataset.nodeId;
          const nodes: ApiNode[] = await fetch("/api/nodes").then((r) =>
            r.json(),
          );
          return nodes.find((node) => node.id === id)!;
        });
        await controller.injectExternalChange([
          {
            op: "update",
            value: { ...above, text: "A day's entry\nA late line" },
          },
        ]);
        await expect(text(page, above.id)).toHaveText(
          "A day's entry\nA late line",
        );
        await page.evaluate(async () => {
          for (let i = 0; i < 13; i++) {
            window.scrollBy(0, -40);
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
          }
        });
        // A paused scrollbar drag is still held input, not an idle gesture.
        // Deliberately exceed the 180ms settle delay without releasing input.
        await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
        await page.mouse.up();
      }
      // CDP touch dispatch does not produce reliable native inertia. Model the
      // browser's post-touch scroll events without another input gesture. This
      // tests our deferral contract, not physical iOS momentum physics.
      await page.evaluate(async () => {
        for (let i = 0; i < 10; i++) {
          window.scrollBy(0, -30);
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        }
        for (let i = 0; i < 30; i++) await new Promise(requestAnimationFrame);
      });
      await expect
        .poll(() =>
          held.evaluate((el) => el.getBoundingClientRect().top + scrollY),
        )
        .toBeGreaterThan(before.start + 1000);
      const result = await page.evaluate(() => {
        // SAFETY: this test installed the observer immediately above.
        const observer = window as typeof window & {
          readTouch(): {
            samples: { top: number; start: number; ended: boolean }[];
            moves: number;
          };
          stopTouch(): void;
        };
        observer.stopTouch();
        return observer.readTouch();
      });
      await cdp.detach();
      if (input === "touch") expect(result.moves).toBeGreaterThan(0);
      expect(
        result.samples
          .filter((s) => !s.ended)
          .filter((s) => Math.abs(s.start - before.start) >= 2),
      ).toEqual([]);
      const inserted = result.samples.findIndex(
        (s) => s.start > before.start + 1000,
      );
      expect(inserted).toBeGreaterThan(0);
      expect(
        Math.abs(
          result.samples[inserted]!.top - result.samples[inserted - 1]!.top,
        ),
      ).toBeLessThan(2);
      // Insertion waits for coasting too, not merely touchend. Inspect the
      // gesture through the insertion frame to check both momentum deferral
      // and the compensating scroll.
      const gesture = result.samples.slice(0, inserted + 1);
      const moving = gesture.filter(
        (s, i) => i > 0 && s.top - result.samples[i - 1]!.top > 2,
      );
      expect(
        moving.filter((s) => Math.abs(s.start - before.start) >= 2),
      ).toEqual([]);
      expect(gesture.at(-1)!.top).toBeGreaterThan(before.top + 500);
      const coasting = gesture.filter((s) => s.ended);
      expect(coasting.at(-1)!.top - coasting[0]!.top).toBeGreaterThan(40);
      const jumps = gesture
        .slice(1)
        .map((s, i) => s.top - result.samples[i]!.top);
      expect(Math.min(...jumps)).toBeGreaterThan(-40);
      expect(Math.max(...jumps)).toBeLessThan(120);
    });
  }
});

test("row-targeted navigation into a long day keeps the target in view", async ({
  page,
}) => {
  const entries = Array.from({ length: 80 }, (_, i) => ({
    id: `entry-${i}`,
    parentId: "the-day",
    prevSiblingId: i ? `entry-${i - 1}` : "standup",
    text: `Entry ${i}`,
  }));
  await seedOutline(
    page,
    [
      ...TREE.map((node) =>
        node.id === "the-day"
          ? { ...node, text: "Long day", bookmarkedAt: 100 }
          : node,
      ),
      ...entries,
    ],
    { kv: KV },
  );
  let releaseIndex!: () => void;
  const indexHeld = new Promise<void>((resolve) => {
    releaseIndex = resolve;
  });
  await page.route(
    (url) =>
      url.pathname === "/api/kv" &&
      url.searchParams.get("collection") === "daily-index",
    async (route) => {
      await indexHeld;
      await route.fallback();
    },
  );
  await page.goto("/entry-79");
  await page.locator(".zoomed-title").waitFor();
  await expect(page.locator(".zoomed-title")).toHaveText("Entry 79");
  await page.keyboard.press("ControlOrMeta+,");
  const last = text(page, "entry-79");
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  releaseIndex();
  await expect(
    page.getByRole("navigation", { name: "Week calendar" }),
  ).toBeVisible();
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await page.setViewportSize({ width: 900, height: 650 });
  await expect(last).toBeInViewport();

  await clientNavigate(page, "/");
  await placeCaret(text(page, "alpha"), "end");
  await page.keyboard.type(" /move");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Enter");
  await page
    .getByRole("dialog")
    .getByRole("option", { name: "Long day" })
    .click();
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page).toHaveURL(/\/the-day/);
  await expect(text(page, "alpha")).toBeFocused();
  await expect(text(page, "alpha")).toBeInViewport();
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(text(page, "alpha")).toBeInViewport();
});

test("a pill scrolls the stream, and the URL and strip follow the day in view", async ({
  page,
}) => {
  await openDay(page);

  await pill(page, PREV).click();
  await expect(page.locator("li[data-node-id=dentist]")).toBeInViewport();
  // The route keeps its anchor; only the search param names the day in view.
  await expect(page).toHaveURL(new RegExp(`/the-day\\?day=${PREV}$`));
  await expect(pill(page, PREV)).toHaveAttribute("data-selected", "");

  await pill(page, DAY).click();
  await expect(page).toHaveURL(/\/the-day$/);
});

test("writing in an Empty day creates its note and keeps every keystroke", async ({
  page,
}) => {
  await openDay(page);
  await expect(section(page, NEXT, "placeholder")).toBeAttached();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder(/Search nodes and actions/).fill("scribble");
  await page.getByRole("option", { name: /Turn on Scribble mode/ }).click();
  const claim = await holdClaim(page, NEXT);

  await pill(page, NEXT).click();
  const entry = page.locator(`[data-stream-entry="${NEXT}"]`);
  await entry.click();
  await page.keyboard.type("Gym at 7");
  await claim.claimSeen;
  await expect(entry).toHaveText("Gym at 7");
  await expect(entry).toHaveCSS("font-family", '"Redacted Script"');
  claim.release();

  // The placeholder became a real day, and the caret moved into its row.
  await expect(section(page, NEXT, "title")).toBeVisible();
  await expect(section(page, NEXT, "placeholder")).toHaveCount(0);
  const active = page.locator(":focus");
  await expect(active).toHaveText("Gym at 7");
  await expect(active).toHaveCSS("font-family", '"Redacted Script"');
  await page.keyboard.type("!");
  await expect(active).toHaveText("Gym at 7!");
  const written = page.locator(".node-text").filter({ hasText: /^Gym at 7!$/ });
  await page.getByRole("button", { name: "Turn off Scribble mode" }).click();
  await expect(written).not.toHaveCSS("font-family", '"Redacted Script"');
});

test("a click elsewhere while an Empty day is being created keeps typing there", async ({
  page,
}) => {
  await openDay(page);
  const claim = await holdClaim(page, NEXT);
  await pill(page, NEXT).click();
  await page.locator(`[data-stream-entry="${NEXT}"]`).click();
  await page.keyboard.type("X");
  await claim.claimSeen;

  // The user moves on before the day exists.
  await pill(page, DAY).click();
  await placeCaret(text(page, "standup"), "end");
  await page.keyboard.type("Z");
  claim.release();

  await expect(section(page, NEXT, "title")).toBeAttached();
  await expect(text(page, "standup")).toHaveText("StandupZ");
  await expect(text(page, "standup")).toBeFocused();
  await expect(
    page.locator(".node-text").filter({ hasText: /^X$/ }),
  ).toHaveCount(1);
});

test("a filter sends commands back to the zoom root, not the last day touched", async ({
  page,
}) => {
  await openDay(page);
  // Working in the previous day points commands at it.
  await pill(page, PREV).click();
  await placeCaret(text(page, "dentist"), "end");

  // A filter shows only the anchor day, with no stream.
  await clientNavigate(page, "/the-day?q=Standup");
  await expect(page.locator("[data-stream-item]")).toHaveCount(0);
  await placeCaret(text(page, "standup"), "end");
  // Outdenting a direct child of the zoom root does nothing. Aimed at the
  // previous day instead, it moved Standup out of this day, out of view.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("!");
  await expect(text(page, "standup")).toHaveText("Standup!");
});

test("a cold link to ?day= opens on that day and keeps it in the URL", async ({
  page,
}) => {
  const LATER = "2030-07-12";
  await page.clock.install();
  await seedOutline(page, TREE, { kv: KV });
  await openSeededOutline(page, { path: `/the-day?day=${LATER}` });
  await expect(section(page, LATER, "placeholder")).toBeInViewport();
  await expect(pill(page, LATER)).toHaveAttribute("data-selected", "");
  // Advance beyond the URL debounce without sleeping in real time.
  await page.clock.runFor(1_000);
  await expect(page).toHaveURL(new RegExp(`/the-day\\?day=${LATER}$`));
});

test("a calendar pick past the stream's reach navigates there", async ({
  page,
}) => {
  const FAR = "2030-09-12"; // beyond the stream's 60-day reach from June 12
  await openDay(page);
  await page.getByTestId("week-calendar-month").click();
  const picker = page.getByTestId("week-calendar-month-picker");
  for (const month of ["July", "August", "September"]) {
    await page.getByTestId("month-picker-next").click();
    await expect(picker).toContainText(month);
  }
  await picker.locator(`[data-day-key="${FAR}"]`).click();

  await expect(page).not.toHaveURL(/\/the-day/);
  await expect(section(page, FAR, "title")).toBeInViewport();
  await expect(pill(page, FAR)).toHaveAttribute("data-selected", "");
});

test("typing stays local and scrolling reuses day-stream layout and content", async ({
  page,
}) => {
  // Observe the running React tree through its DevTools hook, not production
  // counters. PerformedWork is React 19's render flag. Skip shared child lists:
  // a bailout can leave old flags on fibers that did NOT render this commit.
  await page.addInitScript(() => {
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = {
      type: { name?: string } | null;
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
      memoizedState: Hook | null;
      memoizedProps: { rowKey?: string };
    };
    const names = new Set([
      "OutlineEditor",
      "NormalRow",
      "StreamSectionTitle",
      "StreamPlaceholderTitle",
      "StreamEntryLine",
    ]);
    let geometry: unknown;
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      value: {
        supportsFiber: true,
        renderers: new Map<number, unknown>(),
        inject() {
          return 1;
        },
        onCommitFiberRoot(_id: number, root: { current: Fiber }) {
          const visit = (fiber: Fiber) => {
            const name = fiber.type?.name;
            if (name && names.has(name) && fiber.flags & 1) {
              performance.mark(
                `render:${name}:${fiber.memoizedProps.rowKey ?? ""}`,
              );
              if (name === "OutlineEditor") {
                for (let hook = fiber.memoizedState; hook; hook = hook.next) {
                  // The virtualizer is held in React state. Its public layout
                  // snapshot must stay identical on a scroll-only commit.
                  // SAFETY: Hook state is heterogeneous; this optional view is
                  // used only after checking the method and array below.
                  const value = hook.memoizedState as {
                    getVirtualItems?: unknown;
                    measurementsCache?: unknown;
                  } | null;
                  if (
                    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- React hook state has no schema; identify the virtualizer by its public method.
                    typeof value?.getVirtualItems !== "function" ||
                    !Array.isArray(value.measurementsCache)
                  )
                    continue;
                  performance.mark("layout:observed");
                  if (geometry && geometry !== value.measurementsCache)
                    performance.mark("layout:rebuild");
                  geometry = value.measurementsCache;
                }
              }
            }
            if (!fiber.alternate || fiber.child !== fiber.alternate.child)
              for (let child = fiber.child; child; child = child.sibling)
                visit(child);
          };
          visit(root.current);
        },
        onCommitFiberUnmount() {},
      },
    });
  });
  const entries = Array.from({ length: 200 }, (_, i) => ({
    id: `entry-${i}`,
    parentId: "the-day",
    prevSiblingId: i ? `entry-${i - 1}` : "standup",
    text: `Entry ${i}`,
  }));
  await seedOutline(page, [...TREE, ...entries], { kv: KV });
  await openSeededOutline(page, { path: "/the-day" });
  await expect(section(page, DAY, "title")).toBeVisible();

  const marks = () =>
    page.evaluate(() =>
      performance
        .getEntriesByType("mark")
        .map((entry) => entry.name)
        .filter((name) => /^(render:|layout:)/.test(name)),
    );
  const settle = async () => {
    let previous = -1;
    let equal = 0;
    await expect
      .poll(
        async () => {
          const count = (await marks()).length;
          equal = count === previous ? equal + 1 : 0;
          previous = count;
          return equal;
        },
        { intervals: [100] },
      )
      .toBeGreaterThanOrEqual(3);
  };
  // A visible outline can still be adopting and positioning the day stream.
  // Seat the caret only after that startup work, outside the measured edit.
  await settle();
  await placeCaret(text(page, "standup"), "end");
  await settle();
  await expect(text(page, "standup")).toBeFocused();
  await page.evaluate(() => performance.clearMarks());
  await page.keyboard.type("abcdefghij");
  await expect(text(page, "standup")).toHaveText("Standupabcdefghij");
  await settle();
  const typing = await marks();
  expect(typing).toContain("render:NormalRow:standup");
  expect(
    typing.filter(
      (name) =>
        name.startsWith("render:NormalRow:") &&
        name !== "render:NormalRow:standup",
    ),
  ).toEqual([]);
  expect(typing).not.toContain("render:OutlineEditor:");

  // Stay in an already measured window: no newly mounted rows or edge loads
  // can legitimately invalidate layout. The shell must render, its content not.
  await page.evaluate(() => {
    performance.clearMarks();
    window.scrollBy(0, 8);
  });
  await settle();
  const scrolling = await marks();
  expect(scrolling).toContain("render:OutlineEditor:");
  expect(scrolling).toContain("layout:observed");
  expect(scrolling).not.toContain("layout:rebuild");
  expect(
    scrolling.filter((name) =>
      /^render:Stream(SectionTitle|PlaceholderTitle|EntryLine):/.test(name),
    ),
  ).toEqual([]);

  // A real geometry change must still update empty-day page heights, including
  // a small resize that does not change the virtualizer's rendered range.
  await pill(page, NEXT).click();
  const following = section(page, "2030-06-14", "placeholder");
  const gap = () =>
    page.evaluate(() => {
      const first = document.querySelector<HTMLElement>(
        '[data-stream-item="placeholder"][data-section="2030-06-13"]',
      )!;
      const second = document.querySelector<HTMLElement>(
        '[data-stream-item="placeholder"][data-section="2030-06-14"]',
      )!;
      return (
        second.getBoundingClientRect().top - first.getBoundingClientRect().top
      );
    });
  await expect(section(page, NEXT, "placeholder")).toBeInViewport();
  await expect(following).toBeAttached();
  await settle();
  const before = await gap();
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ ...viewport, height: viewport.height + 24 });
  await expect.poll(gap).toBe(before + 24);
  await page.setViewportSize(viewport);
  await expect.poll(gap).toBe(before);
});
