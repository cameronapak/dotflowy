import { test as setup, expect } from "@playwright/test";

const authFile = "e2e/.auth/user.json";
const email = "e2e@dotflowy.test";
const password = "password1234";

/** One shared session for the suite — editor routes require auth (PRD Phase 2.5). */
setup("authenticate", async ({ page }) => {
  await page.goto("/signup");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');

  await page.goto("/login");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');

  await expect(page).not.toHaveURL(/\/login$/);
  await page.context().storageState({ path: authFile });
});
