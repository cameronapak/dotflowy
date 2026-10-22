/**
 * "This tab is running an old build" (ADR 0046).
 *
 * An outliner tab stays open for days, and its bundle — including the release
 * array the changelog renders — is frozen at load. Meanwhile it talks to today's
 * Worker. So a changelog alone cannot inform the one reader a MAJOR bump exists
 * for, and a moved wire shape reads to that user as "my edits stopped saving"
 * rather than "I should reload."
 *
 * The fix is one field on the sync handshake. `collection.ts` calls
 * `noteServerVersion` with the `serverVersion` on every `snapshot`/`resume`;
 * a mismatch latches this flag, and `<UpdateAvailableToast>` offers a reload.
 *
 * Deliberately NOT the changelog. It is a separate mechanism with a separate
 * trigger, and it never reloads on its own — an outliner may hold an uncommitted
 * keystroke, and nothing here is worth eating it.
 */

import { useSyncExternalStore } from "react";

import { version } from "../../package.json";

/**
 * The version THIS bundle is.
 *
 * Imported from `package.json` — the same source `worker/version.ts` reads, so
 * the two halves of the comparison below cannot drift. A named JSON import
 * tree-shakes to the bare string (verified: no dependency names reach the client
 * bundle), and it resolves under `bun test` too, which a Vite `define` would
 * not.
 */
export const APP_VERSION: string = version;

let updateAvailable = false;
const listeners = new Set<() => void>();

/**
 * Record the version the server reported on a handshake frame.
 *
 * Latching, and one-way: once we know we're stale, a later frame can't un-stale
 * us (a deploy rolling back mid-session shouldn't retract a reload prompt the
 * user is looking at). `undefined` means the frame predates this field — an
 * older DO, or the e2e Worker mock — and says nothing either way.
 */
export function noteServerVersion(version: string | undefined): void {
  if (updateAvailable) return;
  if (!version || version === APP_VERSION) return;
  updateAvailable = true;
  for (const l of listeners) l();
}

export function isUpdateAvailable(): boolean {
  return updateAvailable;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Reactive: true once the server has reported a version this bundle isn't. */
export function useUpdateAvailable(): boolean {
  return useSyncExternalStore(subscribe, isUpdateAvailable, () => false);
}
