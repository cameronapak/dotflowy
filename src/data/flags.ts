/**
 * Runtime feature flags. One concern: a single switch can be flipped at runtime
 * (localStorage) without a rebuild, so e2e can exercise both paths and a
 * dogfooder can roll back instantly. A flag lives here only while its rollback
 * path does -- `virtualized` (ADR 0019) and `mobile-bar` (ADR 0030) were
 * deleted with their fallbacks once dogfooded.
 */

const MIRRORS_KEY = "dotflowy:flag:mirrors";

// Compiled default ON. Mirrors (ADR 0022) shipped to all users; localStorage
// "off" is the escape hatch if a regression turns up.
const MIRRORS_DEFAULT = true;

/**
 * Whether node mirrors (ADR 0022) are active. Read at render time by the visible-
 * order walk (mirror resolution + path keys) and the mirror create/chrome paths.
 * ON by default for all users; localStorage "off" is the rollback escape hatch.
 * SSR/prerender has no window and never renders the live store anyway
 * (SPA/no-SSR rule), so it falls to the default -- the value there is moot.
 */
export function isMirrorsEnabled(): boolean {
  if (typeof window === "undefined") return MIRRORS_DEFAULT;
  try {
    const v = window.localStorage.getItem(MIRRORS_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch {
    // localStorage can throw (private mode / disabled); fall back to the default.
  }
  return MIRRORS_DEFAULT;
}

/** ADR 0055 Phase-2: outline sync via Lunora shapes/mutators instead of custom DO. */
export const LUNORA_SYNC_FLAG_KEY = "dotflowy:flag:lunora-sync";

// Default ON — outline sync rides Lunora (ADR 0055). localStorage `"off"` or
// `?lunora-sync=off` is the rollback escape hatch (classic `/api/sync` path).
const LUNORA_SYNC_DEFAULT = true;

/**
 * Whether outline sync rides Lunora (`/_lunora` + `@lunora/db`) instead of the
 * custom `/api/sync` + `nodesCollection` path (ADR 0055). Default ON.
 *
 * Disable: `localStorage.setItem("dotflowy:flag:lunora-sync", "off")` then reload,
 * or open with `?lunora-sync=off` (URL wins for that load; does not persist).
 * Enable: `"on"` in localStorage, or `?lunora-sync=on`.
 */
export function isLunoraSyncEnabled(): boolean {
  if (typeof window === "undefined") return LUNORA_SYNC_DEFAULT;
  try {
    const q = new URLSearchParams(window.location.search).get("lunora-sync");
    if (q === "on" || q === "1") return true;
    if (q === "off" || q === "0") return false;
    const v = window.localStorage.getItem(LUNORA_SYNC_FLAG_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch {
    // localStorage / URLSearchParams can throw; fall back to the default.
  }
  return LUNORA_SYNC_DEFAULT;
}
