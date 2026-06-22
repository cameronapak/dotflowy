import { createContext, useContext, useEffect, useState } from "react";

interface ShowCompletedState {
  showCompleted: boolean;
  setShowCompleted: (next: boolean) => void;
}

const STORAGE_KEY = "dotflowy-oss:show-completed";

const ShowCompletedContext = createContext<ShowCompletedState | null>(null);

/**
 * Global "Show completed" preference (Workflowy's header toggle). When false,
 * completed bullets and their entire subtrees are hidden from the outline. This
 * is UI state, not document data, so it lives in its own localStorage key
 * separate from the nodes collection. See docs/adr/0002.
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
  const [showCompleted, setShowCompletedState] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) setShowCompletedState(stored === "true");
  }, []);

  const setShowCompleted = (next: boolean) => {
    localStorage.setItem(STORAGE_KEY, String(next));
    setShowCompletedState(next);
  };

  return (
    <ShowCompletedContext.Provider value={{ showCompleted, setShowCompleted }}>
      {children}
    </ShowCompletedContext.Provider>
  );
}

export function useShowCompleted() {
  const ctx = useContext(ShowCompletedContext);
  if (!ctx)
    throw new Error(
      "useShowCompleted must be used within a ShowCompletedProvider",
    );
  return ctx;
}
