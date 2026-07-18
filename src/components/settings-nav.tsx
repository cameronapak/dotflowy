import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Navigate to /settings from non-React code (the node-limit toast's "Upgrade"
 * action in structural.ts lives outside the component tree). Same
 * module-singleton opener shape as `quick-add-opener.ts`: a mounted registrar
 * hands its router `navigate` to the module, and `openSettings()` calls it —
 * an SPA navigation, never a hard `window.location` reload (which would tear
 * down the data layer just to change routes). No-op until the registrar mounts.
 */
let navigateToSettings: (() => void) | null = null;

export function openSettings() {
  navigateToSettings?.();
}

/** Registers the SPA navigation with {@link openSettings}. Returns null; mounted
 *  once in __root so the toast action can reach the router from anywhere. */
export function SettingsNavRegistrar() {
  const navigate = useNavigate();
  useEffect(() => {
    navigateToSettings = () => void navigate({ to: "/settings" });
    return () => {
      navigateToSettings = null;
    };
  }, [navigate]);
  return null;
}
