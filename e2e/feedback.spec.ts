import { expect, test, type Page } from "@playwright/test";

import type {
  FeedbackAdminAction,
  FeedbackInbox,
} from "../src/data/feedback-admin";

import { openSeededOutline, seedOutline, STANDARD_TREE } from "./fixtures";

test("admin triage preserves failed and neighboring drafts, confirms private notes, and completes or reopens reports", async ({
  page,
}) => {
  await seedOutline(page, STANDARD_TREE);
  const reports: Array<FeedbackInbox["submissions"][number]> = [
    {
      id: 41,
      requestId: "report-reference-one",
      userId: "reporter-one",
      email: "reporter@example.test",
      emailVerified: true,
      replies: [],
      plan: "founding",
      kind: "idea",
      message: "Support a daily review shortcut.",
      appVersion: "3.2.0",
      browser: null,
      routeCategory: null,
      createdAt: 1790000000000,
      completedAt: null,
      comments: [],
    },
    {
      id: 42,
      requestId: "report-reference-two",
      userId: "reporter-two",
      email: "unverified@example.test",
      emailVerified: false,
      replies: [],
      plan: "free",
      kind: "bug",
      message: "The menu closes unexpectedly.",
      appVersion: "3.2.0",
      browser: null,
      routeCategory: null,
      createdAt: 1789999999000,
      completedAt: null,
      comments: [],
    },
  ];
  const sent: FeedbackAdminAction[] = [];
  let failComment = true;
  let failComplete = true;
  let failReplyResponse = true;
  await page.route("**/api/admin/feedback**", async (route) => {
    if (route.request().method() === "GET") {
      const status = new URL(route.request().url()).searchParams.get("status");
      return route.fulfill({
        json: {
          replyMode: "send",
          submissions: reports.filter(
            (report) =>
              !status ||
              (status === "open"
                ? report.completedAt === null
                : report.completedAt !== null),
          ),
        },
      });
    }
    const action: FeedbackAdminAction = route.request().postDataJSON();
    sent.push(action);
    const reportIndex = reports.findIndex((item) => item.id === action.id);
    let report = reports[reportIndex]!;
    if (action.action === "reply") {
      if (!report.replies.some((reply) => reply.id === action.replyId)) {
        report = {
          ...report,
          replies: [
            ...report.replies,
            {
              id: action.replyId,
              recipientEmail: action.recipientEmail,
              message: action.message,
              createdAt: 1790000003000,
              status: "accepted",
            },
          ],
        };
        reports[reportIndex] = report;
      }
      if (failReplyResponse) {
        failReplyResponse = false;
        return route.fulfill({
          status: 503,
          json: { error: "PRIVATE_SERVER_ERROR" },
        });
      }
    } else if (action.action === "comment") {
      if (!report.comments.some((comment) => comment.id === action.commentId)) {
        report = {
          ...report,
          comments: [
            ...report.comments,
            {
              id: action.commentId,
              message: action.message,
              createdAt: 1790000001000,
            },
          ],
        };
        reports[reportIndex] = report;
      }
      if (failComment) {
        failComment = false;
        return route.fulfill({
          status: 503,
          json: { error: "PRIVATE_SERVER_ERROR" },
        });
      }
    } else {
      if (failComplete) {
        failComplete = false;
        return route.fulfill({
          status: 503,
          json: { error: "PRIVATE_SERVER_ERROR" },
        });
      }
      report = {
        ...report,
        completedAt: action.action === "complete" ? 1790000002000 : null,
      };
      reports[reportIndex] = report;
    }
    return route.fulfill({ json: report });
  });
  await page.goto("/admin/feedback");
  const first = page
    .getByTestId("feedback-report")
    .filter({ hasText: "Support a daily review shortcut." });
  const second = page
    .getByTestId("feedback-report")
    .filter({ hasText: "The menu closes unexpectedly." });
  // A direct inbox visit also cold-loads the authenticated application shell.
  await first.waitFor({ state: "visible" });
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("open");
  await expect(first).toContainText("Not sent to the reporter.");
  await second.getByRole("textbox").fill("Keep this separate draft.");
  await first
    .getByRole("textbox")
    .fill("Reproduced. Check keyboard focus before replying.");
  await expect(
    first.getByRole("button", { name: "Mark complete" }),
  ).toBeDisabled();
  await first.getByRole("button", { name: "Save internal comment" }).click();
  await expect(first.getByRole("alert")).toBeVisible();
  await expect(first.getByRole("textbox")).toHaveValue(
    "Reproduced. Check keyboard focus before replying.",
  );
  await expect(first).not.toContainText("PRIVATE_SERVER_ERROR");
  await first.getByRole("button", { name: "Save internal comment" }).click();
  await expect(first.getByRole("textbox")).toHaveValue("");
  await expect(
    first.getByText("Reproduced. Check keyboard focus before replying.", {
      exact: true,
    }),
  ).toHaveCount(1);
  expect(sent[0]).toEqual(sent[1]);
  await expect(second.getByRole("textbox")).toHaveValue(
    "Keep this separate draft.",
  );
  await expect(
    first.getByRole("link", { name: "reporter@example.test", exact: true }),
  ).toHaveAttribute("href", "mailto:reporter%40example.test");
  await expect(
    second.getByRole("button", { name: "Email reporter" }),
  ).toBeDisabled();
  await first.getByRole("button", { name: "Email reporter" }).click();
  await first
    .getByLabel("Your email to the reporter")
    .fill("Hi, the shortcut is available now. Thanks for the idea!");
  await expect(
    first.getByRole("button", { name: "Mark complete" }),
  ).toBeDisabled();
  await first.getByRole("button", { name: "Review email" }).click();
  await expect(first.getByTestId("reply-review")).toHaveText(
    "Hi, the shortcut is available now. Thanks for the idea!\n\nCam\nDotflowy\n\nFeedback reference: report-reference-one",
  );
  expect(sent.filter((action) => action.action === "reply")).toHaveLength(0);
  await first.getByRole("button", { name: "Edit email" }).click();
  await expect(first.getByLabel("Your email to the reporter")).toHaveValue(
    "Hi, the shortcut is available now. Thanks for the idea!",
  );
  await first.getByRole("button", { name: "Review email" }).click();
  await first.getByRole("button", { name: "Send email", exact: true }).click();
  await expect(first.getByRole("alert")).toContainText("Couldn't confirm");
  await expect(first).not.toContainText("PRIVATE_SERVER_ERROR");
  await expect(first.getByRole("button", { name: "Edit email" })).toHaveCount(
    0,
  );
  await first.getByRole("button", { name: "Check send status" }).click();
  await expect(
    first.getByRole("region", { name: "Emails to reporter" }),
  ).toContainText("not delivery");
  const replyAttempts = sent.filter((action) => action.action === "reply");
  expect(replyAttempts).toHaveLength(2);
  expect(replyAttempts[0]).toEqual(replyAttempts[1]);
  expect(reports[0]!.replies).toHaveLength(1);
  await expect(second.getByRole("textbox")).toHaveValue(
    "Keep this separate draft.",
  );
  await first.getByRole("button", { name: "Close", exact: true }).click();
  await first.getByRole("button", { name: "Mark complete" }).click();
  await expect(first.getByRole("alert")).toBeVisible();
  await expect(
    first.getByRole("button", { name: "Mark complete" }),
  ).toBeVisible();
  await first.getByRole("button", { name: "Mark complete" }).click();
  await expect(first).toHaveCount(0);
  await expect(second.getByRole("textbox")).toHaveValue(
    "Keep this separate draft.",
  );
  await page.getByLabel("Status", { exact: true }).selectOption("complete");
  await expect(
    first.getByRole("button", { name: "Reopen", exact: true }),
  ).toBeVisible();
  await expect(second).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    first.getByText("Reproduced. Check keyboard focus before replying.", {
      exact: true,
    }),
  ).toBeVisible();
  await first.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(first).toHaveCount(0);
  await expect(page.getByText("No reports match these filters.")).toBeVisible();
  await page.getByLabel("Status", { exact: true }).selectOption("open");
  await expect(
    first.getByRole("button", { name: "Mark complete" }),
  ).toBeVisible();
  await expect(
    first.getByText("Reproduced. Check keyboard focus before replying.", {
      exact: true,
    }),
  ).toBeVisible();
});

