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
// v1 is FLAT: no nesting, no `***bold+italic***`, no `_underscore_` variants.
// An unmatched or nested attempt renders as literal text. See ADR 0025.
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
import {
  BOLD_PATTERN,
  emphasisMarkerLen,
  ITALIC_PATTERN,
  STRIKETHROUGH_PATTERN,
  UNDERLINE_PATTERN,
} from "../../data/emphasis";
import { definePlugin, type El, type PluginContext } from "../types";
import { MARKERS, wrapSelectionOrInsert } from "./wrap";

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
  { kind: "bold", id: "emphasis-bold", pattern: BOLD_PATTERN, precedence: 30, tag: "strong", class: "md-bold", util: "font-bold", label: "Bold", description: "Wrap in **bold**", icon: BoldIcon, hotkey: "Mod+B" },
  { kind: "strike", id: "emphasis-strike", pattern: STRIKETHROUGH_PATTERN, precedence: 31, tag: "del", class: "md-strike", util: "line-through", label: "Strikethrough", description: "Wrap in ~~strikethrough~~", icon: StrikethroughIcon, hotkey: "Mod+Shift+X" },
  { kind: "italic", id: "emphasis-italic", pattern: ITALIC_PATTERN, precedence: 32, tag: "em", class: "md-italic", util: "italic", label: "Italic", description: "Wrap in *italic*", icon: ItalicIcon, hotkey: "Mod+I" },
  { kind: "underline", id: "emphasis-underline", pattern: UNDERLINE_PATTERN, precedence: 33, tag: "u", class: "md-underline", util: "underline", label: "Underline", description: "Wrap in ~underline~ (Bear-style)", icon: UnderlineIcon, hotkey: "Mod+U" },
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
  const punct = (s: string): El => ({
    tag: "span",
    attrs: { class: "md-punct" },
    children: [s],
  });
  return {
    tag: "span",
    attrs: { class: "emphasis-reveal", "data-emphasis-reveal": true },
    children: [
      punct(marker),
      {
        tag: kind.tag,
        attrs: { class: `${kind.class} ${kind.util}` },
        children: [interior],
      },
      punct(marker),
    ],
  };
}

// Split a matched run into its marker char-run and interior. Every pattern uses
// the same marker char on both edges with equal length (1 for italic/underline,
// 2 for bold/strike), so the leading run of `tok[0]` IS the marker.
function partsOf(tok: string): { marker: string; interior: string } {
  const len = emphasisMarkerLen(tok);
  return { marker: tok.slice(0, len), interior: tok.slice(len, tok.length - len) };
}

export default definePlugin({
  id: "emphasis",

  // Seam A: four FOLDING tokens, composed into the one combined regex. `folds`
  // opts them into the core's caret-reveal fast path (hasFoldingToken), so the
  // per-line watcher re-decorates as the caret crosses a run's edge -- the same
  // mechanism the rich link uses.
  tokens: KINDS.map((kind) => ({
    id: kind.id,
    pattern: kind.pattern,
    precedence: kind.precedence,
    folds: true,
    render: (tok, { revealOffset, start, end }) => {
      const { marker, interior } = partsOf(tok);
      // Reveal iff the caret sits within or adjacent to the run (offset in
      // `[start, end]`, boundaries inclusive so you can arrow/click in from
      // either edge) -- mirrors the link reveal rule verbatim.
      const reveal =
        revealOffset != null && revealOffset >= start && revealOffset <= end;
      return reveal
        ? revealedEmphasisEl(kind, interior, marker)
        : foldedEmphasisEl(kind, interior, tok);
    },
  })),

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
    run: (nodeId: string, ctx: PluginContext) =>
      wrapSelectionOrInsert(nodeId, kind, ctx.mutations.onTextChange),
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
      wrapSelectionOrInsert(nodeId, kind, ctx.mutations.onTextChange),
  })),
});
