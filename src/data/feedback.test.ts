import { expect, test } from "bun:test";

import { buildFeedbackUrl, type FeedbackEnv } from "./feedback";

const env: FeedbackEnv = {
  url: "https://app.dotflowy.com/abc123",
  userAgent: "Mozilla/5.0 (Macintosh)",
  viewport: "1440x900",
  when: "2026-07-07T12:00:00.000Z",
};

test("by default, opens a bug-labeled new issue with the environment in the body", () => {
  const url = new URL(buildFeedbackUrl(env));
  expect(url.origin + url.pathname).toBe(
    "https://github.com/cameronapak/dotflowy/issues/new",
  );
  expect(url.searchParams.get("labels")).toBe("bug");
  const body = url.searchParams.get("body") ?? "";
  expect(body).toContain("https://app.dotflowy.com/abc123");
  expect(body).toContain("Mozilla/5.0 (Macintosh)");
  expect(body).toContain("1440x900");
  expect(body).toContain("2026-07-07T12:00:00.000Z");
});

test("honors an explicit title and label override", () => {
  const url = new URL(
    buildFeedbackUrl(env, { title: "Sync is stuck", label: "enhancement" }),
  );
  expect(url.searchParams.get("title")).toBe("Sync is stuck");
  expect(url.searchParams.get("labels")).toBe("enhancement");
});
