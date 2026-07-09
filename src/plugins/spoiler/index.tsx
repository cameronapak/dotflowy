// Spoiler plugin (ADR 0043). `||text||` renders as the sixth FOLDING token,
// modelled on the code run's container-reveal (ADR 0001) and the highlight
// fold (ADR 0035): folded, the fences hide and the run is one atomic span
// skinned as a SOLID OPAQUE BAR (not blur -- blur bleeds at the edges and reads
// less deliberate); revealed (caret within/adjacent), the `||` fences are real,
// dimmed, walk-through text INSIDE the container and the interior shows -- the
// inline-code fence-in-container model, because a spoiler HAS a visible
// container.
//
// Reveal is the EXISTING folding-token caret mechanic, unchanged: the atom is
// `contenteditable="false"`, so clicking it lands the caret adjacent and
// caret-proximity unfolds the run; move the caret out and it re-folds. ONE
// action -- no click-toggle, no separate re-hide gesture -- so a spoiler needs
// NO Seam B. It differs from a highlight only in the at-rest skin and in the
// MCP redaction (worker/outline-ops.ts, not here).
//
// A spoiler is AUDIENCE-DEPENDENT: hidden-until-revealed to a human, redacted
// to an agent over MCP. That asymmetry lives in the pure layer's two opposite
// ops (src/data/spoiler.ts) and the Worker serialization, not in this render.
//
// Seams contributed: A (folding token), C (slash command), D (keymap). The
// desktop selection toolbar's Eye button (ADR 0036) is wired in
// SelectionFormatToolbar.tsx via the shared plain-marker toggle.

import { EyeOffIcon } from "lucide-react";
import { SPOILER_PATTERN, spoilerInterior } from "../../data/spoiler";
import { mdPunct } from "../../components/inline-code";
import { type MarkerPair, toggleWrapSelection } from "../../components/wrap";
import { isRevealed } from "../token-kit";
import { definePlugin, type El, type PluginContext } from "../types";

const SPOILER_MARKER: MarkerPair = { pre: "||", post: "||" };

// The at-rest opaque bar: `bg-muted-foreground` paints the whole run in a solid
// mid-grey (a spoiler bar, deliberately NOT the harsh primary black) and
// `text-transparent` hides the letters behind it, so the interior is present in
// the DOM (selectable, and `data-src` carries the raw `||text||` so in-app
// copy/export round-trip verbatim -- ADR 0043's human-egress row) but
// unreadable. `box-decoration-clone` keeps the bar solid if the run wraps a
// line; `select-none` would fight copy, so it's intentionally absent. No plugin
// stylesheet (ADR 0031): the utilities carry the skin.
// No horizontal padding: the bar hugs the `||text||` glyphs exactly, so it
// stays width-matched to the revealed run (no reflow) AND the caret lands flush
// against the fences on BOTH edges when revealed (padding would inset the fence
// and read as a phantom space on the left). `rounded` still softens the ends.
const BAR_CLASS =
  "md-spoiler bg-muted-foreground text-transparent rounded-[0.25em] box-decoration-clone cursor-text";

// The revealed container: no bar (the interior must be legible), the interior
// in MUTED text, the dimmed `||` fences INSIDE it as real walk-through text (so
// the caret steps through the fence one char at a time -- `||interior|` is
// reachable), over a tint that matches the node-multi-selection slab (ADR 0018,
// `oklch(from var(--primary) l c h / 0.1)` in styles.css) -- a 10% primary
// overlay reads clearly in both themes, where `bg-muted` (near-white) washed out
// on the light page. Keyed by `.md-spoiler-reveal` so the exact from-color +
// alpha lives in styles.css next to the selection slab it mirrors.
const REVEAL_CLASS =
  "md-spoiler-reveal text-muted-foreground rounded-[0.25em] box-decoration-clone";

// A folded run: one ATOMIC span skinned as the opaque bar. The bar's TEXT is the
// FULL source `||text||` (rendered transparent behind the bar), NOT just the
// interior -- so the bar reserves exactly the width the revealed `||text||`
// occupies, and entering/leaving the run swaps bar<->text with ZERO horizontal
// reflow (the `.md-punct` fences differ from the bar only in color/opacity, same
// glyphs + font, so the widths match to the pixel). `data-src`/`data-src-len`
// carry the same source (the generic atom shape of ADR 0005), so readSource
// reconstructs `||text||` and the caret math counts the atom as one unit.
// `data-spoiler` is the e2e / selection hook.
function foldedSpoilerEl(tok: string): El {
  return {
    tag: "span",
    attrs: {
      class: BAR_CLASS,
      "data-spoiler": true,
      contenteditable: "false",
      "data-src": tok,
      "data-src-len": tok.length,
    },
    children: [tok],
  };
}

// A revealed run: the `||` fences as dimmed `.md-punct` REAL text flanking the
// interior INSIDE the still-tinted container (the code-box model). Nothing here
// carries `data-src`, so readSource and the caret math treat the whole thing as
// ordinary text -- the caret walks the fences one step at a time.
function revealedSpoilerEl(interior: string): El {
  const fence = mdPunct("||");
  return {
    tag: "span",
    attrs: { class: REVEAL_CLASS, "data-spoiler-reveal": true },
    children: [fence, interior, fence],
  };
}

export default definePlugin({
  id: "spoiler",

  // Seam A: one FOLDING token. Precedence 40 sits after highlight (35) and the
  // emphasis block (30-34); `|` shares a leading char with nothing, so there's
  // no double-vs-single coupling to order around. `code` (10) shields its
  // interior, so `` `||x||` `` stays literal -- Discord's "negated by a code
  // block" rule falls out for free (ADR 0043).
  tokens: [
    {
      id: "spoiler",
      pattern: SPOILER_PATTERN,
      precedence: 40,
      folds: true,
      render: (tok, view) => {
        // Reveal iff the caret sits within or adjacent to the run (offset in
        // `[start, end]`, inclusive) -- the link/emphasis/code reveal rule.
        return isRevealed(view)
          ? revealedSpoilerEl(spoilerInterior(tok))
          : foldedSpoilerEl(tok);
      },
    },
  ],

  // Seam C: `/spoiler` toggles the `||` fence over the selection (or inserts an
  // empty pair with the caret inside). A plain marker toggle -- no in-source
  // metadata like highlight's color emoji -- so it rides the clean
  // `toggleWrapSelection` (re-running on a wrapped selection unwraps it).
  commands: [
    {
      id: "spoiler",
      label: "Spoiler",
      description: "Wrap in ||spoiler|| (hidden from humans, redacted from AI)",
      icon: EyeOffIcon,
      keywords: ["spoiler", "hide", "redact", "secret", "mask", "markdown"],
      available: () => true,
      // Wrap is caret/selection-scoped -- excluded from the Cmd+K command
      // center, which has no live caret (ADR 0034).
      caretScoped: true,
      run: (nodeId: string, ctx: PluginContext) =>
        toggleWrapSelection(nodeId, SPOILER_MARKER, ctx.mutations.onTextChange),
    },
  ],

  // Seam D: Mod+Shift+S (free of the reserved-key denylist; emphasis owns
  // Mod+Shift+X, highlight Mod+Shift+H -- ADR 0043).
  keymap: [
    {
      id: "spoiler",
      hotkey: "Mod+Shift+S",
      run: (nodeId: string, ctx: PluginContext) =>
        toggleWrapSelection(nodeId, SPOILER_MARKER, ctx.mutations.onTextChange),
    },
  ],
});
