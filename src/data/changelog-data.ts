/**
 * The app's view of the changelog: the build-time release array, plus the one
 * derived value everything else hangs off (ADR 0046).
 *
 * This module exists to keep the virtual-module import in ONE place. The logic
 * lives in `changelog.ts` (pure, unit-tested); the data is compiled in by
 * `scripts/vite-plugin-changelog.ts`. There is no runtime fetch — a release the
 * bundle doesn't know about is, by definition, a bundle that needs reloading,
 * which is what `app-version.ts` is for.
 */

import { releases } from "virtual:dotflowy-changelog";

export type { Bump, ChangelogEntry, Release } from "./changelog";
export { hasBreaking, unseenCount } from "./changelog";

export { releases };

/** The version this bundle believes is current. `null` only if the archive is
 *  empty, which the build-time invariant makes impossible. */
export const latestVersion: string | null = releases[0]?.version ?? null;

/** Where the public, crawlable, feed-carrying changelog lives (ADR 0046). */
export const RELEASES_URL = "https://github.com/cameronapak/dotflowy/releases";
