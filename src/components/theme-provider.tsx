import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = "dotflowy-oss:theme";

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

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
  // SPA mode still does a server render pass for the shell, where localStorage
  // is undefined. So we default to "system" during render and read the stored
  // value on mount. The inline no-flash script in __root.tsx applies the right
  // theme to <html> before hydration, so there's no visible flash.
  const [theme, setThemeState] = useState<Theme>("system");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    if (stored && stored !== theme) setThemeState(stored);
    // Mount-only: read the stored theme once. `theme` is compared against its
    // mount-time default; re-running would fight setTheme.
    // eslint-disable-next-line react-doctor/exhaustive-deps
  }, []);

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

  const setTheme = (next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  };

  return (
    <ThemeProviderContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeProviderContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
