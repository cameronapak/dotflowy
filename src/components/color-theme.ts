import { useLocation } from "@tanstack/react-router";
// The color theme (ADR 0082): one class on <html> (`theme-<id>` plus
// `themed`), separate from the light/dark Mode. The account's
// `appearance:color-theme` row is the source of truth, so the choice follows
// the user across devices; localStorage mirrors it so the no-flash script in
// __root.tsx paints the right theme before React or the account load.
import { Option, Schema } from "effect";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

import {
  customThemeCssFromTokens,
  customThemeName,
  customThemeTokens,
  CustomThemeId,
  formatCustomTheme,
  isCustomThemeId,
  parseCustomTheme,
  type CustomThemeSeed,
} from "../data/custom-theme";
import {
  peekEditorFeatures,
  setColorThemePreference,
  useEditorFeatures,
} from "../data/editor-features";
import { peekMembership, useMembership } from "../data/membership";
import { hasWindow } from "../env";
import { COLOR_THEME_KEY, CUSTOM_THEME_KEY } from "../lib/storage-keys";
import { THEME_COLORS } from "../themes.generated";

type ThemedId = keyof typeof THEME_COLORS;
/** A preset, or a custom theme's value `custom:1:…` (ADR 0088). */
export type ColorThemeId = "default" | ThemedId | `custom:${string}`;

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
  const preset = COLOR_THEMES.find((t) => t.id === value)?.id;
  if (preset) return preset;
  return value && isCustomThemeId(value) ? value : "default";
}

export const isCustomTheme = (id: ColorThemeId | null) =>
  id?.startsWith("custom:") ?? false;

/** What Settings, Cmd+K, and the membership dialog call a theme. */
export function colorThemeLabel(id: ColorThemeId): string {
  const seed = parseCustomTheme(id);
  if (seed) return customThemeName(seed);
  return COLOR_THEMES.find((t) => t.id === id)?.label ?? "Dotflowy";
}

const listeners = new Set<() => void>();
let preview: ColorThemeId | null = null;
// A custom theme mid-drag: painted for everyone, saved by no one until the
// picker commits it with setColorTheme.
let draft: ColorThemeId | null = null;

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
  return draft ?? preview ?? effectiveSavedTheme();
}

const CUSTOM_STYLE_ID = "dotflowy-custom-theme";

/** The device cache's id; its colors are only read by the no-flash script. */
const decodeCustomCache = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: CustomThemeId })),
);

/** A custom theme's colors for both Modes, as the device cache stores them. */
function customCache(id: ColorThemeId, seed: CustomThemeSeed) {
  return {
    id,
    light: customThemeTokens(seed, "light"),
    dark: customThemeTokens(seed, "dark"),
  };
}

/** Paint a theme without writing either the account or the no-flash cache.
 *  The no-flash script in __root.tsx creates the same style element. */
function paint(id: ColorThemeId) {
  const root = document.documentElement;
  root.classList.remove(
    ...Array.from(root.classList).filter((c) => c.startsWith("theme-")),
  );
  root.classList.toggle("themed", id !== "default");
  const seed = parseCustomTheme(id);
  if (seed) {
    const { light, dark } = customCache(id, seed);
    let style = document.getElementById(CUSTOM_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = CUSTOM_STYLE_ID;
      document.head.append(style);
    }
    style.textContent = customThemeCssFromTokens(light, dark);
    root.classList.add("theme-custom");
  } else if (id !== "default") root.classList.add(`theme-${id}`);
  for (const l of listeners) l();
}

/** Keep the no-flash cache in step with a custom theme's derived colors,
 *  which change when the derivation improves even though the id does not. */
function cacheCustomTheme(id: ColorThemeId) {
  const seed = parseCustomTheme(id);
  if (!seed) return;
  const cache = JSON.stringify(customCache(id, seed));
  if (localStorage.getItem(CUSTOM_THEME_KEY) !== cache)
    localStorage.setItem(CUSTOM_THEME_KEY, cache);
}

function applyLocal(id: ColorThemeId) {
  localStorage.setItem(COLOR_THEME_KEY, id);
  cacheCustomTheme(id);
  paint(draft ?? preview ?? effectiveSavedTheme());
}

/** This device's last custom theme, so Custom reopens it (one slot). */
export function lastCustomTheme(): ColorThemeId | null {
  const cached = decodeCustomCache(localStorage.getItem(CUSTOM_THEME_KEY));
  return Option.isSome(cached) && isCustomThemeId(cached.value.id)
    ? cached.value.id
    : null;
}

/** Cobalt on a soft page: where Custom starts on a device that never had one. */
const FIRST_CUSTOM_THEME = formatCustomTheme({ h: 255, c: 0.17, tint: 0.3 });

/** The custom theme that Settings and Cmd+K open when Custom is chosen. */
export const customThemeToReopen = (): ColorThemeId =>
  lastCustomTheme() ?? FIRST_CUSTOM_THEME;

/** Paint a custom theme while it is being dragged; null ends the draft. */
export function paintColorThemeDraft(id: ColorThemeId | null) {
  draft = id;
  paint(read());
}

/** Save the custom theme being dragged, if any, as the user lets go. */
export function commitColorThemeDraft() {
  if (draft) setColorTheme(draft);
}

export function endColorThemePreview() {
  preview = null;
  draft = null;
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
// Saves run one at a time, in the order they were picked: concurrent writes
// can reach the account out of order and leave an older theme saved.
let saveTail: Promise<void> = Promise.resolve();
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
  else cacheCustomTheme(id);
}

/** Free palettes preview locally; only entitled selections reach persistence. */
export function setColorTheme(id: ColorThemeId) {
  const membership = peekMembership();
  if (membership.state !== "ready") {
    draft = null;
    paint(read());
    toast.error("Your plan isn't available yet. Try again in a moment.");
    return;
  }
  draft = null;
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
  const save = saveTail.then(() => setColorThemePreference(id));
  saveTail = save.catch(() => {});
  save
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
    if (pathname !== "/settings" && (preview || draft)) endColorThemePreview();
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
