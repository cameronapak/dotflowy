// Todos plugin (ADR 0018). Completion is the todo plugin's concept (D9): a plain
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
import { definePlugin, type PluginContext } from "../types";

// Toggle completion on a node, shared by Mod+Enter and Mod+D. Reads the live
// node off the tree so it flips relative to the current state.
function toggleCompletion(nodeId: string, ctx: PluginContext) {
  const node = ctx.tree.byId.get(nodeId);
  if (!node) return;
  ctx.mutations.onToggleCompleted(nodeId, !node.completed);
}

export default definePlugin({
  id: "todos",

  // Seam F: the checkbox, rendered between the bullet dot and the text on a
  // task. Returns null for a plain bullet (no checkbox). The handler reads ctx
  // lazily (getCtx) so nothing is allocated at render time.
  slots: [
    {
      id: "todo-checkbox",
      position: "row:before-text",
      render: (node, getCtx) =>
        node.isTask ? (
          <Checkbox
            className="checkbox touch-hitbox border-muted-foreground"
            checked={node.completed}
            onCheckedChange={(checked) =>
              getCtx().mutations.onToggleCompleted(node.id, checked)
            }
          />
        ) : null,
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
