// Highlight plugin (ADR 0035). `==text==` renders as a FOLDING token modelled
// on emphasis (ADR 0025): folded, the fences hide and the run is one atomic
// `<mark>`; revealed (caret within/adjacent), the `==` fences are real, dimmed,
// walk-through text.
//
// COLOR rides IN the source, Lettera-style: an optional leading circle emoji
// (`==🔴urgent==`) names one of six tag-palette colors. Folded, the emoji is
// HIDDEN (the interior renders without it while `data-src` still carries the
// full run, so readSource + the caret math need zero new machinery); revealed,
// it's ordinary text the caret steps through -- backspacing it de-colors the
// run. A bare run is blue. Painting reuses the tags palette's `--tag-*`
// custom properties (mounted globally by TagColorStyles), so highlight colors
// and tag colors can never drift apart.
//
// Pure logic (pattern, parse, build, strip) lives in src/data/highlight.ts.
//
// Seams contributed: A (folding token), B (right-click recolor), C (slash
// command), D (keymap).

import { HighlighterIcon } from "lucide-react";
import {
  HIGHLIGHT_PATTERN,
  parseHighlight,
  type HighlightColor,
} from "../../data/highlight";
import { getViewRootId } from "../../data/view-state";
import { wrapSelectionOrInsert } from "../../components/wrap";
import { definePlugin, type El, type PluginContext } from "../types";
import { openHighlightColorMenu } from "./highlight-color-menu";

const HIGHLIGHT_MARKER = { pre: "==", post: "==" };

// Literal per-color Tailwind utilities (arbitrary values over the tag palette
// vars) so the content scan emits every class. `text-inherit` neutralizes the
// UA's `color: marktext` (which could go black-on-dark); the pastel/dark
// `--tag-*` pair already carries the light/dark split.
const COLOR_CLASS: Record<HighlightColor, string> = {
  red: "bg-[var(--tag-red)]",
  orange: "bg-[var(--tag-orange)]",
  amber: "bg-[var(--tag-amber)]",
  green: "bg-[var(--tag-green)]",
  blue: "bg-[var(--tag-blue)]",
  purple: "bg-[var(--tag-purple)]",
};

const MARK_CLASS =
  "md-highlight text-inherit rounded-[0.25em] px-[0.2em] box-decoration-clone";

// A folded run: one ATOMIC `<mark>` -- fences and color emoji hidden, the full
// source in `data-src`/`data-src-len` (the generic atom shape of ADR 0005, so
// the core's readSource and caret helpers handle it unchanged). `data-highlight`
// carries the color name for the Seam-B recolor selector and e2e.
function foldedHighlightEl(tok: string): El {
  const { color, interior } = parseHighlight(tok);
  return {
    tag: "mark",
    attrs: {
      class: `${MARK_CLASS} ${COLOR_CLASS[color]} cursor-text`,
      "data-highlight": color,
      contenteditable: "false",
      "data-src": tok,
      "data-src-len": tok.length,
    },
    children: [interior],
  };
}

// A revealed run: the `==` fences as dimmed `.md-punct` REAL text and the
// color emoji (when present) as ordinary text, all INSIDE the still-painted
// `<mark>` -- the code-box model (fences live within the container because a
// highlight HAS a visible container), not emphasis's flanking markers.
// Nothing carries `data-src`, so the caret walks through fence and emoji one
// step at a time -- `==🔴|urgent==` is a reachable position, and backspacing
// the emoji de-colors the run.
function revealedHighlightEl(tok: string): El {
  const { color, emoji, interior } = parseHighlight(tok);
  const punct = (s: string): El => ({
    tag: "span",
    attrs: { class: "md-punct" },
    children: [s],
  });
  // The Bear-style color affordance: a text-free highlighter pen (CSS mask,
  // styles.css) right after the opening fence. Zero source length, so the
  // caret math never sees it; clicking it opens the color menu (Seam B).
  const pen: El = {
    tag: "span",
    attrs: {
      class: "highlight-pen-icon",
      "aria-hidden": "true",
      contenteditable: "false",
      title: "Highlight color",
    },
  };
  return {
    tag: "mark",
    attrs: {
      class: `${MARK_CLASS} ${COLOR_CLASS[color]}`,
      "data-highlight": color,
      "data-highlight-reveal": true,
    },
    children: emoji
      ? [punct("=="), pen, emoji, interior, punct("==")]
      : [punct("=="), pen, interior, punct("==")],
  };
}

