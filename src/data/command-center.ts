import type { ComponentType } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CircleCheckIcon,
  CircleIcon,
  GitForkIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  MaximizeIcon,
  MoveIcon,
  Trash2Icon,
} from "lucide-react";
import type { Node, TreeIndex } from "./tree";
import { childrenOf } from "./tree";
import { isMirrorsEnabled } from "./flags";
import { getViewRootId } from "./view-state";
import { commandSpecs } from "../plugins/registry";
import type { NodeActionBridge } from "./command-bridge";

/**
 * Command center (ADR 0034): the ONE unified row descriptor the Cmd+K palette
 * renders, aggregated from the existing action models by thin adapters (bridge,
 * NOT a spine -- `CommandSpec` / `NodeCommands` / the More menu are untouched).
 *
 * The shape is `MenuListItem`-compatible (`id/label/description/icon`) so it
 * renders through the same look as the slash + selection menus, plus:
 * - `scope` -- "node" actions run against a target (ambient or a picked result);
 *   "global" actions are zero-arg. Drives grouping + the "Acting on:" header.
 * - `keywords` -- extra fuzzy-match terms for the Actions group.
 * - `hotkey` -- DISPLAY hint as individual key caps (rendered right-aligned in a
 *   `KbdGroup`); the actual binding lives in the paired keymap, not here.
 * - `run` -- already BOUND (node actions capture their target id at build time),
 *   so the switcher just calls it.
 */
/**
 * The ambient node target captured when Cmd+K opens (ADR 0034, #83). The
 * focused bullet wins; else the zoom root when zoomed; else none (home view).
 * `focusedNodeId` must be read in the capture-phase keydown BEFORE the dialog
 * steals focus. Multi-select ambient (`runMany`) is deferred in v1 -- the
 * selection actions menu already covers an active selection on-screen.
 */
export function resolveAmbientTargetId(
  focusedNodeId: string | null,
): string | null {
  if (focusedNodeId) return focusedNodeId;
  return getViewRootId();
}

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
  run: () => void;
}

/**
 * The node-verb adapter: the core `NodeCommands` verbs that make sense as
 * whole-node palette actions, bound to `node.id`. Input/caret/pointer plumbing
 * (`onTextChange`, `onEnter`, `onMoveFocus`, `onBullet*`) is NOT a command.
 *
 * `onSetTask` is intentionally omitted -- the todos plugin's `CommandSpec` owns
 * "To-do"/"Bullet" (it has `available` gating), and surfacing the raw verb too
 * would double the row (ADR 0034 de-dup: plugin CommandSpec wins over the core
 * verb). Actions that keep the node alive bake a `focusNode` into their `run`
 * so the caret returns to the bullet after the overlay closes (ADR 0033/0034);
 * Delete / Zoom / the Move+Mirror dialogs deliberately don't.
 */
