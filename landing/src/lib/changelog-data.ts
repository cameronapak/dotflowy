/**
 * Landing's view of the changelog: build-time release array (ADR 0046).
 *
 * Same `changelog/**` archive the in-app dialog compiles in. No unread cursor
 * — this surface is public and anonymous.
 */

import type { Bump } from "virtual:dotflowy-changelog";

import { releases } from "virtual:dotflowy-changelog";

export type { Bump, ChangelogEntry, Release } from "virtual:dotflowy-changelog";
export { releases };

export const latestVersion: string | null = releases[0]?.version ?? null;

/** GitHub Releases — feed + permanent per-version URLs (ADR 0046). */
export const RELEASES_URL = "https://github.com/cameronapak/dotflowy/releases";

/** The reader's axis, straight off the bump type (ADR 0046). */
export const BUMP_LABEL: Record<Bump, string> = {
  major: "Changed",
  minor: "Added",
  patch: "Fixed",
};
