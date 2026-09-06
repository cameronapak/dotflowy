/**
 * Singleton LunoraClient for the ADR 0058 flag-swap path.
 * Same-origin `/_lunora/*` (Vite proxies to wrangler in `bun run dev`).
 * SPA/no-SSR: never construct during prerender.
 */

import { LunoraClient } from "lunorash/client";

import { hasWindow } from "../env";

let client: LunoraClient | null = null;

/** Lazily create the client once in the browser. */
export function getLunoraClient(): LunoraClient {
  if (!hasWindow()) {
    throw new Error("getLunoraClient: browser only (SPA/no-SSR)");
  }
  if (!client) {
    // SAFETY: Vite defines import.meta.env values as strings when present; undefined falls back to the page origin.
    const url =
      (import.meta.env.VITE_LUNORA_URL as string | undefined) ??
      window.location.origin;
    client = new LunoraClient({ url });
  }
  return client;
}