export default definePlugin({
  id: "highlight",

  // Seam A: one folding token. Precedence 34 sits after the emphasis block
  // (30-33); `=` shares a leading char with nothing, so there's no
  // double-vs-single coupling to order around.
  tokens: [
    {
      id: "highlight",
      pattern: HIGHLIGHT_PATTERN,
      precedence: 34,
      folds: true,
      render: (tok, { revealOffset, start, end }) => {
        const reveal =
          revealOffset != null && revealOffset >= start && revealOffset <= end;
        return reveal ? revealedHighlightEl(tok) : foldedHighlightEl(tok);
      },
    },
  ],

  // Seam B: the revealed run's highlighter pen opens the color menu on a
  // plain click (Bear's flow) -- listed FIRST so the pen wins dispatch over
  // the run itself; its mousedown blocks the caret so the tap doesn't move
  // the selection. Right-click anywhere on a highlight (folded atom OR
  // revealed run) opens the same menu. The folded atom carries the run in
  // `data-src`; a revealed mark's textContent IS the source slice (fences +
  // emoji + interior are all real text inside it; the pen contributes
  // nothing), so both resolve to the same verbatim token.
  interactions: [
    {
      selector: ".highlight-pen-icon",
      blockCaretOnMouseDown: true,
      onClick: (el, ctx, e) => {
        const markEl = el.closest<HTMLElement>("[data-highlight-reveal]");
        const token = markEl?.textContent;
        if (!markEl || !token) return;
        e.preventDefault();
        e.stopPropagation();
        const nodeId =
          markEl.closest<HTMLElement>("[data-node-id]")?.getAttribute(
            "data-node-id",
          ) ?? getViewRootId();
        if (!nodeId) return;
        const rect = markEl.getBoundingClientRect();
        openHighlightColorMenu(
          { nodeId, token, x: rect.left, y: rect.bottom + 6 },
          ctx,
        );
      },
    },
    {
      selector: "mark[data-highlight], [data-highlight-reveal]",
      onContextMenu: (el, ctx, e) => {
        const token =
          el.getAttribute("data-src") ??
          el.closest("[data-highlight-reveal]")?.textContent;
        if (!token) return;
        e.preventDefault();
        e.stopPropagation();
        // Row id, or the zoom root when the run lives in the zoomed title.
        const nodeId =
          el.closest<HTMLElement>("[data-node-id]")?.getAttribute(
            "data-node-id",
          ) ?? getViewRootId();
        if (!nodeId) return;
        openHighlightColorMenu(
          { nodeId, token, x: e.clientX, y: e.clientY },
          ctx,
        );
      },
    },
  ],

  // Seam C: `/highlight` wraps the selection (or inserts an empty pair) in the
  // bare `==` fence -- the default blue; recoloring is the right-click menu.
  commands: [
    {
      id: "highlight",
      label: "Highlight",
      description: "Wrap in ==highlight==",
      icon: HighlighterIcon,
      keywords: ["highlight", "mark", "color", "format", "markdown", "style"],
      available: () => true,
      // Wrap is caret/selection-scoped -- excluded from the Cmd+K command
      // center, which has no live caret (ADR 0034).
      caretScoped: true,
      run: (nodeId: string, ctx: PluginContext) =>
        wrapSelectionOrInsert(
          nodeId,
          HIGHLIGHT_MARKER,
          ctx.mutations.onTextChange,
        ),
    },
  ],

  // Seam D: Mod+Shift+H (Notion's highlight binding; free of the reserved-key
  // denylist and of every browser contentEditable default).
  keymap: [
    {
      id: "highlight",
      hotkey: "Mod+Shift+H",
      run: (nodeId: string, ctx: PluginContext) =>
        wrapSelectionOrInsert(
          nodeId,
          HIGHLIGHT_MARKER,
          ctx.mutations.onTextChange,
        ),
    },
  ],
});
