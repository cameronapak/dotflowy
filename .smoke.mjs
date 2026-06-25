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
  // 1) Root should redirect to /login when unauthenticated.
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  log("after / load, url =", page.url());

  // 2) Sign up.
  await page.goto(BASE + "/signup", { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL).catch(() => {});
  await page.fill('input[type="password"]', PASS).catch(() => {});
  await page.screenshot({ path: "/tmp/shot-signup.png" });
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1500);
  log("after signup submit, url =", page.url());

  // 3) Log in (signup doesn't auto-login in Wasp email auth).
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL).catch(() => {});
  await page.fill('input[type="password"]', PASS).catch(() => {});
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  log("after login submit, url =", page.url());

  // 4) Editor should render the seeded welcome bullets.
  await page.waitForSelector(".node-text", { timeout: 8000 }).catch(() => {});
  const bullets = await page.$$eval(".node-text", (els) =>
    els.map((e) => e.textContent),
  );
  log("bullet count =", bullets.length);
  log("bullets =", JSON.stringify(bullets));
  await page.screenshot({ path: "/tmp/shot-editor.png", fullPage: true });

  // 5) Type into the first bullet, then reload to prove it synced to Postgres.
  if (bullets.length > 0) {
    const first = page.locator(".node-text").first();
    await first.click();
    await page.keyboard.type(" EDITED");
    await page.waitForTimeout(1500); // let the debounced upsert flush
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".node-text", { timeout: 8000 }).catch(() => {});
    const after = await page.$$eval(".node-text", (els) =>
      els.map((e) => e.textContent),
    );
    log("after reload bullets =", JSON.stringify(after));
    log("persisted EDITED =", after.some((t) => (t || "").includes("EDITED")));
    await page.screenshot({ path: "/tmp/shot-after-reload.png", fullPage: true });
  }

  log("console errors:", errors.length ? JSON.stringify(errors, null, 2) : "none");
} catch (e) {
  log("SCRIPT ERROR:", e.message);
  await page.screenshot({ path: "/tmp/shot-error.png" }).catch(() => {});
  log("console errors so far:", JSON.stringify(errors, null, 2));
} finally {
  await browser.close();
}
