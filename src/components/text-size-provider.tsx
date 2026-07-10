import { createContext, use, useEffect, useSyncExternalStore } from "react";

import { TEXT_SIZE_KEY } from "../lib/storage-keys";

/**
 * Reading-size preference (ADR 0029). A device-local setting that scales the
 * outline's text through one CSS variable (`--reading-font-size`, keyed off a
 * `data-text-size` attribute on <html>), NOT synced to the per-user DO --
 * ideal reading size is a property of the screen, not the account.
 *
 * Mirrors theme-provider.tsx verbatim (useSyncExternalStore over localStorage,
 * a no-flash inline script in __root.tsx). "default" is the compiled baseline
 * (17px, see styles.css) and needs no attribute; small/large set it.
 */
export type TextSize = "small" | "default" | "large";

interface TextSizeProviderState {
  textSize: TextSize;
  setTextSize: (size: TextSize) => void;
}

const VALID_SIZES = new Set<TextSize>(["small", "default", "large"]);

const TextSizeProviderContext = createContext<TextSizeProviderState | null>(
  null,
);

const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === TEXT_SIZE_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): TextSize {
  try {
    const stored = localStorage.getItem(TEXT_SIZE_KEY);
    if (stored && VALID_SIZES.has(stored as TextSize))
      return stored as TextSize;
  } catch {
    // localStorage can throw (private mode / disabled); fall back to default.
  }
  return "default";
}

function getServerSnapshot(): TextSize {
  return "default";
}

function notify() {
  for (const l of listeners) l();
}

// Module scope: reads no component state, so it's a single stable function
// (mirrors theme-provider's module-scope setter).
function setTextSize(next: TextSize) {
  try {
    localStorage.setItem(TEXT_SIZE_KEY, next);
  } catch {
    // Ignore write failures (private mode); the in-memory notify still applies.
  }
  notify();
}

/**
 * Reflects the size onto <html data-text-size>. Kept in sync with the inline
 * no-flash script in __root.tsx (same key + attribute) so first paint never
 * flashes the default size then resizes.
 */
function applyTextSize(size: TextSize) {
  const root = document.documentElement;
  if (size === "default") root.removeAttribute("data-text-size");
  else root.setAttribute("data-text-size", size);
}

export function TextSizeProvider({ children }: { children: React.ReactNode }) {
  const textSize = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  useEffect(() => {
    applyTextSize(textSize);
  }, [textSize]);

  const value = { textSize, setTextSize };

  return (
    <TextSizeProviderContext.Provider value={value}>
      {children}
    </TextSizeProviderContext.Provider>
  );
}

export function useTextSize() {
  const ctx = use(TextSizeProviderContext);
  if (!ctx)
    throw new Error("useTextSize must be used within a TextSizeProvider");
  return ctx;
}
