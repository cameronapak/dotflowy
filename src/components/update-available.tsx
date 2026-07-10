import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { useUpdateAvailable } from "../data/app-version";

/**
 * "Dotflowy has been updated" — the reload affordance for a tab whose bundle is
 * older than the Worker it just handshook with (ADR 0046, `app-version.ts`).
 *
 * Non-blocking and never automatic: an outliner tab can hold a keystroke that
 * hasn't reached the collection yet, and no version is worth eating it. The
 * toast persists (`duration: Infinity`) because the condition it reports does
 * not go away on its own, and fires at most once per session — a reconnect
 * storm behind a deploy must not stack toasts.
 *
 * Renders nothing. Mounted once in `__root.tsx`.
 */
export function UpdateAvailableToast() {
  const available = useUpdateAvailable();
  const fired = useRef(false);

  useEffect(() => {
    if (!available || fired.current) return;
    fired.current = true;
    toast("Dotflowy has been updated", {
      description: "Reload to pick up the latest version.",
      duration: Infinity,
      action: {
        label: "Reload",
        onClick: () => window.location.reload(),
      },
    });
  }, [available]);

  return null;
}
