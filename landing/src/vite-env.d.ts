/// <reference types="vite/client" />

/** Newest-first release array, compiled from `changelog/**` at build time
 *  (ADR 0046). Shape matches the app's `Release` — landing keeps a local
 *  mirror so it never imports Effect. */
declare module "virtual:dotflowy-changelog" {
  export type Bump = "major" | "minor" | "patch";
  export type ChangelogEntry = { bump: Bump; summary: string };
  export type Release = {
    version: string;
    date: string;
    entries: readonly ChangelogEntry[];
  };
  export const releases: readonly Release[];
}

declare module "@dotflowy/changelog-markdown" {
  export type InlineSegment =
    | { kind: "text"; value: string }
    | { kind: "code"; value: string }
    | { kind: "strong"; value: string };
  export function parseInlineMarkdown(summary: string): InlineSegment[];
}

interface ImportMetaEnv {
  /** Origin of the app the hero's live demo frames. Defaults to production. */
  readonly VITE_DEMO_APP_URL?: string;
}
