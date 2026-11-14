export const THEME_KEY = "dotflowy:theme";
export const SHOW_COMPLETED_KEY = "dotflowy:show-completed";
export const TEXT_SIZE_KEY = "dotflowy:text-size";
/** Local mirror of the account's color theme (ADR 0082), for first paint. */
export const COLOR_THEME_KEY = "dotflowy:color-theme";
/** This device's custom theme (ADR 0088): its value and derived colors, so
 *  the no-flash script paints it, and so Custom reopens the last one. */
export const CUSTOM_THEME_KEY = "dotflowy:custom-theme";
export const SPOTLIGHT_KEY = "dotflowy:spotlight";
export const SCRIBBLE_KEY = "dotflowy:scribble";

export const LEGACY_THEME_KEY = "dotflowy-oss:theme";
export const LEGACY_SHOW_COMPLETED_KEY = "dotflowy-oss:show-completed";

export function readStorageMigrated(
  key: string,
  legacyKey: string,
): string | null {
  const value = localStorage.getItem(key);
  if (value !== null) return value;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy === null) return null;
  localStorage.setItem(key, legacy);
  localStorage.removeItem(legacyKey);
  return legacy;
}
