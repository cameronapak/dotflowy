import { createContext, use, useSyncExternalStore } from "react";
import {
  LEGACY_SHOW_COMPLETED_KEY,
  readStorageMigrated,
  SHOW_COMPLETED_KEY,
} from "../lib/storage-keys";

interface ShowCompletedState {
  showCompleted: boolean;
  setShowCompleted: (next: boolean) => void;
}

const ShowCompletedContext = createContext<ShowCompletedState | null>(null);

const showCompletedListeners = new Set<() => void>();

function subscribeShowCompleted(onStoreChange: () => void) {
  showCompletedListeners.add(onStoreChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SHOW_COMPLETED_KEY || e.key === LEGACY_SHOW_COMPLETED_KEY)
      onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    showCompletedListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function getShowCompletedSnapshot(): boolean {
  const stored = readStorageMigrated(
    SHOW_COMPLETED_KEY,
    LEGACY_SHOW_COMPLETED_KEY,
  );
  if (stored === null) return true;
  return stored === "true";
}

function getShowCompletedServerSnapshot(): boolean {
  return true;
}

function notifyShowCompletedListeners() {
  for (const l of showCompletedListeners) l();
}

function setShowCompleted(next: boolean) {
  localStorage.setItem(SHOW_COMPLETED_KEY, String(next));
  notifyShowCompletedListeners();
}

/**
 * Global "Show completed" preference (Workflowy's header toggle). When false,
 * completed bullets and their entire subtrees are hidden from the outline. This
 * is UI state, not document data, so it lives in its own localStorage key
 * separate from the nodes collection. See ADR 0002.
 *
 * Mirrors ThemeProvider: defaults during the SPA's server render pass (no
 * localStorage there) and reads the stored value on mount. Default is `true`
 * (show everything) so a first-run user sees their completed items.
 */
export function ShowCompletedProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const showCompleted = useSyncExternalStore(
    subscribeShowCompleted,
    getShowCompletedSnapshot,
    getShowCompletedServerSnapshot,
  );

  const value = { showCompleted, setShowCompleted };

  return (
    <ShowCompletedContext.Provider value={value}>
      {children}
    </ShowCompletedContext.Provider>
  );
}

export function useShowCompleted() {
  const ctx = use(ShowCompletedContext);
  if (!ctx)
    throw new Error(
      "useShowCompleted must be used within a ShowCompletedProvider",
    );
  return ctx;
}
