import { chromium } from "@playwright/test";

const BASE = "http://localhost:3000";
const EMAIL = "smoke@dotflowy.test";
const PASS = "password1234";
const log = (...a) => console.log("[smoke]", ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

try {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  log("after / load, url =", page.url());
  if (!page.url().includes("/login")) {
    throw new Error(`Expected unauthenticated redirect to /login, got ${page.url()}`);
  }

  await page.goto(BASE + "/signup", { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.screenshot({ path: "/tmp/shot-signup.png" });
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);
  log("after signup submit, url =", page.url());

  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  log("after login submit, url =", page.url());
  if (page.url().includes("/login")) {
    throw new Error("Login did not leave /login");
  }

  await page.waitForSelector(".node-text", { timeout: 8000 });
  const bullets = await page.$$eval(".node-text", (els) =>
    els.map((e) => e.textContent),
  );
  log("bullet count =", bullets.length);
  log("bullets =", JSON.stringify(bullets));
  await page.screenshot({ path: "/tmp/shot-editor.png", fullPage: true });

  if (bullets.length > 0) {
    const first = page.locator(".node-text").first();
    await first.click();
    await page.keyboard.type(" EDITED");
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".node-text", { timeout: 8000 });
    const after = await page.$$eval(".node-text", (els) =>
      els.map((e) => e.textContent),
    );
    log("after reload bullets =", JSON.stringify(after));
    if (!after.some((t) => (t || "").includes("EDITED"))) {
      throw new Error("Edited text did not persist after reload");
    }
    await page.screenshot({ path: "/tmp/shot-after-reload.png", fullPage: true });
  }

  if (errors.length) {
    throw new Error(`Console/page errors detected: ${JSON.stringify(errors)}`);
  }
  log("console errors: none");
} catch (e) {
  log("SCRIPT ERROR:", e.message);
  await page.screenshot({ path: "/tmp/shot-error.png" }).catch(() => {});
  log("console errors so far:", JSON.stringify(errors, null, 2));
  process.exitCode = 1;
  throw e;
} finally {
  await browser.close();
}
