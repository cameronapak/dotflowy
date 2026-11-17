// Highlight plugin (ADR 0035). `==text==` renders as a FOLDING token modelled
// on emphasis (ADR 0025): folded, the fences hide and the run is one atomic
// `<mark>`; revealed (caret within/adjacent), the `==` fences are real, dimmed,
// walk-through text.
//
// COLOR rides IN the source, Lettera-style: an optional leading circle emoji
// (`==🔴urgent==`) names one of six tag-palette colors. The emoji is NEVER
// displayed -- it's an export/interchange encoding, not editor chrome. Folded,
// the interior renders without it while `data-src` carries the full run;
// revealed, the pen affordance is its atom (data-src = the emoji), so
// readSource + copy/export still round-trip `==🔴urgent==`. Color is chosen
// via the pen's menu (or right-click); a bare run is blue. Painting reuses
// the tags palette's `--tag-*` custom properties (mounted globally by
// TagColorStyles), so highlight colors and tag colors can never drift apart.
//
// Pure logic (pattern, parse, build, strip) lives in src/data/highlight.ts.
//
// Seams contributed: A (folding token), B (pen-click + right-click recolor),
// C (slash command), D (keymap).

import { HighlighterIcon } from "@/lib/icons";

import { readSource } from "../../components/inline-code";
import { wrapSelectionOrInsert } from "../../components/wrap";
import {
  HIGHLIGHT_PATTERN,
  parseHighlight,
  type HighlightColor,
} from "../../data/highlight";
import { isRevealed, mdPunct, resolveNodeId } from "../token-kit";
import {
  definePlugin,
  type El,
  type PluginContext,
  type TokenView,
} from "../types";
import { HIGHLIGHT_FILTER_OPERATORS } from "./filter-operators";
import { openHighlightColorMenu } from "./highlight-color-menu";

const HIGHLIGHT_MARKER = { pre: "==", post: "==" };

// Literal per-color utilities so the content scan emits every class. Share
// the fill with inner chips and its matching ink with concealed spoilers.
// `text-inherit` neutralizes the UA's `color: marktext` (black-on-dark);
// the `--tag-*` palette already carries the light/dark split.
const COLOR_CLASS = {
  red: "[--highlight-bg:var(--tag-red)] [--highlight-fg:var(--tag-red-fg)]",
  orange:
    "[--highlight-bg:var(--tag-orange)] [--highlight-fg:var(--tag-orange-fg)]",
  yellow:
    "[--highlight-bg:var(--tag-yellow)] [--highlight-fg:var(--tag-yellow-fg)]",
  green:
    "[--highlight-bg:var(--tag-green)] [--highlight-fg:var(--tag-green-fg)]",
  blue: "[--highlight-bg:var(--tag-blue)] [--highlight-fg:var(--tag-blue-fg)]",
  purple:
    "[--highlight-bg:var(--tag-purple)] [--highlight-fg:var(--tag-purple-fg)]",
} satisfies Record<HighlightColor, string>;

const MARK_CLASS =
  "md-highlight [--tag-ink-lightness:var(--highlight-tag-ink-lightness)] bg-(--highlight-bg) text-inherit rounded-[0.25em] px-[0.2em] box-decoration-clone";

// A folded run: one ATOMIC `<mark>` -- fences and color emoji hidden, the full
// source in `data-src`/`data-src-len` (the generic atom shape of ADR 0005, so
// the core's readSource and caret helpers handle it unchanged). `data-highlight`
// carries the color name for the Seam-B recolor selector and e2e.
function foldedHighlightEl(tok: string, view: TokenView): El {
  const { color, emoji, interior } = parseHighlight(tok);
  return {
    tag: "mark",
    attrs: {
      class: `${MARK_CLASS} ${COLOR_CLASS[color]} cursor-text`,
      "data-highlight": color,
      contenteditable: "false",
      "data-src": tok,
      "data-src-len": tok.length,
    },
    children: view.renderInline(
      interior,
      view.start + 2 + (emoji?.length ?? 0),
    ),
  };
}

