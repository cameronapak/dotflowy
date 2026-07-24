/**
 * Production-safe `react/jsx-dev-runtime` shim.
 *
 * `@lunora/react` publishes packem output that imports `jsxDEV` from
 * `react/jsx-dev-runtime`. Vite's production React resolve replaces that
 * module with `{ jsxDEV: undefined }`, so `LunoraProvider` (and anything
 * else from the package) crashes with "jsxDEV is not a function" under
 * `cf:dev` / `build:cf`. Dev (`bun run dev`) keeps a real jsxDEV and is fine.
 *
 * Aliased from `vite.config.ts` — map jsxDEV onto production jsx/jsxs.
 */
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

export { Fragment };

export function jsxDEV(
  type: Parameters<typeof jsx>[0],
  props: Parameters<typeof jsx>[1],
  key?: Parameters<typeof jsx>[2],
  isStaticChildren?: boolean,
) {
  return isStaticChildren ? jsxs(type, props!, key) : jsx(type, props!, key);
}
