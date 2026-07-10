/**
 * The one place the Worker learns what version it is (ADR 0046).
 *
 * `package.json` is the source, imported directly rather than duplicated: a
 * hardcoded copy is stale by construction, and `SERVER_INFO.version` in mcp.ts
 * proved it — it sat at "0.1.0" while the app moved on. Adopting semver without
 * fixing that would ship `2.0.0` to humans and `0.1.0` to every agent on the
 * same deploy.
 *
 * The client gets the same value through Vite's `define` (`__APP_VERSION__`),
 * so a tab can compare itself to the `serverVersion` on the sync handshake.
 */

import pkg from "../package.json";

export const APP_VERSION: string = pkg.version;
