/**
 * "Report feedback / a bug" -> a pre-filled GitHub issue.
 *
 * GitHub's new-issue page accepts `title`, `body`, and `labels` query params, so
 * we can hand the user a form that's already scaffolded: a short prompt template
 * plus an auto-collected environment footer (current page, browser, screen, date)
 * so a bug report arrives with the context that makes it reproducible. The user
 * still reviews and submits on GitHub -- we only open the pre-filled draft.
 *
 * The URL build is split from the browser side effect so it stays pure and
 * unit-testable: `buildFeedbackUrl` takes an explicit `FeedbackEnv`,
 * `openFeedbackReport` gathers the real environment and opens the tab.
 */

const ISSUES_NEW_URL = "https://github.com/cameronapak/dotflowy/issues/new";

export type FeedbackEnv = {
  /** The page the user is on when they hit "report" (`window.location.href`). */
  url: string;
  /** `navigator.userAgent`. */
  userAgent: string;
  /** Viewport size, e.g. "1440x900". */
  viewport: string;
  /** ISO timestamp of when the report was opened. */
  when: string;
};

function bodyTemplate(env: FeedbackEnv): string {
  return [
    "**What happened?**",
    "",
    "",
    "**What did you expect to happen?**",
    "",
    "",
    "**Steps to reproduce**",
    "1. ",
    "",
    "---",
    "<!-- Auto-filled to help debugging. Edit or remove anything you like. -->",
    `- Page: ${env.url}`,
    `- Browser: ${env.userAgent}`,
    `- Screen: ${env.viewport}`,
    `- When: ${env.when}`,
  ].join("\n");
}

/**
 * Build the pre-filled GitHub new-issue URL. Pure -- no DOM, no `window`.
 * Defaults to the `bug` label (the repo's canonical triage label); pass a
 * different one for a plain feedback/idea report.
 */
export function buildFeedbackUrl(
  env: FeedbackEnv,
  opts: { title?: string; label?: string } = {},
): string {
  const params = new URLSearchParams({
    title: opts.title ?? "",
    body: bodyTemplate(env),
    labels: opts.label ?? "bug",
  });
  return `${ISSUES_NEW_URL}?${params.toString()}`;
}

/**
 * Collect the current environment and open the pre-filled GitHub issue draft in
 * a new tab. The shared entry point for the header More menu + the Cmd+K action.
 */
export function openFeedbackReport(): void {
  const env: FeedbackEnv = {
    url: window.location.href,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    when: new Date().toISOString(),
  };
  window.open(buildFeedbackUrl(env), "_blank", "noopener,noreferrer");
}
