import type { ComponentType } from "react";

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
import { ShieldIcon } from "lucide-react";
import { toast } from "sonner";

import type { NodeProtection } from "../plugins/types";

import {
  isNodeLocked,
  orphanedMirrorsBy,
  subtreeContainsLocked,
  type TreeIndex,
} from "../data/tree";
import { getProtection } from "../plugins/registry";
import { rejectRow } from "./flash-node";

/** The actions a protected node forbids. The string also keys the toast id (so
 *  a rapid repeat replaces rather than stacks) and the default-copy table. */
export type ProtectionKind = "delete" | "blank" | "task" | "complete";

// Generic fallback copy the core supplies when the plugin names no reason. A
// plugin overrides per action (`taskReason`, ...) or wholesale (`reason`); these
// only ever surface for a node protected with no copy of its own.
const DEFAULT_REASON = {
  delete: "This node is protected and can't be deleted.",
  blank: "This node is protected and needs a name.",
  task: "This node is protected and can't be turned into a to-do.",
  complete: "This node is protected and can't be completed.",
} satisfies Record<ProtectionKind, string>;

/** The message to toast for a rejected `kind` on this protection: the per-action
 *  override, then the general `reason`, then the core default. */
function protectionMessage(
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

/** Immediate editor guard for authored mutations. The Durable Object repeats
 * the check authoritatively; this owns legible local feedback. */
export function guardLocked(
  index: TreeIndex,
  id: string,
  rowEl: Element | null,
): boolean {
  if (!isNodeLocked(index, id)) return false;
  rejectRow(rowEl);
  toast.error("This subtree is locked. Unlock it before editing.", {
    id: "node-locked",
  });
  return true;
}

/** Deleting an unlocked ancestor is also blocked when its subtree contains
 * locked content. */
export function guardLockedDelete(
  index: TreeIndex,
  ids: readonly string[],
  rowEl: Element | null,
): boolean {
  if (!subtreeContainsLocked(index, ids)) return false;
  rejectRow(rowEl);
  toast.error("Unlock the protected subtree before deleting it.", {
    id: "node-locked-delete",
  });
  return true;
}

/**
 * Guard a delete of `ids` (and their subtrees): if any is a mirror SOURCE whose
 * instances would be orphaned, shake `rowEl`, toast why, and return `true` (the
 * caller bails). Returns `false` when nothing is orphaned (proceed). Deleting a
 * source would strand its live mirrors -- promote-on-delete is Stage 3 (ADR
 * 0022), so v1 blocks rather than orphans. FLAG-GATED at the call site: off the
 * mirrors flag a `mirrorOf` node is just a normal node, so this is never called.
 */
export function guardMirrorSourceDelete(
  index: TreeIndex,
  ids: string[],
  rowEl: Element | null,
): boolean {
  const n = orphanedMirrorsBy(index, ids).length;
  if (n === 0) return false;
  rejectRow(rowEl);
  toast.error(
    `Can't delete: ${n} mirror${n === 1 ? "" : "s"} point here. Delete ${
      n === 1 ? "it" : "them"
    } first.`,
    { id: "mirror-source-delete" },
  );
  return true;
}

/** The always-on signifier on a protected or locked node's row -- and on the
 *  zoomed title, at a larger `size`. Decorative (a quiet marker, not a control),
 *  so it carries a tooltip but no pointer affordance. */
export function ProtectionIndicator({
  size = 12,
  label = "Protected node",
  icon: Icon = ShieldIcon,
}: {
  size?: number;
  label?: string;
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
}) {
  return (
    <span className="protection-indicator" title={label} aria-label={label}>
      <Icon size={size} strokeWidth={2.5} />
    </span>
  );
}
