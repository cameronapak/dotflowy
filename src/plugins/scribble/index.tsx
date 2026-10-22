import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSyncExternalStore } from "react";
import "@fontsource/redacted-script/400.css";

import { hasWindow } from "../../env";
import { SCRIBBLE_KEY } from "../../lib/storage-keys";
import { Button } from "../kit";
import { definePlugin } from "../types";

const listeners = new Set<() => void>();
let unsaved: boolean | null = null;

function enabled(): boolean {
  if (unsaved !== null) return unsaved;
  try {
    return window.localStorage.getItem(SCRIBBLE_KEY) === "true";
  } catch {
    return false;
  }
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  const onStorage = (event: StorageEvent) => {
    if (event.key === SCRIBBLE_KEY || event.key === null) {
      unsaved = null;
      notify();
    }
  };
  if (hasWindow()) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(notify);
    if (hasWindow()) window.removeEventListener("storage", onStorage);
  };
}

function setEnabled(next: boolean) {
  unsaved = next;
  try {
    window.localStorage.setItem(SCRIBBLE_KEY, String(next));
    unsaved = null;
  } catch {
    // Keep the toggle usable in this tab when browser storage is unavailable.
  }
  for (const notify of listeners) notify();
}

function ScribbleIcon({ className }: { className?: string }) {
  return <HugeiconsIcon icon={PencilEdit02Icon} className={className} />;
}

function ScribbleIndicator() {
  const on = useSyncExternalStore(subscribe, enabled, () => false);
  if (!on) return null;
  return (
    <Button
      variant="default"
      size="icon-sm"
      aria-pressed
      aria-label="Turn off Scribble mode"
      title="Scribble mode is on. Click to turn off."
      onClick={() => setEnabled(false)}
    >
      <ScribbleIcon />
    </Button>
  );
}

export default definePlugin({
  id: "scribble",
  globalActions: () => [
    {
      id: "toggle",
      label: `Turn ${enabled() ? "off" : "on"} Scribble mode`,
      description: "Scribble all node text, including the active node",
      icon: ScribbleIcon,
      keywords: ["scribble", "font", "writing", "focus"],
      menuLabel: "Scribble mode",
      checked: enabled(),
      run: () => setEnabled(!enabled()),
    },
  ],
  editorFont: () => (enabled() ? '"Redacted Script"' : null),
  chromeChanged: subscribe,
  headerSlots: [
    { id: "scribble-indicator", render: () => <ScribbleIndicator /> },
  ],
});
