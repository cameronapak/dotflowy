import { expect, test } from "@playwright/test";
import { appendFileSync } from "node:fs";

import { seedOutline } from "./fixtures";

test.use({
  browserName: "webkit",
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

// Chromium still clicks when touch pointerdown is canceled; WebKit does not.
test("a touch selects a suggestion without moving editor focus", async ({
  page,
}) => {
  await seedOutline(page, [
    { id: "tagged", parentId: null, prevSiblingId: null, text: "Ship #urgent" },
    { id: "edit", parentId: null, prevSiblingId: "tagged", text: "" },
  ]);
  const log: string[] = [];
  page.on("console", (message) => {
    if (message.text().startsWith("[df-")) log.push(message.text());
  });
  await page.goto("/");
  const editor = page.locator('[data-node-id="edit"] .node-text');
  const suggestions = page.locator(".typing-suggestions");
  await editor.tap();
  await page.keyboard.type("Keep #urg");
  await page.waitForTimeout(300);
  const typed = await editor.textContent();
  appendFileSync("diag.log", `DIAG typed=${JSON.stringify(typed)}\n`);
  const notable = log.some((line) => !line.startsWith("[df-input]"));
  if (typed !== "Keep #urg" || notable) {
    appendFileSync("diag.log", `DIAGLOG\n${log.join("\n")}\n`);
  }
  expect(typed).toBe("Keep #urg");
  await expect(suggestions).toHaveCSS("opacity", "1");
  await page.getByRole("option", { name: /urgent/ }).tap();
  await expect(editor).toContainText("Keep #urgent");
  await expect(editor).toBeFocused();
  await expect(suggestions).toHaveCount(0);
});
