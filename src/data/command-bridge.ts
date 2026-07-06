import type { NodeCommands } from "../components/OutlineNode";
import type { PluginContext } from "../plugins/types";

/**
 * Bridge for the Cmd+K command center (the "node-action" half of ADR 0034).
 *
 * The command center ({@link "../components/node-switcher"}) is mounted in
 * `__root.tsx`, OUTSIDE `OutlineEditor` -- so it can't reach the per-bullet
 * `NodeCommands` facade, the `PluginContext` factory, or the focus registry the
 * editor owns. This module is the one-way channel: `OutlineEditor` PUBLISHES the
 * live surface on mount (mirroring `node-switcher-opener.ts`), and the switcher
 * READS it to bind a node-action's `run()` to a target id.
 *
 * Everything published here is already stable identity in `OutlineEditor`
 * (`commands`, `pluginCtx`, `findFocusedId` are all memoized), so the publish is
 * a one-shot effect, not a per-render write. The switcher must tolerate `null`
 * (no editor mounted -- e.g. the login screen), which is why every field is read
 * through {@link getNodeActionBridge} at call time, never captured.
 */
export interface NodeActionBridge {
  /** The per-bullet command facade -- inherits runStructural atomicity + the
   *  protected-node guards for free (ADR 0009 / 0015). */
  commands: NodeCommands;
  /** The PluginContext factory, so a plugin `CommandSpec.run(id, ctx)` works. */
  getCtx: () => PluginContext;
  /** Reverse-lookup of the currently-focused row key (null outside the outline).
   *  Read in the switcher's capture-phase keydown, BEFORE the dialog steals
   *  focus, to snapshot the ambient target (ADR 0034). */
  findFocusedId: () => string | null;
  /** Return focus to a node after an action runs -- sets pending focus and, for
   *  a still-mounted row, focuses its contentEditable on the next frame. */
  focusNode: (id: string) => void;
}

let bridge: NodeActionBridge | null = null;

/** Called by `OutlineEditor` (publish on mount, `null` on unmount). */
export function setNodeActionBridge(next: NodeActionBridge | null) {
  bridge = next;
}

/** Read the live bridge, or `null` when no editor is mounted. */
export function getNodeActionBridge(): NodeActionBridge | null {
  return bridge;
}
