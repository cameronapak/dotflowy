// Emphasis plugin (ADR 0025). Inline emphasis -- `*italic*`, `**bold**`,
// `~~strike~~`, `~underline~` (Bear-style) -- as FOLDING tokens, modelled on the
// rich-link fold (ADR 0005): a run shows its raw markdown markers only when the
// caret is within or adjacent to it, and folds to a clean styled tag otherwise.
//
// The markers are REAL, walk-through editable text when revealed: the caret
// steps through `*italics*` one character at a time, so it can land inside the
// fence (`*italics|*`). Folded, the whole run is one atomic `contenteditable`
// unit whose `data-src` carries the full source -- exactly like a folded link,
// so `readSource` and the source-offset caret math in inline-code.ts already
// handle it with ZERO new machinery (they key on `data-src`).
//
// v1 is FLAT: no nesting, no `***bold+italic***`. Italic accepts BOTH `*x*` and
// `_x_` -- the underscore form is a render-only token folding to the SAME `<em>`
// (creation via /italic + Cmd+I still emits `*`); it is intraword-guarded so
// `snake_case` stays literal. An unmatched or nested attempt renders as literal
// text. See ADR 0025.
//
// Pure logic (patterns, strip, marker length) lives in src/data/emphasis.ts.
//
// Seams contributed: A (folding tokens), C (slash commands), D (keymap).

