import { createContext, use, useEffect, useSyncExternalStore } from "react";
import {
  LEGACY_THEME_KEY,
  readStorageMigrated,
  THEME_KEY,
} from "../lib/storage-keys";

type Theme = "dark" | "light" | "system";

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const VALID_THEMES = new Set<Theme>(["dark", "light", "system"]);

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

const themeListeners = new Set<() => void>();

function subscribeTheme(onStoreChange: () => void) {
  themeListeners.add(onStoreChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY || e.key === LEGACY_THEME_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    themeListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function getThemeSnapshot(): Theme {
  const stored = readStorageMigrated(THEME_KEY, LEGACY_THEME_KEY);
  if (stored && VALID_THEMES.has(stored as Theme)) return stored as Theme;
  return "system";
}

function getThemeServerSnapshot(): Theme {
  return "system";
}

function notifyThemeListeners() {
  for (const l of themeListeners) l();
}

function setTheme(next: Theme) {
  localStorage.setItem(THEME_KEY, next);
  notifyThemeListeners();
}

/**
 * Applies the resolved theme to <html>. "system" follows the OS preference.
 * Kept in sync with the inline no-flash script in __root.tsx (same storage key
 * and resolution logic) so first paint never flashes the wrong theme.
 */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  root.classList.toggle("dark", resolved === "dark");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeServerSnapshot,
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // When on "system", react to OS theme changes live.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const value = { theme, setTheme };

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme() {
  const ctx = use(ThemeProviderContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
