import { useEffect, useState } from "react";

/**
 * Whether narrow-screen chrome should unmount its glass for opaque controls
 * (ADR 0076): reduced motion or transparency, increased contrast, forced
 * colors, or no backdrop-filter support.
 */
export function useOpaqueChrome(): boolean {
  const [opaque, setOpaque] = useState(true);

  useEffect(() => {
    const preferences = [
      "(prefers-reduced-motion: reduce)",
      "(prefers-reduced-transparency: reduce)",
      "(prefers-contrast: more)",
      "(forced-colors: active)",
    ].map((query) => window.matchMedia(query));
    const update = () =>
      setOpaque(
        preferences.some((preference) => preference.matches) ||
          !(
            CSS.supports("backdrop-filter", "blur(1px)") ||
            CSS.supports("-webkit-backdrop-filter", "blur(1px)")
          ),
      );
    update();
    preferences.forEach((preference) =>
      preference.addEventListener("change", update),
    );
    return () =>
      preferences.forEach((preference) =>
        preference.removeEventListener("change", update),
      );
  }, []);

  return opaque;
}
