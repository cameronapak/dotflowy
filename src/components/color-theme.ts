import { useLocation } from "@tanstack/react-router";
// The color theme (ADR 0082): one class on <html> (`theme-<id>` plus
// `themed`), separate from the light/dark Mode. The account's
// `appearance:color-theme` row is the source of truth, so the choice follows
// the user across devices; localStorage mirrors it so the no-flash script in
// __root.tsx paints the right theme before React or the account load.
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

import {
  peekEditorFeatures,
  setColorThemePreference,
  useEditorFeatures,
} from "../data/editor-features";
import { peekMembership, useMembership } from "../data/membership";
import { hasWindow } from "../env";
import { COLOR_THEME_KEY } from "../lib/storage-keys";
import { THEME_COLORS } from "../themes.generated";

type ThemedId = keyof typeof THEME_COLORS;
export type ColorThemeId = "default" | ThemedId;

/** Settings and Cmd+K order. `swatch` is the light background and primary. */
export const COLOR_THEMES: readonly {
  id: ColorThemeId;
  label: string;
  swatch: readonly [string, string];
}[] = [
  // The default theme's tokens live in styles.css, not themes.css.
  { id: "default", label: "Dotflowy", swatch: ["#f9f9f9", "#171717"] },
  ...(
    [
      ["claude-ish", "Claude-ish"],
      ["catppuccin", "Catppuccin"],
      ["twitter-ish", "Twitter-ish"],
      ["modern-minimal", "Modern Minimal"],
      ["leaf", "Leaf"],
    ] as const
  ).map(([id, label]) => ({
    id,
    label,
    swatch: [THEME_COLORS[id].background[0], THEME_COLORS[id].primary] as const,
  })),
];

/** An unknown id (from a newer client, or edited storage) is the default. */
function toColorThemeId(value: string | null): ColorThemeId {
  return COLOR_THEMES.find((t) => t.id === value)?.id ?? "default";
}

const listeners = new Set<() => void>();
let preview: ColorThemeId | null = null;

function savedTheme(): ColorThemeId {
  return toColorThemeId(
    hasWindow() ? localStorage.getItem(COLOR_THEME_KEY) : null,
  );
}

function effectiveSavedTheme(): ColorThemeId {
  const id = savedTheme();
  const membership = peekMembership();
  return membership.state === "ready" &&
    membership.plan === "free" &&
    id !== "default" &&
    !(membership.legacyLeaf && id === "leaf")
    ? "default"
    : id;
}

function read(): ColorThemeId {
  return preview ?? effectiveSavedTheme();
}

/** Paint a preview without writing either the account or the no-flash cache. */
function paint(id: ColorThemeId) {
  const root = document.documentElement;
  root.classList.remove(
    ...Array.from(root.classList).filter((c) => c.startsWith("theme-")),
  );
  root.classList.toggle("themed", id !== "default");
  if (id !== "default") root.classList.add(`theme-${id}`);
  for (const l of listeners) l();
}

function applyLocal(id: ColorThemeId) {
  localStorage.setItem(COLOR_THEME_KEY, id);
  paint(preview ?? effectiveSavedTheme());
}

export function endColorThemePreview() {
  preview = null;
  paint(effectiveSavedTheme());
}

export function useColorThemePreview() {
  return useSyncExternalStore(
    subscribe,
    () => preview,
    () => null,
  );
}

// Saves in flight. While one runs, the local pick is newer than anything the
// account snapshot shows, so adopting the snapshot would flash the old theme.
let pendingSaves = 0;
// The last theme the account reported. A row is never deleted, so once one
// exists a missing row is a refetch in progress, not "back to default".
let accountTheme: string | null = null;

/** Repaint with the account's theme when it is known and nothing is saving. */
function adoptAccountTheme() {
  const { ready, colorTheme } = peekEditorFeatures();
  if (!ready || pendingSaves > 0) return;
  if (colorTheme === null && accountTheme !== null) return;
  accountTheme = colorTheme;
  const id = toColorThemeId(colorTheme);
  if (id !== savedTheme()) applyLocal(id);
}

/** Free palettes preview locally; only entitled selections reach persistence. */
export function setColorTheme(id: ColorThemeId) {
  const membership = peekMembership();
  if (membership.state !== "ready") {
    toast.error("Your plan isn't available yet. Try again in a moment.");
    return;
  }
  if (
    membership.plan === "free" &&
    id !== "default" &&
    !(membership.legacyLeaf && id === "leaf")
  ) {
    preview = id;
    paint(id);
    return;
  }
  preview = null;
  const previous = savedTheme();
  applyLocal(id);
  pendingSaves += 1;
  setColorThemePreference(id)
    .then(() => {
      accountTheme = id;
    })
    .catch(() => {
      // A failed write rolls the account row back, and adopting it below
      // repaints. A failed account load wrote nothing to roll back, so the
      // previous theme comes back here.
      if (!peekEditorFeatures().ready) applyLocal(previous);
      toast.error(
        "Couldn't save your theme. Your previous theme was restored.",
      );
    })
    .finally(() => {
      pendingSaves -= 1;
      adoptAccountTheme();
    });
}

/**
 * Adopts the account's theme once it loads and whenever it changes (another
 * device, a rolled-back save). Mounted inside the AuthGate: the account row
 * needs a session. A missing row is the default theme.
 */
export function ColorThemeSync() {
  const { colorTheme, ready } = useEditorFeatures();
  const membership = useMembership();
  const pathname = useLocation({ select: (location) => location.pathname });
  // Reset on leaving the route, not on component cleanup during navigation.
  useEffect(() => {
    if (pathname !== "/settings" && preview) endColorThemePreview();
  }, [pathname]);
  useEffect(adoptAccountTheme, [ready, colorTheme]);
  useEffect(() => {
    paint(read());
  }, [membership.state, membership.plan, membership.legacyLeaf]);
  return null;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useColorTheme(): ColorThemeId {
  return useSyncExternalStore(subscribe, read, () => "default");
}

/**
 * The browser and iPhone status bar follow the page background, which
 * reflects both the theme and the Mode. __root.tsx renders one unscoped
 * `theme-color` tag and its no-flash script sets the first value; this keeps
 * it current, along with the copy React hydration adds to <head>. iOS Safari does not reliably repaint a media-scoped tag, so
 * there is no media query. Watching <html>'s classes covers every path that
 * changes them (Settings, Cmd+K, the Mode toggle, the system scheme).
 */
function syncStatusBar() {
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  // Before the stylesheet applies there is no background to read yet; the
  // no-flash script's value stands until the next class change.
  const styled = getComputedStyle(document.documentElement)
    .getPropertyValue("--background")
    .trim();
  if (metas.length === 0 || !styled) return;
  // Paint the background onto a pixel to get plain sRGB: a computed oklch()
  // string is not a color every status bar understands.
  const probe = document.createElement("span");
  probe.style.color = "var(--background)";
  document.body.append(probe);
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx) {
    ctx.fillStyle = getComputedStyle(probe).color;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
    const color = `rgb(${r}, ${g}, ${b})`;
    for (const meta of metas)
      if (meta.getAttribute("content") !== color)
        meta.setAttribute("content", color);
  }
  probe.remove();
}

if (hasWindow()) {
  const start = () => {
    syncStatusBar();
    const observer = new MutationObserver(syncStatusBar);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    observer.observe(document.head, { childList: true });
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}