// A revealed run: the `==` fences as dimmed `.md-punct` REAL text INSIDE the
// still-painted `<mark>` -- the code-box model (fences live within the
// container because a highlight HAS a visible container), not emphasis's
// flanking markers. The color emoji is NEVER visible, even revealed: the pen
// affordance IS its atom (`data-src` = the emoji), exactly the revealed
// link's url-chip pattern (ADR 0005) -- readSource reconstructs the full run
// and the caret jumps over the pen as one 2-unit step, so copy/export still
// yields `==🔴urgent==` while the editor shows only `==urgent==` behind a
// pen. Backspacing the pen atom deletes the emoji -> de-colors the run. On a
// bare (default-color) run the pen carries no source and is caret-invisible.
function revealedHighlightEl(tok: string, view: TokenView): El {
  const { color, emoji, interior } = parseHighlight(tok);
  const pen: El = {
    tag: "span",
    attrs: {
      class: "highlight-pen-icon",
      "aria-hidden": "true",
      contenteditable: "false",
      title: "Highlight color",
      "data-src": emoji ?? undefined,
      "data-src-len": emoji ? emoji.length : undefined,
    },
  };
  return {
    tag: "mark",
    attrs: {
      class: `${MARK_CLASS} ${COLOR_CLASS[color]}`,
      "data-highlight": color,
      "data-highlight-reveal": true,
    },
    children: [
      mdPunct("=="),
      pen,
      ...view.renderInline(interior, view.start + 2 + (emoji?.length ?? 0)),
      mdPunct("=="),
    ],
  };
}

export default definePlugin({
  id: "highlight",

  // Seam A: one folding token. Precedence 35 follows balanced emphasis (30).
  // `=` shares a leading char with no other token.
  tokens: [
    {
      id: "highlight",
      pattern: HIGHLIGHT_PATTERN,
      precedence: 35,
      folds: true,
      formatting: true,
      render: (tok, view) =>
        isRevealed(view)
          ? revealedHighlightEl(tok, view)
          : foldedHighlightEl(tok, view),
    },
  ],

  // Seam B: the revealed run's highlighter pen opens the color menu on a
  // plain click (Bear's flow) -- listed FIRST so the pen wins dispatch over
  // the run itself; its mousedown blocks the caret so the tap doesn't move
  // the selection. Right-click anywhere on a highlight (folded atom OR
  // revealed run) opens the same menu. The folded atom carries the run in
  // `data-src`; readSource reconstructs a revealed mark from its fences,
  // the pen's hidden emoji, and any folded inner tokens.
  interactions: [
    {
      selector: ".highlight-pen-icon",
      blockCaretOnMouseDown: true,
      onClick: (el, ctx, e) => {
        const markEl = el.closest<HTMLElement>("[data-highlight-reveal]");
        // readSource, not textContent: the pen atom carries the hidden color
        // emoji in its data-src, so the walk reconstructs the full run.
        const token = markEl ? readSource(markEl) : null;
        if (!markEl || !token) return;
        e.preventDefault();
        e.stopPropagation();
        const nodeId = resolveNodeId(markEl);
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
        // Folded: the atom's own data-src. Revealed: a readSource walk (the
        // pen atom inside carries the hidden emoji).
        const reveal = el.closest<HTMLElement>("[data-highlight-reveal]");
        const token =
          el.getAttribute("data-src") ?? (reveal ? readSource(reveal) : null);
        if (!token) return;
        e.preventDefault();
        e.stopPropagation();
        // Row id, or the zoom root when the run lives in the zoomed title.
        const nodeId = resolveNodeId(el);
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

  // Query filter (ADR 0047 §4): `highlight:` (any highlight run) plus one value
  // per palette color. Color lives IN the source as a leading emoji (ADR 0035),
  // so the predicate re-uses `parseHighlight` -- a bare/default run counts as
  // blue (its own default color), so `highlight:blue` finds it. The `bare` flag
  // claims the value-less `highlight:` form (the (key, null) pair).
  filterOperators: HIGHLIGHT_FILTER_OPERATORS,
});
