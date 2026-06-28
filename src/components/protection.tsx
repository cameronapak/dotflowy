/**
 * Protected nodes -- the core half of the seam.
 *
 * A plugin declares a node protected via `protects` (Seam, see plugins/types.ts);
 * the CORE owns what "protected" *means* and enforces it uniformly, so a plugin
 * gets every guarantee for free just by returning a descriptor (or a bare
 * `true`). A protected node:
 *   - can't be deleted,
 *   - can't be left blank (its canonical name is restored on blur),
 *   - can't be turned into a to-do,
 *   - can't be marked completed.
 *
 * Each rejected action gives the same feedback: shake the row (`rejectRow`) and
 * toast *why*. The message is the plugin's per-action override, else its general
 * `reason`, else a generic core default -- so even `protects: () => true` is a
 * real, legible block rather than a silent no-op. The plugin overrides the copy
 * only when it cares; the core never depends on it doing so. See ADR 0015.
 */
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { getProtection } from "../plugins/registry";
import type { NodeProtection } from "../plugins/types";
import { rejectRow } from "./flash-node";

/** The actions a protected node forbids. The string also keys the toast id (so
 *  a rapid repeat replaces rather than stacks) and the default-copy table. */
export type ProtectionKind = "delete" | "blank" | "task" | "complete";

// Generic fallback copy the core supplies when the plugin names no reason. A
// plugin overrides per action (`taskReason`, ...) or wholesale (`reason`); these
// only ever surface for a node protected with no copy of its own.
const DEFAULT_REASON: Record<ProtectionKind, string> = {
  delete: "This node is protected and can't be deleted.",
  blank: "This node is protected and needs a name.",
  task: "This node is protected and can't be turned into a to-do.",
  complete: "This node is protected and can't be completed.",
};

/** The message to toast for a rejected `kind` on this protection: the per-action
 *  override, then the general `reason`, then the core default. */
export function protectionMessage(
  protection: NodeProtection,
  kind: ProtectionKind,
): string {
  // `delete` has no dedicated field -- `reason` is its message by convention
  // (it's the prototypical protected action). The rest carry an override.
  const override =
    kind === "blank"
      ? protection.blankReason
      : kind === "task"
        ? protection.taskReason
        : kind === "complete"
          ? protection.completeReason
          : undefined;
  return override ?? protection.reason ?? DEFAULT_REASON[kind];
}

/** Signal a rejected protected action: shake `rowEl` and toast the reason.
 *  Used directly by the blank-heal (which already holds the protection + row);
 *  command handlers go through {@link guardProtected}. */
export function signalRejection(
  rowEl: Element | null,
  protection: NodeProtection,
  kind: ProtectionKind,
): void {
  rejectRow(rowEl);
  toast.error(protectionMessage(protection, kind), { id: `protected-${kind}` });
}

/**
 * Guard a `kind` action on node `id`: if it's protected, shake `rowEl`, toast
 * why, and return `true` (the caller bails). Returns `false` for an unprotected
 * node (proceed). The single chokepoint every protected command flows through --
 * delete, task-conversion, completion -- so the rule lives in one place.
 */
export function guardProtected(
  id: string,
  kind: ProtectionKind,
  rowEl: Element | null,
): boolean {
  const protection = getProtection(id);
  if (!protection) return false;
  signalRejection(rowEl, protection, kind);
  return true;
}

/** The always-on lock signifier on a protected node's row -- and on the zoomed
 *  title, at a larger `size`. Decorative (a quiet marker, not a control), so it
 *  carries a tooltip but no pointer affordance; styling is `.protected-lock`. */
export function ProtectedLock({ size = 12 }: { size?: number }) {
  return (
    <span
      className="protected-lock"
      title="Protected node"
      aria-label="Protected node"
    >
      <Lock size={size} strokeWidth={2.5} />
    </span>
  );
}
