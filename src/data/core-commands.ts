import {
  AlignLeftIcon,
  CopyPlusIcon,
  CornerUpRightIcon,
  LockIcon,
  Trash2Icon,
  UnlockIcon,
} from "lucide-react";

import type { CommandSpec } from "../plugins/types";

import { waitForPendingWrites } from "./api";
import { isMirrorsEnabled } from "./flags";
import { capture } from "./history";
import { setKind, setLocked } from "./mutations";
import { runStructural } from "./structural";
import { isNodeInheritedLocked, isNodeLocked, trueSourceOf } from "./tree";

/**
 * `/paragraph` is CORE, not a plugin (ADR 0045): the paragraph glyph is core's
 * own glyph on core's own field, the same way fade-inheritance reads `completed`. A
 * `paragraphs/` plugin that couldn't own its signifier would be a folder with one
 * command in it.
 *
 * Whole-node (no `caretScoped`), so the Cmd+K command center picks it up through
 * `buildCommandSpecActions`; `runMany` puts it in the node-selection actions menu
 * (ADR 0018). Both surfaces read this one spec, so the three palettes can't drift.
 *
 * There is no `/paragraph`-off: `/bullet` (the todos plugin's) is the single
 * "back to a plain bullet, whatever you were" command, and `setIsTask` clears
 * `kind` on the way through.
 */
export const paragraphCommand: CommandSpec = {
  id: "paragraph",
  label: "Paragraph",
  description: "Turn into a paragraph",
  icon: AlignLeftIcon,
  keywords: ["paragraph", "prose", "text", "note", "into"],
  available: (node) => node.kind !== "paragraph",
  run: (id, ctx) => ctx.mutations.onSetKind(id, "paragraph"),
  // Node multi-selection: convert every selected root in ONE batch -- a single
  // undo step, one DO frame. The todos To-do shape, minus its `isProtected`
  // filter: To-do skips protected nodes because ADR 0015 BLOCKS the single-node
  // `/todo` on them, and the batch must agree with it. Nothing blocks
  // `/paragraph` (a paragraph is still a plain text node -- none of the four
  // protected rules are delete, blank, to-do, or complete), so filtering here
  // would invent a fifth rule that the single-node path doesn't enforce.
  // Already-paragraph nodes are skipped as a redundant write; an empty run
  // no-ops cleanly.
  runMany: (ids, ctx) => {
    const targets = ids.filter((id) => {
      const n = ctx.tree.byId.get(id);
      return !!n && n.kind !== "paragraph";
    });
    if (targets.length === 0) return;
    runStructural(() => {
      capture(ctx.tree, targets[0]!);
      for (const id of targets) setKind(id, "paragraph");
    });
  },
};

export const lockCommand: CommandSpec = {
  id: "lock",
  label: "Lock",
  description: "Prevent changes inside this subtree",
  icon: LockIcon,
  keywords: ["lock", "protect", "readonly", "freeze"],
  available: (_node, ctx) => !!ctx && !isNodeLocked(ctx.tree, _node.id),
  run: (id, ctx) => {
    void waitForPendingWrites().then(() => ctx.mutations.onSetLocked(id, true));
  },
  runMany: (ids, ctx) => {
    const sources = [
      ...new Set(
        ids
          .filter((id) => !isNodeLocked(ctx.tree, id))
          .map((id) => trueSourceOf(ctx.tree, id)),
      ),
    ];
    if (sources.length === 0) return;
    void waitForPendingWrites().then(() => {
      runStructural(() => {
        for (const id of sources) setLocked(id, true);
      });
    });
  },
};

export const unlockCommand: CommandSpec = {
  id: "unlock",
  label: "Unlock",
  description: "Allow changes inside this subtree",
  icon: UnlockIcon,
  keywords: ["unlock", "edit", "unprotect"],
  available: (node, ctx) => {
    if (!ctx) return node.locked;
    return (
      !!ctx.tree.byId.get(trueSourceOf(ctx.tree, node.id))?.locked &&
      !isNodeInheritedLocked(ctx.tree, node.id)
    );
  },
  run: (id, ctx) => {
    void waitForPendingWrites().then(() =>
      ctx.mutations.onSetLocked(id, false),
    );
  },
  runMany: (ids, ctx) => {
    const sources = [
      ...new Set(
        ids
          .map((id) => trueSourceOf(ctx.tree, id))
          .filter(
            (id) =>
              ctx.tree.byId.get(id)?.locked &&
              !isNodeInheritedLocked(ctx.tree, id),
          ),
      ),
    ];
    if (sources.length === 0) return;
    void waitForPendingWrites().then(() => {
      runStructural(() => {
        for (const id of sources) setLocked(id, false);
      });
    });
  },
};

/**
 * The core's own slash commands. Move, Mirror, and Delete are structural (they
 * relink or prune the tree), not feature concepts, so they stay core; feature
 * commands (`/todo`, `/bullet`) are the todos plugin's, registered via Seam C.
 * Paragraph leads: it's a contextual type-change command, so it belongs beside
 * To-do/Bullet rather than trailing with the destination pickers. Delete trails
 * last -- it's the one destructive verb, so it should never be the top match.
 */
export const CORE_COMMANDS: CommandSpec[] = [
  paragraphCommand,
  lockCommand,
  unlockCommand,
  {
    id: "move",
    label: "Move",
    description: "Move under another node",
    icon: CornerUpRightIcon,
    keywords: ["move", "reparent", "under", "into", "relocate", "home"],
    available: () => true,
    run: (id, ctx) => ctx.mutations.onRequestMove(id),
  },
  // Mirror is structural like Move (it relinks the tree), so it stays core too.
  // Hidden until the mirrors feature flag is on (ADR 0022) -- a mirror-free
  // build never offers it. Opens the SAME destination picker, in mirror mode.
  {
    id: "mirror",
    label: "Mirror to",
    description: "Show a live copy under another node",
    icon: CopyPlusIcon,
    keywords: ["mirror", "synced", "instance", "alias", "reference", "clone"],
    available: () => isMirrorsEnabled(),
    run: (id, ctx) => ctx.mutations.onRequestMirror(id),
  },
  // Delete is the fourth surface for removing a node -- the bullet keymap
  // (Backspace), the Cmd+K `node:delete` verb, and the selection menu already
  // cover it; this puts it in the `/` palette too. It delegates to the ONE
  // delete funnel (`onDeleteNode`), so it inherits protection guards, the
  // mirror-source guard, the big-subtree confirm dialog, the atomic
  // `runStructural` batch, and neighbor-focus for free (ADR 0009/0015/0022). A
  // protected node (the daily container) shakes + toasts rather than deleting,
  // exactly as Backspace does, so `available` stays true -- hiding the command
  // would swap a legible block for a silent absence. No `runMany`: the selection
  // actions menu wires its own Delete (`ops.remove`), the Move/Mirror precedent.
  {
    id: "delete",
    label: "Delete",
    description: "Delete this node and its subtree",
    icon: Trash2Icon,
    keywords: ["delete", "remove", "trash", "destroy"],
    available: () => true,
    run: (id, ctx) => ctx.mutations.onDeleteNode(id),
  },
];
