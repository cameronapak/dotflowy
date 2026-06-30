/**
 * Runtime feature flags. One concern: a single switch can be flipped at runtime
 * (localStorage) without a rebuild, so e2e can exercise BOTH render paths and a
 * dogfooder can roll back instantly.
 *
 * `virtualized` gates Phase B (ADR 0019): the flat, windowed outline render.
 * Compiled default ON -- the recursive path is kept only as the localStorage
 * `off` fallback until the e2e suite proves parity, then this flag and the
 * recursive path are deleted together (ADR 0019 "don't regress").
 */

const VIRTUALIZED_KEY = "dotflowy:flag:virtualized";

// Compiled default. The whole point of Phase B is to ship the windowed render,
// so it's on; localStorage "off" is the escape hatch (and the e2e parity lever).
const VIRTUALIZED_DEFAULT = true;

const MIRRORS_KEY = "dotflowy:flag:mirrors";

// Compiled default OFF. Mirrors (ADR 0022) are mid-build: the render walk reads
// the flag, but the mirror-free outline must run today's exact code, so the
// feature is opt-in (localStorage "on") until it's complete and dogfooded.
const MIRRORS_DEFAULT = false;

/**
 * Whether the editor renders the flat, windowed outline (Phase B) instead of the
 * recursive DOM tree. Read at render time. SSR/prerender has no window and never
 * renders the live store anyway (SPA/no-SSR rule), so it falls to the default --
 * the value there is moot.
 */
export function isVirtualized(): boolean {
  if (typeof window === "undefined") return VIRTUALIZED_DEFAULT;
  try {
    const v = window.localStorage.getItem(VIRTUALIZED_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch {
    // localStorage can throw (private mode / disabled); fall back to the default.
  }
  return VIRTUALIZED_DEFAULT;
}

/**
 * Whether node mirrors (ADR 0022) are active. Read at render time by the visible-
 * order walk (mirror resolution + path keys) and the mirror create/chrome paths.
 * OFF by default: a mirror-free outline must behave byte-identically to today, so
 * the whole feature is opt-in until complete. Same localStorage escape-hatch shape
 * as {@link isVirtualized}.
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
