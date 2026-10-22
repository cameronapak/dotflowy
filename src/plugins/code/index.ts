// Code plugin (ADR 0001). The inline `code` run -- `` `like this` `` -- as a
// FOLDING token: the backticks hide (the run folds to a clean <code> atom) and
// reveal as real, dimmed, walk-through text only when the caret is within or
// adjacent to the run -- the same reveal-on-proximity model emphasis and links
// use (ADR 0025 / ADR 0005). Dogfoods Seam A's fold, no interaction.

import { mdPunct } from "../../components/inline-code";
import { CODE_RUN_PATTERN } from "../../data/code";
import { isRevealed } from "../token-kit";
import { definePlugin, type El } from "../types";

// Single-line, non-empty, no nested backtick. The shape lives in the pure layer
// (`src/data/code.ts`) so display-only flatteners share it; this plugin owns
// precedence + render (the `emphasis.ts` split).

const CODE_CLASS =
  "rounded-[4px] border border-border/60 bg-muted px-0.5 py-0.5 font-mono text-[0.85em] text-foreground";

// A folded code run: one ATOMIC <code> box with the backticks hidden. `data-src`
// carries the full source (including the backticks) so the core's readSource
// reconstructs it and the caret math counts the atom's length -- keyed on
// `data-src`, exactly like a folded link/emphasis run. `contenteditable="false"`
// makes it one caret unit until the caret touches an edge and it reveals.
function foldedCodeEl(interior: string, tok: string): El {
  return {
    tag: "code",
    attrs: {
      class: CODE_CLASS,
      contenteditable: "false",
      "data-src": tok,
      "data-src-len": tok.length,
    },
    children: [interior],
  };
}

// A revealed code run: the dimmed backticks (`.md-punct`, shared with the link +
// emphasis reveal) as REAL text INSIDE the styled <code> box, e.g.
// `<code>`x`</code>` -- the ticks live within the box because code has a visible
// container (unlike emphasis, whose markers sit outside its bare tag). Nothing
// carries `data-src`, so readSource and the caret math treat the whole thing as
// ordinary text -- the caret walks through the backticks one step at a time.
function revealedCodeEl(interior: string): El {
  const tick = mdPunct("`");
  return {
    tag: "code",
    attrs: { class: CODE_CLASS, "data-code-reveal": true },
    children: [tick, interior, tick],
  };
}

export default definePlugin({
  id: "code",
  tokens: [
    {
      id: "code-run",
      pattern: CODE_RUN_PATTERN,
      // Between links (0) and tags (20): a `#tag` inside a code run stays code.
      precedence: 10,
      folds: true,
      render: (tok, view) => {
        const interior = tok.slice(1, tok.length - 1);
        // Reveal iff the caret sits within or adjacent to the run (offset in
        // `[start, end]`, inclusive) -- mirrors the link/emphasis reveal rule.
        return isRevealed(view)
          ? revealedCodeEl(interior)
          : foldedCodeEl(interior, tok);
      },
    },
  ],
});
