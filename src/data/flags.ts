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
