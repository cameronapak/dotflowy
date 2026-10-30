/**
 * Navigate to /settings from non-React code (the node-limit toast's "Upgrade"
 * action in structural.ts lives outside the component tree). Same
 * module-singleton opener shape as `quick-add-opener.ts`: a mounted registrar
 * (settings-nav-registrar.tsx) hands its router `navigate` here, and
 * `openSettings()` calls it — an SPA navigation, never a hard `window.location`
 * reload (which would tear down the data layer just to change routes). No-op
 * until the registrar mounts.
 *
 * Kept as a plain `.ts` (no React import) so data-layer consumers like
 * structural.ts don't pull @tanstack/react-router into their module graph.
 */
let navigateToSettings: ((hash?: string) => void) | null = null;

export function setSettingsNav(fn: typeof navigateToSettings) {
  navigateToSettings = fn;
}

/** `hash` names a Settings anchor, such as a plugin whose options to open. */
export function openSettings(hash?: string) {
  navigateToSettings?.(hash);
}
