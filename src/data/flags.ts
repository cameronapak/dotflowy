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

// Compiled default ON. Mirrors (ADR 0022) shipped to all users; localStorage
// "off" is the escape hatch if a regression turns up.
const MIRRORS_DEFAULT = true;

const MOBILE_BAR_KEY = "dotflowy:flag:mobile-bar";

// Compiled default ON. The mobile actions bar (ADR 0030) ships to touch users;
// localStorage "off" is the escape hatch (and the e2e lever). Deleted once
// dogfooded, same lifecycle as `isVirtualized`.
const MOBILE_BAR_DEFAULT = true;

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
 * ON by default for all users; localStorage "off" is the rollback escape hatch.
 * Same localStorage escape-hatch shape as {@link isVirtualized}.
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

/**
 * Whether the mobile actions bar (ADR 0030) is compiled in. The bar only ever
 * MOUNTS on a coarse pointer (checked at render); this flag is the rollback
 * escape hatch and e2e lever, same localStorage shape as {@link isVirtualized}.
 */
export function isMobileBar(): boolean {
  if (typeof window === "undefined") return MOBILE_BAR_DEFAULT;
  try {
    const v = window.localStorage.getItem(MOBILE_BAR_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch {
    // localStorage can throw (private mode / disabled); fall back to the default.
  }
  return MOBILE_BAR_DEFAULT;
}
