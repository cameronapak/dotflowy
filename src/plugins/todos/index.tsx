// Todos plugin (ADR 0001). Completion is the todo plugin's concept (D9): a plain
// outline is just nestable text; installing this plugin is what makes nodes
// completable -- it grants the checkbox, hide-completed, the toggle keys, the
// `/todo` command, and the `[]` autoformat. The `completed`/`isTask` FIELDS stay
// node slots for hot-path speed (D9's named exception), but their meaning, UI,
// transforms, and input shortcuts all live here. This supersedes ADR 0001/0002's
// "core owns checkboxes" framing: the data slots remain, the behavior is a plugin.
//
// Seams contributed: F (checkbox row slot), G (hide-completed view transform),
// D (Mod+Enter / Mod+D toggle), C (`/todo` + `/bullet`), I (`[]` autoformat).
// Still core-wired (next passes): the fade-inheritance cascade and the
// Backspace-on-the-checkbox demotion read `completed`/`isTask` in OutlineNode --
// they await a row-decoration / reserved-key seam.

import { ListIcon, SquareCheckIcon } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { definePlugin, type PluginContext } from "../types";
import { type Node } from "../../data/tree";

// Toggle completion on a node, shared by Mod+Enter and Mod+D. Reads the live
// node off the tree so it flips relative to the current state.
function toggleCompletion(nodeId: string, ctx: PluginContext) {
  const node = ctx.tree.byId.get(nodeId);
  if (!node) return;
  ctx.mutations.onToggleCompleted(nodeId, !node.completed);
}

// Seam F: the checkbox, before the text on a task. Rendered in two homes -- the
// list bullet (`placement="row"`) and the zoomed page title (`placement="title"`).
// Unlike the daily badge, the checkbox is NOT size-constant across the two: the
// title text is a 24px h2, so a compact 16px control reads as undersized next to
// it; the title checkbox scales up to sit with the larger text (the row keeps the
// compact one). Null on a plain bullet. The handler reads ctx lazily (getCtx) so
// nothing is allocated at render time.
function TaskCheckbox({
  node,
  getCtx,
  placement,
}: {
  node: Node;
  getCtx: () => PluginContext;
  placement: "row" | "title";
}) {
  if (!node.isTask) return null;
  return (
    <Checkbox
      className={cn(
        "checkbox touch-hitbox border-muted-foreground",
        // Larger control + a little more breathing room next to the 24px title
        // (the title's flex gap alone reads tight at that text size).
        placement === "title" && "size-5 me-1",
      )}
      checked={node.completed}
      onCheckedChange={(checked) =>
        getCtx().mutations.onToggleCompleted(node.id, checked)
      }
    />
  );
}

export default definePlugin({
  id: "todos",

  // Seam F: the checkbox, before the text on a task -- between the dot and the
  // text on a list bullet, and leading the page title when zoomed in. See
  // TaskCheckbox for the per-placement sizing.
  slots: [
    {
      id: "todo-checkbox",
      position: "row:before-text",
      render: (node, getCtx) => (
        <TaskCheckbox node={node} getCtx={getCtx} placement="row" />
      ),
    },
    {
      id: "todo-checkbox-title",
      position: "title:before-text",
      render: (node, getCtx) => (
        <TaskCheckbox node={node} getCtx={getCtx} placement="title" />
      ),
    },
  ],

  // Seam G: when show-completed is off, a completed bullet (and its whole
  // subtree) drops out of the render. The core ORs this into the composed
  // `isHidden` predicate; `useVisibleChildIds` and the tag filter both apply it,
  // so neither hardcodes `completed` any longer (D9).
  viewTransforms: [
    {
      id: "hide-completed",
      hidesNode: (node, ctx) => !ctx.showCompleted && node.completed,
    },
  ],

  // Seam D: Cmd/Ctrl+Enter and Cmd/Ctrl+D both toggle completion on the focused
  // node. Every bullet is completable (not just tasks). Wired on the bullet AND
  // the zoomed title, so the keys work wherever a node is focused.
  keymap: [
    {
      id: "toggle-completed-enter",
      hotkey: "Mod+Enter",
      run: toggleCompletion,
    },
    { id: "toggle-completed-d", hotkey: "Mod+D", run: toggleCompletion },
  ],

  // Seam C: turn a bullet into a task or back into a plain bullet. Each hides
  // itself once it no longer applies (`available`), so only the relevant one
  // shows. `/move` stays a core command (it's structural, not a todo concept).
  commands: [
    {
      id: "todo",
      label: "To-do",
      description: "Turn into a To-do",
      icon: SquareCheckIcon,
      keywords: ["todo", "task", "checkbox", "check", "done", "into"],
      available: (node) => !node.isTask,
      run: (id, ctx) => ctx.mutations.onSetTask(id, true),
    },
    {
      id: "bullet",
      label: "Bullet",
      description: "Turn into a plain bullet",
      icon: ListIcon,
      keywords: ["bullet", "plain", "text", "list", "into"],
      available: (node) => node.isTask,
      run: (id, ctx) => ctx.mutations.onSetTask(id, false),
    },
  ],

  // Seam I: typing `[]` or `[ ]` at the very start of a plain bullet turns it
  // into a task and strips the marker (mirrors the Backspace-on-the-checkbox
  // demotion, which stays core for now). The core writes the stripped text and
  // places the caret; this only decides the rewrite + the type flip.
  input: {
    autoformat: ({ text, node }) => {
      if (node.isTask) return null;
      const marker = text.match(/^\[ ?\] ?/);
      if (!marker) return null;
      return {
        text: text.slice(marker[0].length),
        // The stripped marker sat at the start, so the caret lands there.
        caret: 0,
        before: (ctx) => ctx.mutations.onSetTask(node.id, true),
      };
    },
  },
});
