import { play, unlock } from "cuelume";
import { Option, Schema } from "effect";
import { useSyncExternalStore } from "react";

import { peekEditorFeatures } from "../../data/editor-features";
import { hasWindow } from "../../env";
import { advanceSession, type FocusSession, sessionSchema } from "./session";

let storageKey: string | null = null;
let session: FocusSession | null = null;
let unsaved = false;
let interval: number | null = null;
const listeners = new Set<() => void>();
const clockListeners = new Set<() => void>();
let now = Date.now();

export function readSession(): FocusSession | null {
  if (!storageKey) return null;
  if (unsaved) return session;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    return Option.getOrNull(
      Schema.decodeUnknownOption(sessionSchema)(JSON.parse(raw)),
    );
  } catch {
    return session;
  }
}

export function configureAccount(userId: string) {
  const key = `dotflowy:focus:${userId}`;
  if (storageKey === key) return;
  storageKey = key;
  unsaved = false;
  session = readSession();
  syncClock();
  for (const notify of listeners) notify();
}

function syncClock() {
  now = Date.now();
  const running = session && session.phase !== "reflect";
  if (running && interval === null) interval = window.setInterval(tick, 1000);
  if (!running && interval !== null) {
    window.clearInterval(interval);
    interval = null;
  }
}

function onStorage(event: StorageEvent) {
  if (event.key !== storageKey && event.key !== null) return;
  unsaved = false;
  session = readSession();
  syncClock();
  for (const notify of listeners) notify();
}

export function subscribeSession(notify: () => void) {
  listeners.add(notify);
  if (hasWindow() && listeners.size === 1)
    window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(notify);
    if (hasWindow() && listeners.size === 0)
      window.removeEventListener("storage", onStorage);
  };
}

export const getSession = () => session;
export function useSession() {
  return useSyncExternalStore(subscribeSession, getSession, () => null);
}

/** Event-time writes re-read shared browser state so another tab's pause/end
 * cannot be overwritten by an older local snapshot. */
export function updateSession(
  change: (current: FocusSession | null) => FocusSession | null,
) {
  const next = change(readSession());
  if (!storageKey) return;
  session = next;
  try {
    if (next) localStorage.setItem(storageKey, JSON.stringify(next));
    else localStorage.removeItem(storageKey);
    unsaved = false;
  } catch {
    // A blocked storage area still permits a session in this tab.
    unsaved = true;
  }
  syncClock();
  for (const notify of listeners) notify();
}

export function cue(name: "attention" | "success" | "ready") {
  if (peekEditorFeatures().focus.sounds) play(name);
}

export function unlockSounds() {
  void unlock();
}

/** Only the tab holding this browser lock announces/persists a clock transition.
 * Pure timestamp math also catches up correctly after a suspended tab resumes. */
export function tick() {
  now = Date.now();
  for (const notify of clockListeners) notify();
  const advance = () => {
    const current = readSession();
    if (!current) return;
    const next = advanceSession(current, now);
    if (next === current) return;
    updateSession((latest) => (latest?.id === current.id ? next : latest));
    cue(next.phase === "ready" ? "ready" : "attention");
  };
  if (navigator.locks) {
    void navigator.locks.request(
      "dotflowy-focus-clock",
      { ifAvailable: true },
      (lock) => {
        if (lock) advance();
      },
    );
  } else advance();
}

export function useClock(active: boolean) {
  return useSyncExternalStore(
    (notify) => {
      clockListeners.add(notify);
      return () => {
        clockListeners.delete(notify);
      };
    },
    () => (active ? now : 0),
    () => 0,
  );
}
