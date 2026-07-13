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
// Backspace-on-the-checkbox demotion read `completed`/`isTask` in OutlineRow --
// they await a row-decoration / reserved-key seam.

import { ListIcon, SquareCheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Checkbox } from "@/plugins/kit";

import { capture } from "../../data/history";
import { setIsTask } from "../../data/mutations";
import { runStructural } from "../../data/structural";
import { type Node } from "../../data/tree";
import { isProtected } from "../registry";
import { definePlugin, type PluginContext } from "../types";

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
  // `kind` outranks `isTask` (ADR 0045): if a stale client or a raw PATCH ever
  // writes the illegal pair, the node renders as a paragraph with no checkbox,
  // and the next kind-touching edit normalizes it.
  if (node.kind === "paragraph" || !node.isTask) return null;
  return (
    <Checkbox
      className={cn(
        "checkbox touch-hitbox border-muted-foreground",
        // Larger control + a little more breathing room next to the 24px title
        // (the title's flex gap alone reads tight at that text size).
        placement === "title" && "me-1 size-5",
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
      // Node multi-selection (ADR 0018): turn every selected root into a task in
      // ONE batch -- a single undo step, one DO frame (runStructural). Skips
      // nodes already a task (a redundant write) and protected ones (the daily
      // container can't become a to-do, mirroring the single-node guard); if
      // nothing qualifies it's a clean no-op.
      runMany: (ids, ctx) => {
        const targets = ids.filter((id) => {
          const n = ctx.tree.byId.get(id);
          return !!n && !n.isTask && !isProtected(id);
        });
        if (targets.length === 0) return;
        runStructural(() => {
          capture(ctx.tree, targets[0]!);
          for (const id of targets) setIsTask(id, true);
        });
      },
    },
    {
      id: "bullet",
      label: "Bullet",
      description: "Turn into a plain bullet",
      icon: ListIcon,
      keywords: ["bullet", "plain", "text", "list", "into"],
      // The single "back to a plain bullet, whatever you were" command: it
      // offers itself to a task AND to a paragraph, and `onSetTask` clears both
      // fields on the way through (ADR 0045). There is no `/paragraph`-off.
      available: (node) => node.isTask || node.kind === "paragraph",
      run: (id, ctx) => ctx.mutations.onSetTask(id, false),
    },
  ],

  // Seam I: typing `[]`, `[ ]` or `[x]` at the very start of a plain bullet
  // turns it into a task and strips the marker (mirrors the
  // Backspace-on-the-checkbox demotion, which stays core for now). The core
  // writes the stripped text and places the caret; this only decides the
  // rewrite + the type flip.
  //
  // The `[x]` spelling exists so the SAME markdown a paste understands is also
  // typeable: todos speak markdown at every boundary a user or agent can touch
  // (paste, Copy as Markdown, OPML, MCP), even though the `isTask`/`completed`
  // FIELDS remain the storage (ADR 0044: markdown is the interchange format for
  // node state, never its storage).
  input: {
    autoformat: ({ text, node }) => {
      if (node.isTask) return null;
      const marker = text.match(/^\[( |x|X)?\] ?/);
      if (!marker) return null;
      const done = marker[1]?.toLowerCase() === "x";
      return {
        text: text.slice(marker[0].length),
        // The stripped marker sat at the start, so the caret lands there.
        caret: 0,
        before: (ctx) => {
          ctx.mutations.onSetTask(node.id, true);
          if (done) ctx.mutations.onToggleCompleted(node.id, true);
        },
      };
    },
  },

  // Query filter (ADR 0047 §4): `is:complete`. Completion is the todos plugin's
  // concept (D9), so the operator that reads it lives here too -- registered
  // beside the core `is:todo|bullet|paragraph|mirror`, sharing the `is` key
  // without collision (the guard is on the (key, value) pair).
  filterOperators: [
    {
      key: "is",
      values: ["complete"],
      description: "Filter to completed nodes",
      predicate: (node) => node.completed,
    },
  ],
});