import {
  BoldIcon,
  ItalicIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from "lucide-react";

import { mdPunct } from "../../components/inline-code";
import { type MarkerPair, toggleWrapSelection } from "../../components/wrap";
import {
  BOLD_PATTERN,
  emphasisMarkerLen,
  ITALIC_PATTERN,
  ITALIC_UNDERSCORE_PATTERN,
  STRIKETHROUGH_PATTERN,
  UNDERLINE_PATTERN,
} from "../../data/emphasis";
import { isRevealed } from "../token-kit";
import {
  definePlugin,
  type El,
  type PluginContext,
  type TokenView,
} from "../types";

/** The four marker pairs. Keys match the slash-command ids and the keymap
 *  wiring; the generic wrap mechanics live in components/wrap.ts (shared with
 *  the highlight plugin). */
const MARKERS: Record<"bold" | "italic" | "underline" | "strike", MarkerPair> =
  {
    bold: { pre: "**", post: "**" },
    italic: { pre: "*", post: "*" },
    underline: { pre: "~", post: "~" },
    strike: { pre: "~~", post: "~~" },
  };

// The four emphasis kinds, shared across the token + command + keymap shapes.
// `kind` is the key into MARKERS (the marker pair) and the discriminator for
// the slash/keymap wiring.
type Kind = keyof typeof MARKERS;

interface EmphasisKind {
  kind: Kind;
  id: string;
  pattern: string;
  // Lower precedence wins the alternation on overlap. `**` must beat `*`, `~~`
  // must beat `~`, so bold/strike are < italic/underline.
  precedence: number;
  tag: "em" | "strong" | "del" | "u";
  /** Semantic hook class (`md-bold` …), kept stable for selectors. */
  class: string;
  /** Tailwind utility that carries the actual weight/decoration. Explicit (a
   *  class selector) so a CSS reset on the bare tag can't strip the semantics --
   *  this is why emphasis needs NO plugin stylesheet (ADR 0031: no raw plugin
   *  CSS). The literal appears here so Tailwind's content scan emits it. */
  util: string;
  label: string;
  description: string;
  icon: typeof BoldIcon;
  hotkey: string;
}

const KINDS: readonly EmphasisKind[] = [
  {
    kind: "bold",
    id: "emphasis-bold",
    pattern: BOLD_PATTERN,
    precedence: 30,
    tag: "strong",
    class: "md-bold",
    util: "font-bold",
    label: "Bold",
    description: "Wrap in **bold**",
    icon: BoldIcon,
    hotkey: "Mod+B",
  },
  {
    kind: "strike",
    id: "emphasis-strike",
    pattern: STRIKETHROUGH_PATTERN,
    precedence: 31,
    tag: "del",
    class: "md-strike",
    util: "line-through",
    label: "Strikethrough",
    description: "Wrap in ~~strikethrough~~",
    icon: StrikethroughIcon,
    hotkey: "Mod+Shift+X",
  },
  {
    kind: "italic",
    id: "emphasis-italic",
    pattern: ITALIC_PATTERN,
    precedence: 32,
    tag: "em",
    class: "md-italic",
    util: "italic",
    label: "Italic",
    description: "Wrap in *italic*",
    icon: ItalicIcon,
    hotkey: "Mod+I",
  },
  {
    kind: "underline",
    id: "emphasis-underline",
    pattern: UNDERLINE_PATTERN,
    precedence: 33,
    tag: "u",
    class: "md-underline",
    util: "underline",
    label: "Underline",
    description: "Wrap in ~underline~ (Bear-style)",
    icon: UnderlineIcon,
    hotkey: "Mod+U",
  },
];

// A folded emphasis run: one ATOMIC styled tag (`<em>`/`<strong>`/`<del>`/`<u>`).
// The markers are hidden; `data-src`/`data-src-len` carry the full source, so
// the core's readSource reconstructs `*italic*` and the caret helpers count the
// atom's length (ADR 0005's generic atom path -- keyed on `data-src`, not on
// "link"). `contenteditable="false"` makes it one indivisible caret unit until
// the caret touches an edge and the token reveals.
function foldedEmphasisEl(
  kind: EmphasisKind,
  interior: string,
  tok: string,
): El {
  return {
    tag: kind.tag,
    attrs: {
      // Semantic hook + Tailwind utility (weight/decoration) + cursor-text (the
      // atom is contenteditable=false, so it needs an explicit text cursor).
      // No plugin stylesheet -- the utilities carry it (ADR 0031).
      class: `${kind.class} ${kind.util} cursor-text`,
      "data-emphasis": true,
      contenteditable: "false",
      "data-src": tok,
      "data-src-len": tok.length,
    },
    children: [interior],
  };
}

// A revealed emphasis run: the dimmed markers (`.md-punct`, shared with the
// link reveal) as REAL text flanking the styled interior, e.g.
// `*<em>italics</em>*`. Nothing here carries `data-src`, so readSource and the
// caret math treat the whole thing as ordinary text -- the caret walks through
// the markers one step at a time, which is the whole point (`*italics|*` is a
// reachable position). Markers sit OUTSIDE the styled tag so they read as plain
// syntax scaffolding, not slanted/bold content.
function revealedEmphasisEl(
  kind: EmphasisKind,
  interior: string,
  marker: string,
): El {
  return {
    tag: "span",
    attrs: { class: "emphasis-reveal", "data-emphasis-reveal": true },
    children: [
      mdPunct(marker),
      {
        tag: kind.tag,
        attrs: { class: `${kind.class} ${kind.util}` },
        children: [interior],
      },
      mdPunct(marker),
    ],
  };
}

// Split a matched run into its marker char-run and interior. Every pattern uses
// the same marker char on both edges with equal length (1 for italic/underline,
// 2 for bold/strike), so the leading run of `tok[0]` IS the marker.
function partsOf(tok: string): { marker: string; interior: string } {
  const len = emphasisMarkerLen(tok);
  return {
    marker: tok.slice(0, len),
    interior: tok.slice(len, tok.length - len),
  };
}

// Render one emphasis run of `kind` to its folded or revealed El. Shared by the
// four canonical `*`/`~` tokens and the render-only `_x_` italic variant (which
// reuses the italic kind), so the fold/reveal rule lives in exactly one place.
// Reveal iff the caret sits within or adjacent to the run (offset in
// `[start, end]`, boundaries inclusive so you can arrow/click in from either
// edge) -- mirrors the link reveal rule verbatim.
function renderEmphasis(kind: EmphasisKind, tok: string, view: TokenView): El {
  const { marker, interior } = partsOf(tok);
  return isRevealed(view)
    ? revealedEmphasisEl(kind, interior, marker)
    : foldedEmphasisEl(kind, interior, tok);
}

// The italic kind, reused by the underscore-italic token (same `<em>`, class,
// util) -- there is no separate underscore semantic.
const ITALIC_KIND = KINDS.find((k) => k.kind === "italic")!;

export default definePlugin({
  id: "emphasis",

  // Seam A: four FOLDING tokens, composed into the one combined regex. `folds`
  // opts them into the core's caret-reveal fast path (hasFoldingToken), so the
  // per-line watcher re-decorates as the caret crosses a run's edge -- the same
  // mechanism the rich link uses.
  tokens: [
    ...KINDS.map((kind) => ({
      id: kind.id,
      pattern: kind.pattern,
      precedence: kind.precedence,
      folds: true,
      render: (tok: string, view: TokenView) => renderEmphasis(kind, tok, view),
    })),
    // The underscore italic form (`_x_`) -- a render-only token folding to the
    // SAME `<em>` as `*x*` (reuses ITALIC_KIND). No leading-char overlap with
    // the `*`/`~` runs, so its precedence only needs to be distinct (34, after
    // underline). No slash command / keymap: `_` is an alternative INPUT syntax,
    // not a second italic semantic (creation stays `*` via /italic + Cmd+I).
    {
      id: "emphasis-italic-underscore",
      pattern: ITALIC_UNDERSCORE_PATTERN,
      precedence: 34,
      folds: true,
      render: (tok: string, view: TokenView) =>
        renderEmphasis(ITALIC_KIND, tok, view),
    },
  ],

  // No plugin stylesheet (ADR 0031 retires the raw-CSS seam): the weight /
  // decoration ride Tailwind utilities on each token's own tag (see `util`
  // above), and the revealed markers reuse the core `.md-punct` dimming (shared
  // with links, in styles.css).

  // Seam C: a `/` command per kind. Always available (any bullet can take
  // emphasis); the wrap inserts an empty marker pair and places the caret inside
  // when there's no selection.
  commands: KINDS.map(({ kind, id, label, description, icon }) => ({
    id,
    label,
    description,
    icon,
    keywords: [
      kind,
      "emphasis",
      "format",
      "markdown",
      "style",
      label.toLowerCase(),
    ],
    available: () => true,
    // Wrap is caret/selection-scoped -- excluded from the Cmd+K command center,
    // which has no live caret (ADR 0034). Slash palette + Seam D still run it.
    caretScoped: true,
    // Toggle, not add-only: re-running on an already-wrapped selection unwraps
    // it (ADR 0036), so /bold and the toolbar's bold button agree.
    run: (nodeId: string, ctx: PluginContext) =>
      toggleWrapSelection(nodeId, MARKERS[kind], ctx.mutations.onTextChange),
  })),

  // Seam D: the same four kinds on hotkeys, wired on the bullet AND the zoomed
  // title. Mod+B / Mod+I are the universal bold/italic; Mod+U is the common
  // underline (matches Bear + Obsidian); Mod+Shift+X is the de-facto
  // strikethrough. All four are browser-native contentEditable commands, so the
  // keymap engine's preventDefault is what stops the browser injecting its own
  // <b>/<i>/<u> -- our source-level wrap runs instead.
  keymap: KINDS.map(({ id, hotkey, kind }) => ({
    id,
    hotkey,
    run: (nodeId: string, ctx: PluginContext) =>
      toggleWrapSelection(nodeId, MARKERS[kind], ctx.mutations.onTextChange),
  })),
});
