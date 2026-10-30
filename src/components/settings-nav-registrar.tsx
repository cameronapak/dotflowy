import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { setSettingsNav } from "./settings-nav";

/**
 * Registers an SPA navigation to /settings with the {@link setSettingsNav}
 * opener so non-React code (the node-limit toast's "Upgrade" action) can reach
 * the router. Returns null; mounted once in __root. Mirrors how `quick-add.tsx`
 * registers `setQuickAddOpener`.
 */
export function SettingsNavRegistrar() {
  const navigate = useNavigate();
  useEffect(() => {
    setSettingsNav((hash) => void navigate({ to: "/settings", hash }));
    return () => setSettingsNav(null);
  }, [navigate]);
  return null;
}