export function buildNodeVerbActions(
  node: Node,
  index: TreeIndex,
  bridge: NodeActionBridge,
): CommandCenterAction[] {
  const { commands, focusNode } = bridge;
  const id = node.id;
  const hasChildren = childrenOf(index, id).length > 0;
  const actions: CommandCenterAction[] = [
    {
      id: "node:indent",
      label: "Indent",
      description: "Nest under the previous sibling",
      icon: IndentIncreaseIcon,
      scope: "node",
      keywords: ["indent", "nest", "demote"],
      hotkey: ["Tab"],
      run: () => {
        commands.onIndent(id);
        focusNode(id);
      },
    },
    {
      id: "node:outdent",
      label: "Outdent",
      description: "Lift out to the parent's level",
      icon: IndentDecreaseIcon,
      scope: "node",
      keywords: ["outdent", "unnest", "promote"],
      hotkey: ["⇧", "Tab"],
      run: () => {
        commands.onOutdent(id);
        focusNode(id);
      },
    },
    {
      id: "node:move-up",
      label: "Move up",
      description: "Reorder above the previous sibling",
      icon: ArrowUpIcon,
      scope: "node",
      keywords: ["move", "up", "reorder"],
      hotkey: ["⌘", "⇧", "↑"],
      run: () => {
        commands.onMoveUp(id);
        focusNode(id);
      },
    },
    {
      id: "node:move-down",
      label: "Move down",
      description: "Reorder below the next sibling",
      icon: ArrowDownIcon,
      scope: "node",
      keywords: ["move", "down", "reorder"],
      hotkey: ["⌘", "⇧", "↓"],
      run: () => {
        commands.onMoveDown(id);
        focusNode(id);
      },
    },
    {
      id: "node:complete",
      label: node.completed ? "Mark incomplete" : "Complete",
      description: node.completed
        ? "Clear this bullet's done state"
        : "Mark this bullet done",
      icon: node.completed ? CircleIcon : CircleCheckIcon,
      scope: "node",
      keywords: ["complete", "done", "check", "todo"],
      run: () => {
        commands.onToggleCompleted(id, !node.completed);
        focusNode(id);
      },
    },
  ];

  if (hasChildren) {
    actions.push({
      id: "node:collapse",
      label: node.collapsed ? "Expand" : "Collapse",
      description: node.collapsed
        ? "Show this bullet's children"
        : "Hide this bullet's children",
      icon: node.collapsed ? ChevronsUpDownIcon : ChevronsDownUpIcon,
      scope: "node",
      keywords: ["collapse", "expand", "fold", "unfold"],
      run: () => {
        commands.onToggleCollapsed(id, !node.collapsed);
        focusNode(id);
      },
    });
  }

  actions.push({
    id: "node:move-to",
    label: "Move to…",
    description: "Move this bullet under another node",
    icon: MoveIcon,
    scope: "node",
    keywords: ["move", "reparent", "relocate"],
    run: () => commands.onRequestMove(id),
  });

  if (isMirrorsEnabled()) {
    actions.push({
      id: "node:mirror-to",
      label: "Mirror to…",
      description: "Create a live mirror under another node",
      icon: GitForkIcon,
      scope: "node",
      keywords: ["mirror", "reference", "clone"],
      run: () => commands.onRequestMirror(id),
    });
  }

  actions.push({
    id: "node:zoom",
    label: "Zoom in",
    description: "Make this bullet the temporary root",
    icon: MaximizeIcon,
    scope: "node",
    keywords: ["zoom", "focus", "root"],
    run: () => commands.onZoom(id),
  });

  actions.push({
    id: "node:delete",
    label: "Delete",
    description: "Delete this bullet and its subtree",
    icon: Trash2Icon,
    scope: "node",
    keywords: ["delete", "remove", "trash"],
    run: () => commands.onDeleteNode(id),
  });

  return actions;
}

/**
 * The plugin-`CommandSpec` adapter: whole-node commands that opt IN to the
 * palette by NOT being `caretScoped` (ADR 0034 -- emphasis wrap is excluded, it
 * needs the live caret the overlay steals). Gated by each spec's own
 * `available(node)`. `run` is bound to the target id + the live PluginContext.
 */
export function buildCommandSpecActions(
  node: Node,
  bridge: NodeActionBridge,
): CommandCenterAction[] {
  const { getCtx } = bridge;
  const out: CommandCenterAction[] = [];
  for (const spec of commandSpecs) {
    if (spec.caretScoped) continue;
    if (!spec.available(node)) continue;
    out.push({
      id: `cmd:${spec.id}`,
      label: spec.label,
      description: spec.description,
      icon: spec.icon,
      scope: "node",
      keywords: spec.keywords,
      run: () => spec.run(node.id, getCtx()),
    });
  }
  return out;
}

/**
 * Every node-scoped action for one target node -- core verbs then plugin
 * commands. Returns `[]` when there's no live editor bridge (e.g. the login
 * screen) or the node is gone, so the switcher can treat "no ambient block" and
 * "no bridge" the same.
 */
export function buildNodeActions(
  nodeId: string,
  index: TreeIndex,
  bridge: NodeActionBridge | null,
): CommandCenterAction[] {
  if (!bridge) return [];
  const node = index.byId.get(nodeId);
  if (!node) return [];
  return [
    ...buildNodeVerbActions(node, index, bridge),
    ...buildCommandSpecActions(node, bridge),
  ];
}
