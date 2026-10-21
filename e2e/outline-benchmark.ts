// Run against a production build, with synthetic data and the existing wire
// fixture. CDP task time is main-thread CPU, not input-to-paint latency.
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

import {
  seedOutline,
  placeCaret,
  text,
  type ApiNode,
  type SeedNode,
} from "./fixtures";

const url = process.env.BENCH_URL ?? "http://localhost:8787";
const out = process.env.BENCH_OUT ?? "/tmp/dotflowy-benchmark";
const label = process.env.LABEL ?? "current";
const repeats = Number(process.env.REPEATS ?? 3);
const sizes = (process.env.SIZES ?? "10000,100000").split(",").map(Number);
const topologies = (process.env.TOPOLOGIES ?? "mixed,wide").split(",");
const seedUpdatedAt = Number(process.env.SEED_UPDATED_AT ?? 0);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
});
const results: object[] = [];
try {
  for (const count of sizes)
    for (const topology of topologies)
      for (let run = 0; run < repeats; run++) {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        page.setDefaultTimeout(120_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const nodes: SeedNode[] = Array.from({ length: count }, (_, i) => {
          const root = topology === "wide" ? 0 : Math.floor(i / 101) * 101;
          return {
            id: `n${i}`,
            parentId: i === root ? null : `n${root}`,
            prevSiblingId:
              i === root
                ? root
                  ? `n${root - 101}`
                  : null
                : i === root + 1
                  ? null
                  : `n${i - 1}`,
            text:
              i % 19 === 0
                ? `Project ${i} #work [link](https://example.com)`
                : `Entry ${i}`,
            updatedAt: seedUpdatedAt,
          };
        });
        await seedOutline(page, nodes);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable");
        const metrics = async () =>
          Object.fromEntries(
            (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
              m.name,
              m.value,
            ]),
          );
        const frame = () =>
          page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
        const saved = (): Promise<ApiNode[]> =>
          page.evaluate(async () => (await fetch("/api/nodes")).json());
        async function measure<ActionResult, CheckResult>(
          action: string,
          invoke: () => Promise<ActionResult>,
          check: () => Promise<CheckResult>,
        ) {
          const profile =
            process.env.PROFILE_ACTION?.split(",").includes(action) &&
            run === 0;
          if (profile) {
            await cdp.send("Profiler.enable");
            await cdp.send("Profiler.start");
          }
          const before = await metrics();
          const start = performance.now();
          await invoke();
          await check();
          await frame();
          const after = await metrics();
          if (profile) {
            const { profile: data } = await cdp.send("Profiler.stop");
            await writeFile(
              `${out}/${label}-${count}-${topology}-${action}.cpuprofile`,
              JSON.stringify(data),
            );
          }
          const result = {
            label,
            count,
            topology,
            run,
            action,
            wallMs: performance.now() - start,
            taskMs: (after.TaskDuration! - before.TaskDuration!) * 1000,
            layoutMs: (after.LayoutDuration! - before.LayoutDuration!) * 1000,
            heapMB: after.JSHeapUsedSize! / 1e6,
            mounted: await page.locator("li[data-node-id]").count(),
          };
          results.push(result);
          console.log(JSON.stringify(result));
          await page.waitForLoadState("networkidle");
          await frame();
        }
        await measure(
          "load",
          () => page.goto(url),
          () => text(page, "n2").waitFor(),
        );
        await placeCaret(text(page, "n2"), "end");
        await measure(
          "type-20",
          () => page.keyboard.type("abcdefghijklmnopqrst"),
          () =>
            expect(text(page, "n2")).toHaveText("Entry 2abcdefghijklmnopqrst"),
        );
        if (process.env.TYPING_ONLY === "true") {
          expect(errors).toEqual([]);
          await context.close();
          continue;
        }
        await placeCaret(text(page, "n3"), "end");
        await measure(
          "reorder",
          () => page.keyboard.press("Control+Shift+ArrowDown"),
          () =>
            page.waitForFunction(
              () =>
                Number(
                  document
                    .querySelector('[data-node-id="n3"]')
                    ?.getAttribute("data-index"),
                ) >
                Number(
                  document
                    .querySelector('[data-node-id="n4"]')
                    ?.getAttribute("data-index"),
                ),
            ),
        );
        const bullet = await page
          .locator('li[data-node-id="n6"] .bullet')
          .boundingBox();
        const target = await page
          .locator('li[data-node-id="n9"]')
          .boundingBox();
        if (!bullet || !target) throw new Error("Missing drag targets");
        await page.mouse.move(
          bullet.x + bullet.width / 2,
          bullet.y + bullet.height / 2,
        );
        await page.mouse.down();
        await measure(
          "drag",
          async () => {
            await page.mouse.move(
              bullet.x + bullet.width / 2 + 10,
              bullet.y + 10,
              { steps: 3 },
            );
            await page.mouse.move(bullet.x + bullet.width / 2, target.y, {
              steps: 5,
            });
            await page.mouse.up();
          },
          () =>
            page.waitForFunction(
              () =>
                Number(
                  document
                    .querySelector('[data-node-id="n6"]')
                    ?.getAttribute("data-index"),
                ) >
                Number(
                  document
                    .querySelector('[data-node-id="n8"]')
                    ?.getAttribute("data-index"),
                ),
            ),
        );
        await page.keyboard.press("Control+f");
        const filter = page.getByRole("combobox", { name: "Filter query" });
        await measure(
          "filter",
          () => filter.fill("Entry 2"),
          () => page.waitForURL(/q=/),
        );
        await placeCaret(text(page, "n2"), "end");
        await measure(
          "filtered-type",
          () => page.keyboard.type("xyz"),
          () =>
            expect(text(page, "n2")).toHaveText(
              "Entry 2abcdefghijklmnopqrstxyz",
            ),
        );
        await filter.fill("");
        await page.waitForURL(url + "/");
        await page.keyboard.press("Escape");
        await placeCaret(text(page, "n2"), "end");
        const beforePaste = await saved();
        await measure(
          "paste-100",
          () =>
            text(page, "n2").evaluate((el) => {
              const data = new DataTransfer();
              data.setData(
                "text/plain",
                Array.from({ length: 100 }, (_, i) => `Pasted entry ${i}`).join(
                  "\n",
                ),
              );
              el.dispatchEvent(
                new ClipboardEvent("paste", {
                  clipboardData: data,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            }),
          () =>
            page.waitForFunction(
              () => document.activeElement?.textContent === "Pasted entry 99",
            ),
        );
        const pasted = await saved();
        expect(pasted.length).toBe(count + 99);
        const authoring = (rows: ApiNode[]) =>
          rows
            .map((node) => ({ ...node, updatedAt: 0 }))
            .sort((a, b) => a.id.localeCompare(b.id));
        await measure(
          "undo-paste",
          () => page.keyboard.press("Control+z"),
          () =>
            expect(text(page, "n2")).toHaveText(
              "Entry 2abcdefghijklmnopqrstxyz",
            ),
        );
        expect(authoring(await saved())).toEqual(authoring(beforePaste));
        await page.keyboard.press("ControlOrMeta+k");
        await page.getByPlaceholder("Search nodes and actions...").fill("redo");
        await measure(
          "redo-paste",
          () => page.getByRole("option", { name: /^Redo/ }).click(),
          () =>
            page.waitForFunction(() =>
              [...document.querySelectorAll(".node-text")].some(
                (el) => el.textContent === "Pasted entry 99",
              ),
            ),
        );
        expect(authoring(await saved())).toEqual(authoring(pasted));
        expect(errors).toEqual([]);
        await context.close();
      }
} finally {
  await writeFile(
    `${out}/${label}.json`,
    JSON.stringify(
      { browser: browser.version(), repeats, seedUpdatedAt, results },
      null,
      2,
    ),
  );
  await browser.close();
}
