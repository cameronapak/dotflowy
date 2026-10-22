/**
 * Environment probes. Property access on `globalThis` is always safe (no
 * ReferenceError), so capability checks read through it instead of a bare
 * `typeof` probe. Functions, not consts, so tests that install window/document
 * stubs later in the same process stay accurate.
 */

/** Browser globals this module probes; absent in non-DOM runtimes (worker/tests). */
type BrowserGlobals = {
  window?: unknown;
  document?: unknown;
  crypto?: { randomUUID?: unknown };
  ResizeObserver?: unknown;
  HTMLElement?: unknown;
  customElements?: { define: unknown; get: unknown };
  matchMedia?: unknown;
  btoa?: unknown;
};

// SAFETY: optional-property view of globalThis; every member read is presence-checked
const browserGlobals = globalThis as BrowserGlobals;

export function isBrowser(): boolean {
  return (
    browserGlobals.window !== undefined && browserGlobals.document !== undefined
  );
}

export function hasWindow(): boolean {
  return browserGlobals.window !== undefined;
}

export function hasCryptoRandomUuid(): boolean {
  const crypto = browserGlobals.crypto;
  return crypto !== undefined && "randomUUID" in crypto;
}

export function hasResizeObserver(): boolean {
  return browserGlobals.ResizeObserver !== undefined;
}

export function hasCustomElements(): boolean {
  return (
    browserGlobals.HTMLElement !== undefined &&
    browserGlobals.customElements !== undefined
  );
}

export function hasMatchMedia(): boolean {
  return browserGlobals.matchMedia !== undefined;
}

export function hasBtoa(): boolean {
  return browserGlobals.btoa !== undefined;
}
