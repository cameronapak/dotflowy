// The browser side of personal plugins (ADR 0095): which definitions this
// account has live. The server decides every gate; this module only mirrors
// its answer.
//
// Inert until the account is signed in (editor features report ready). Then
// one GET /api/personal-plugins/state:
//   - 404: the feature is not deployed. Stop for this page load.
//   - 401/403: not signed in or not eligible. Clear everything; check again on
//     the next tab focus.
//   - 200: eligible. While opted in, poll so an agent's save appears without a
//     reload.
// A network failure keeps the last answer, so going offline doesn't flicker
// plugins away.

import { useSyncExternalStore } from "react";

import type {
  ActivePersonalPlugin,
  PersonalPluginsState,
} from "../../data/personal-plugins";

import {
  peekEditorFeatures,
  subscribeEditorFeatures,
} from "../../data/editor-features";
import { hasWindow } from "../../env";

const POLL_MS = 5000;

type Access = "unknown" | "absent" | "ineligible" | "eligible";

let access: Access = "unknown";
let optedIn = false;
let installed: ActivePersonalPlugin[] = [];
let signature = "";
let started = false;
let timer: number | undefined;
const listeners = new Set<() => void>();

function apply(
  nextAccess: Access,
  nextOptedIn: boolean,
  next: ActivePersonalPlugin[],
) {
  const nextSignature = JSON.stringify([nextAccess, nextOptedIn, next]);
  if (nextSignature === signature) return;
  signature = nextSignature;
  access = nextAccess;
  optedIn = nextOptedIn;
  installed = next;
  schedule();
  for (const notify of listeners) notify();
}

function schedule() {
  const poll = access === "eligible" && optedIn;
  if (poll && timer === undefined)
    timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
  if (!poll && timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

export async function refresh(): Promise<void> {
  if (access === "absent") return;
  const res = await fetch("/api/personal-plugins/state").catch(() => null);
  if (!res) return;
  if (res.status === 404) return apply("absent", false, []);
  if (!res.ok) return apply("ineligible", false, []);
  // SAFETY: the Worker builds this body from definitions it validated on save.
  const state = (await res.json()) as PersonalPluginsState;
  apply("eligible", state.optedIn, state.plugins);
}

function start() {
  if (started || !hasWindow()) return;
  started = true;
  void refresh();
  const recheck = () => {
    if (document.visibilityState === "visible" && access !== "absent")
      void refresh();
  };
  window.addEventListener("focus", recheck);
  document.addEventListener("visibilitychange", recheck);
}

// Registration runs before auth; fetch only once the signed-in account's
// preferences have loaded.
subscribeEditorFeatures(() => {
  if (peekEditorFeatures().ready) start();
});

export function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** Eligible and opted in: render plugins and author over MCP. */
export const isActive = () => access === "eligible" && optedIn;
/** Eligible but not opted in: offer the opt-in. */
export const canOptIn = () => access === "eligible" && !optedIn;
export const getInstalled = () => installed;

export function useInstalled(): ActivePersonalPlugin[] {
  return useSyncExternalStore(subscribe, getInstalled, getInstalled);
}

export function usePersonalPluginsAccess() {
  return useSyncExternalStore(
    subscribe,
    () => access,
    () => access,
  );
}

export function useOptedIn() {
  return useSyncExternalStore(
    subscribe,
    () => optedIn,
    () => false,
  );
}

/** Turn personal plugins on or off for this account. Off keeps every plugin
 *  and its history. */
export async function setOptIn(enabled: boolean): Promise<boolean> {
  const res = await fetch("/api/personal-plugins/opt-in", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  }).catch(() => null);
  if (!res?.ok) return false;
  // SAFETY: same shape as GET /state.
  const state = (await res.json()) as PersonalPluginsState;
  apply("eligible", state.optedIn, state.plugins);
  return true;
}
