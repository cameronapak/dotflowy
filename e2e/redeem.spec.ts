import { expect, test } from "@playwright/test";
import { Schema } from "effect";

import { RewardRedemption } from "../src/data/pro-reward";

test("redemption keeps signup and explicit sign-in on the gift page", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: null }),
  );
  await page.route("**/api/auth-config", (route) =>
    route.fulfill({ json: { signupOpen: true, turnstileSiteKey: null } }),
  );
  const sent: string[] = [];
  await page.route("**/api/auth/sign-up/email", (route) => {
    sent.push(
      Schema.decodeUnknownSync(Schema.Struct({ callbackURL: Schema.String }))(
        route.request().postDataJSON(),
      ).callbackURL,
    );
    return route.fulfill({ json: { token: null, user: { id: "recipient" } } });
  });
  await page.route("**/api/auth/sign-in/email", (route) => {
    sent.push(
      Schema.decodeUnknownSync(Schema.Struct({ callbackURL: Schema.String }))(
        route.request().postDataJSON(),
      ).callbackURL,
    );
    return route.fulfill({
      status: 403,
      json: { code: "EMAIL_NOT_VERIFIED", message: "Unverified" },
    });
  });
  await page.goto("/redeem");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page
    .getByPlaceholder("Email", { exact: true })
    .fill("recipient@example.test");
  await page
    .getByPlaceholder("Password", { exact: true })
    .fill("disposable-password");
  await page
    .getByPlaceholder("Confirm password", { exact: true })
    .fill("disposable-password");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(page.getByText(/Account created/)).toBeVisible();
  await expect(page).toHaveURL(/\/redeem$/);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(/fresh confirmation link/)).toBeVisible();
  expect(sent).toEqual(["/redeem", "/redeem"]);
});

test("review does not claim; explicit claim sends the reviewed account and shows only server delivery", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      json: {
        session: {
          id: "session",
          userId: "recipient",
          token: "fixture",
          expiresAt: "2099-01-01T00:00:00Z",
        },
        user: {
          id: "recipient",
          name: "Recipient",
          email: "recipient@example.test",
          emailVerified: true,
        },
      },
    }),
  );
  await page.route("**/api/membership", (route) =>
    route.fulfill({
      json: {
        plan: "free",
        subs: [],
        legacyLeaf: false,
        welcome: null,
      },
    }),
  );
  const claims: (typeof RewardRedemption.Type)[] = [];
  await page.route("**/api/membership/redeem", (route) => {
    claims.push(
      Schema.decodeUnknownSync(RewardRedemption)(
        route.request().postDataJSON(),
      ),
    );
    return route.fulfill({
      json: {
        reward: {
          id: "reward",
          state: "review",
          message: "Billing needs a check.",
          claimBy: 1800000000000,
          startsAt: null,
          endsAt: null,
        },
      },
    });
  });
  await page.goto("/redeem");
  const input = page.getByRole("textbox", { name: "Pro code" });
  await input.waitFor({ state: "visible" });
  await input.fill("partial");
  await input.press("Enter");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toBeFocused();
  const code = `DF-${"a".repeat(64)}`;
  await input.fill(` ${code} `);
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Review your 30 days" }),
  ).toBeFocused();
  await expect(
    page.getByText("recipient@example.test", { exact: true }),
  ).toBeVisible();
  expect(claims).toHaveLength(0);
  await page
    .getByRole("button", { name: "Claim 30 days of Pro", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your reward needs a check" }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Check same reward" }),
  ).toBeVisible();
  expect(claims).toEqual([{ code, accountId: "recipient", consent: true }]);
  await expect(page).toHaveURL(/\/redeem$/);
});
