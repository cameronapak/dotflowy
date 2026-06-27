import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { setFavicon } from "../lib/favicon";
import {
  LEGACY_THEME_KEY,
  readStorageMigrated,
  THEME_KEY,
  THEME_PRESET_KEY,
} from "../lib/storage-keys";

type Theme = "dark" | "light" | "system";

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** The active color *preset* id (a tweakcn theme), or "default" for the
   *  built-in neutral palette in styles.css. Orthogonal to light/dark above:
   *  a preset ships both modes; `theme` picks which one shows. */
  preset: string;
  setPreset: (preset: string) => void;
}

const VALID_THEMES = new Set<Theme>(["dark", "light", "system"]);

const DEFAULT_PRESET = "default";

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

// --- light / dark / system (the mode) ---------------------------------------

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
  setFavicon(resolved);
}

// --- the color preset (a tweakcn theme) -------------------------------------
//
// The core treats the preset as an OPAQUE string: it persists it, mirrors it to
// the `data-theme` attribute (which the bundled themes plugin CSS keys on), and
// knows nothing about which presets exist. The themes plugin owns the catalog +
// the picker UI. "default" / unknown => no attribute => styles.css :root/.dark.

const presetListeners = new Set<() => void>();

/** Keep junk out of the attribute (it comes from localStorage). */
function sanitizePreset(value: string | null): string {
  if (value && /^[a-z0-9-]+$/.test(value)) return value;
  return DEFAULT_PRESET;
}

function subscribePreset(onStoreChange: () => void) {
  presetListeners.add(onStoreChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_PRESET_KEY) onStoreChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    presetListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function getPresetSnapshot(): string {
  return sanitizePreset(localStorage.getItem(THEME_PRESET_KEY));
}

function getPresetServerSnapshot(): string {
  return DEFAULT_PRESET;
}

function notifyPresetListeners() {
  for (const l of presetListeners) l();
}

/**
 * Mirror a preset onto <html data-theme>. Exported so the picker can *preview*
 * a preset on hover (apply to the DOM without committing) and restore the
 * committed one on dismiss. Idempotent; "default" clears the attribute.
 */
export function previewThemePreset(preset: string) {
  const root = document.documentElement;
  const safe = sanitizePreset(preset);
  if (safe === DEFAULT_PRESET) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", safe);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getThemeServerSnapshot,
  );
  const preset = useSyncExternalStore(
    subscribePreset,
    getPresetSnapshot,
    getPresetServerSnapshot,
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    previewThemePreset(preset);
  }, [preset]);

  // When on "system", react to OS theme changes live.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(THEME_KEY, next);
    notifyThemeListeners();
  }, []);

  const setPreset = useCallback((next: string) => {
    localStorage.setItem(THEME_PRESET_KEY, sanitizePreset(next));
    notifyPresetListeners();
  }, []);

  const value = useMemo(
    () => ({ theme, setTheme, preset, setPreset }),
    [theme, setTheme, preset, setPreset],
  );

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

/** Focused accessor for the color preset (the themes plugin's picker). */
export function useThemePreset() {
  const { preset, setPreset } = useTheme();
  return { preset, setPreset };
}