async function openFeedback(page: Page) {
  const mobile = (page.viewportSize()?.width ?? 1280) < 768;
  await page
    .getByRole("button", {
      name: mobile ? "More" : /Account and help/,
      exact: mobile,
    })
    .click();
  await page
    .getByRole("menuitem", { name: /^(Send feedback|Report a bug)$/ })
    .click();
  return page.getByRole("dialog", {
    name: /^(Send feedback|Review feedback)$/,
  });
}

async function mount(page: Page) {
  await openSeededOutline(page, {
    path: "/?node=PRIVATE_NODE&query=PRIVATE_QUERY",
    anchorId: "alpha",
  });
  return openFeedback(page);
}

test("member feedback reviews only opted-in context, keeps its id and draft on error, and confirms success", async ({
  page,
}) => {
  await seedOutline(page, STANDARD_TREE);
  await page.route("**/api/membership", (route) =>
    route.fulfill({
      json: {
        plan: "founding",
        subs: [],
        legacyLeaf: false,
        welcome: null,
      },
    }),
  );
  const sent: Array<{
    id: string;
    kind: string;
    message: string;
    context: Record<string, string>;
  }> = [];
  await page.route("**/api/feedback", (route) => {
    expect(route.request().headers()["referer"]).toBeUndefined();
    sent.push(route.request().postDataJSON());
    return route.fulfill(
      sent.length === 1
        ? {
            status: 503,
            json: { error: "unavailable", message: "PRIVATE_SERVER_ERROR" },
          }
        : { status: 201, json: { id: sent.at(-1)?.id, replayed: false } },
    );
  });
  const dialog = await mount(page);
  await expect(
    dialog.getByRole("button", { name: "Question", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Idea", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Idea", exact: true, pressed: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Bug", exact: true, pressed: false }),
  ).toBeVisible();
  await dialog
    .getByLabel("Your feedback", { exact: true })
    .fill("A keyboard shortcut for my daily review would help.");
  const details = dialog.getByRole("button", { name: /Technical details/ });
  const browser = dialog.getByRole("checkbox", {
    name: "Include browser information",
  });
  const routeCategory = dialog.getByRole("checkbox", {
    name: /Include route category/,
  });
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(browser).toHaveCount(0);
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(browser).toBeFocused();
  await page.keyboard.press("Space");
  await routeCategory.check();
  await details.focus();
  await page.keyboard.press("Space");
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(browser).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }).first(),
  ).toBeFocused();
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(browser).toBeChecked();
  await expect(routeCategory).toBeChecked();
  await dialog.getByRole("button", { name: "Review feedback" }).click();
  await expect(dialog.getByTestId("feedback-review")).toHaveText(
    "A keyboard shortcut for my daily review would help.",
  );
  await expect(
    dialog.getByText("Page: outline", { exact: true }),
  ).toBeVisible();
  await expect(dialog).not.toContainText("PRIVATE_");
  expect(sent).toHaveLength(0);
  await dialog
    .getByRole("button", { name: "Send feedback", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  const reviewed = sent[0]!;
  expect(reviewed.kind).toBe("idea");
  expect(reviewed.context.routeCategory).toBe("outline");
  expect(reviewed.context.browser).toBeTruthy();
  expect(JSON.stringify(reviewed)).not.toContain("PRIVATE_");
  await expect(dialog).not.toContainText("PRIVATE_SERVER_ERROR");
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(dialog.getByLabel("Your feedback", { exact: true })).toHaveValue(
    reviewed.message,
  );
  await dialog.getByRole("button", { name: "Review feedback" }).click();
  await expect(dialog.getByTestId("feedback-review")).toHaveText(
    reviewed.message,
  );
  await dialog
    .getByRole("button", { name: "Send feedback", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("private inbox");
  await expect(dialog).toContainText(`Reference: ${reviewed.id}`);
  expect(sent).toEqual([reviewed, reviewed]);
  await dialog.getByRole("button", { name: "Done" }).click();
  await openFeedback(page);
  await expect(dialog.getByRole("textbox")).toHaveValue("");
  await dialog.getByRole("button", { name: /Technical details/ }).click();
  await expect(
    dialog.getByRole("checkbox", { name: "Include browser information" }),
  ).not.toBeChecked();
});

test("narrow-screen bug reports work without membership; Free ideas only link to a public draft", async ({
  page,
}) => {
  await seedOutline(page, STANDARD_TREE);
  await page.setViewportSize({ width: 390, height: 844 });
  let membershipReady = false;
  let finishMembership: (() => void) | undefined;
  const pendingMembership = new Promise<void>((resolve) => {
    finishMembership = resolve;
  });
  await page.route("**/api/membership", async (route) => {
    if (!membershipReady) {
      await pendingMembership;
      return route.fulfill({ status: 503, json: { error: "unavailable" } });
    }
    return route.fulfill({
      json: { plan: "free", subs: [], legacyLeaf: false, welcome: null },
    });
  });
  const sent: Array<{ id: string; context: Record<string, string> }> = [];
  let finishSending: (() => void) | undefined;
  await page.route("**/api/feedback", async (route) => {
    sent.push(route.request().postDataJSON());
    await new Promise<void>((resolve) => {
      finishSending = resolve;
    });
    await route.fulfill({
      status: 201,
      json: { id: sent.at(-1)?.id, replayed: false },
    });
  });
  const dialog = await mount(page);
  await expect(dialog.getByRole("status")).toContainText("Checking membership");
  await dialog.getByRole("textbox").fill("The menu won't open on my phone.");
  await dialog.getByRole("button", { name: "Review feedback" }).click();
  await expect(dialog.getByTestId("feedback-review")).toHaveText(
    "The menu won't open on my phone.",
  );
  await dialog
    .getByRole("button", { name: "Send feedback", exact: true })
    .click();
  await expect(dialog.getByRole("button", { name: "Sending…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect.poll(() => sent.length).toBe(1);
  expect(Object.keys(sent[0]!.context)).toEqual(["appVersion"]);
  if (!finishSending) throw new Error("Expected pending feedback request");
  finishSending();
  await expect(dialog.getByRole("status")).toContainText("private inbox");
  if (!finishMembership) throw new Error("Expected pending membership request");
  finishMembership();
  await dialog.getByRole("button", { name: "Done" }).click();
  await openFeedback(page);
  await expect(
    dialog.getByRole("button", { name: "Retry membership" }),
  ).toBeVisible();
  membershipReady = true;
  await dialog.getByRole("button", { name: "Retry membership" }).click();
  await expect(
    dialog.getByRole("button", { name: "Retry membership" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Idea", exact: true }).click();
  await expect(
    dialog.getByRole("link", { name: "draft a public idea on GitHub" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/cameronapak/dotflowy/issues/new?labels=enhancement",
  );
  await expect(
    dialog.getByRole("button", { name: "Review feedback" }),
  ).toBeDisabled();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  expect(sent).toHaveLength(1);
  await dialog.getByRole("button", { name: "Bug", exact: true }).click();
  await dialog.getByRole("textbox").fill("Keep this draft while I view plans.");
  await dialog.getByRole("link", { name: "Subscribe to Dotflowy" }).click();
  await expect(page).toHaveURL(/\/settings#billing$/);
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Back to outline" }).click();
  await openFeedback(page);
  await expect(dialog.getByRole("textbox")).toHaveValue(
    "Keep this draft while I view plans.",
  );
  expect(sent).toHaveLength(1);
});
