import type { ComponentType } from "react";

/** Shared descriptors stay independent of the browser's command registry. */
export type ActionScope = "global" | "node";

export interface CommandCenterAction {
  id: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  scope: ActionScope;
  keywords?: string[];
  /** Display-only shortcut, one string per key cap (e.g. `["⌘", "⇧", "↑"]`). */
  hotkey?: string[];
  disabled?: boolean;
  run: () => void;
}
