/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DOTFLOWY_CF_DEV: boolean;
}

/** The archived changeset fragments, parsed + Effect-Schema-validated at build
 *  time by `scripts/vite-plugin-changelog.ts`. Newest release first. ADR 0046. */
declare module "virtual:dotflowy-changelog" {
  import type { Release } from "./data/changelog";

  export const releases: readonly Release[];
}
