import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

for (const signupOpen of [true, false]) {
  test(`Google entry points preserve ${signupOpen ? "open" : "invite-only"} signup and the MCP return path`, async ({
    page,
  }, info) => {
    await page.route("**/api/auth/get-session", (route) =>
      route.fulfill({ json: null }),
    );
    await page.route("**/api/auth-config", (route) =>
      route.fulfill({ json: { signupOpen, turnstileSiteKey: null } }),
    );
    // The provider boundary is fixture-owned. This test checks only the SPA's
    // navigation contract; auth-real.test.ts exercises account/session creation.
    await page.route("**/api/auth/sign-in/social", (route) =>
      route.fulfill({
        json: { url: "https://accounts.google.com/fixture", redirect: true },
      }),
    );
    await page.route("https://accounts.google.com/fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Google provider</h1>",
      }),
    );
    const query = new URLSearchParams({
      client_id: "fixture-client",
      redirect_uri: "https://client.test/callback",
      response_type: "code",
    });
    await page.goto(`/?${query}`);
    const google = page.getByRole("button", { name: "Continue with Google" });
    // Initial lazy app/bootstrap mounting uses the test budget, not an
    // interaction assertion's 5s budget (notably on a cold Vite server).
    await google.waitFor({ state: "visible" });
    await page
      .getByRole("button", {
        name: signupOpen ? "Sign up" : "Have an invite?",
        exact: true,
      })
      .click();
    await expect(
      page.getByPlaceholder("Confirm password", { exact: true }),
    ).toBeVisible();
    if (signupOpen) {
      await expect(google).toBeVisible();
      await expect(page.getByPlaceholder("Invite code")).toHaveCount(0);
    } else {
      await expect(google).toHaveCount(0);
      await expect(page.getByPlaceholder("Invite code")).toBeVisible();
    }
    await page.screenshot({
      path: info.outputPath(`${signupOpen ? "open" : "invite"}-signup.png`),
      fullPage: true,
    });
    if (!signupOpen)
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const sent = page.waitForRequest("**/api/auth/sign-in/social");
    await google.click();
    const body = (await sent).postDataJSON();
    expect(body.provider).toBe("google");
    expect(new URL(body.callbackURL, page.url()).pathname).toBe(
      "/api/auth/mcp/authorize",
    );
    expect(
      new URL(body.callbackURL, page.url()).searchParams.get("client_id"),
    ).toBe("fixture-client");
    await expect(
      page.getByRole("heading", { name: "Google provider" }),
    ).toBeVisible();
  });
}

for (const [error, guidance] of [
  ["signup_disabled", /invite code/],
  ["account_not_linked", /Confirm your email first/],
] as const) {
  test(`Google ${error} explains the next step without dropping the MCP query`, async ({
    page,
  }, info) => {
    await page.route("**/api/auth/get-session", (route) =>
      route.fulfill({ json: null }),
    );
    await page.route("**/api/auth-config", (route) =>
      route.fulfill({ json: { signupOpen: false, turnstileSiteKey: null } }),
    );
    await page.goto(`/?client_id=fixture-client&error=${error}`);
    await expect(page.getByText(guidance)).toBeVisible();
    await expect(page).not.toHaveURL(/error=/);
    expect(new URL(page.url()).searchParams.get("client_id")).toBe(
      "fixture-client",
    );
    await page.screenshot({
      path: info.outputPath(`${error}.png`),
      fullPage: true,
    });
  });
}
