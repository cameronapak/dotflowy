import {
  createContext,
  use,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";

interface ShowCompletedState {
  showCompleted: boolean;
  setShowCompleted: (next: boolean) => void;
}

const STORAGE_KEY = "dotflowy-oss:show-completed";

const ShowCompletedContext = createContext<ShowCompletedState | null>(null);

const showCompletedListeners = new Set<() => void>();

function subscribeShowCompleted(onStoreChange: () => void) {
  showCompletedListeners.add(onStoreChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    showCompletedListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function getShowCompletedSnapshot(): boolean {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return true;
  return stored === "true";
}

function getShowCompletedServerSnapshot(): boolean {
  return true;
}

function notifyShowCompletedListeners() {
  for (const l of showCompletedListeners) l();
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

  const setShowCompleted = useCallback((next: boolean) => {
    localStorage.setItem(STORAGE_KEY, String(next));
    notifyShowCompletedListeners();
  }, []);

  const value = useMemo(
    () => ({ showCompleted, setShowCompleted }),
    [showCompleted, setShowCompleted],
  );

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
