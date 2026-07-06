export const THEME_KEY = "dotflowy:theme";
export const SHOW_COMPLETED_KEY = "dotflowy:show-completed";
export const TEXT_SIZE_KEY = "dotflowy:text-size";
export const SPOTLIGHT_KEY = "dotflowy:spotlight";

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
