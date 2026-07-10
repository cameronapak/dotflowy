// The highlight color menu (ADR 0035): a Bear-style vertical list -- Default
// on top, then the named colors (check on the current one), Remove highlight
// at the bottom -- opened by clicking the revealed run's highlighter pen or by
// right-clicking a highlight anywhere (both Seam B, through the same thin
// ctx.openOverlay host the tag picker uses). Picking a color REWRITES THE
// SOURCE -- the color emoji is spliced in or out of the run's text -- because
// a highlight's color lives in `node.text`, not a side-collection (that's what
// keeps the markdown self-describing when pasted elsewhere). "Default" is the
// bare `==run==` form (blue, no emoji).
//
// Write-back is verbatim-match-or-drop (spliceHighlightRun): the menu captures
// the run at open time; if the line was edited underneath it, the pick drops
// instead of corrupting the line -- the Edit Link popover's contract. A mirror
// row edits its SOURCE node (`mirrorOf`), matching where the text lives.

import { Ban, Check } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

import type { NodeCommands } from "../../components/OutlineNode";
import type { PluginContext } from "../types";

import { useDismissable } from "../../components/use-dismissable";
import {
  buildHighlightRun,
  HIGHLIGHT_DEFAULT_COLOR,
  HIGHLIGHT_EMOJI,
  parseHighlight,
  type HighlightColor,
} from "../../data/highlight";
import { replaceTokenInNode } from "../token-kit";

/** Splice the recolored (or un-highlighted, with `color: null`) run over the
 *  old one in the node's LIVE text. Exported for tests; pure except the one
 *  tree read + the onTextChange write. */
export function applyHighlightEdit(
  nodeId: string,
  oldRun: string,
  color: HighlightColor | null,
  mutations: NodeCommands,
): void {
  const { interior } = parseHighlight(oldRun);
  const newRun = color == null ? interior : buildHighlightRun(color, interior);
  replaceTokenInNode(nodeId, oldRun, newRun, mutations);
}

/** Mount the menu through the overlay host (the same thin `ctx.openOverlay`
 *  the tag color picker uses). Lives here so the plugin's index stays JSX-free. */
export function openHighlightColorMenu(
  args: { nodeId: string; token: string; x: number; y: number },
  ctx: PluginContext,
): void {
  ctx.openOverlay(
    <HighlightColorMenu
      token={args.token}
      x={args.x}
      y={args.y}
      onPick={(color) => {
        applyHighlightEdit(args.nodeId, args.token, color, ctx.mutations);
        ctx.openOverlay(null);
      }}
      onClose={() => ctx.openOverlay(null)}
    />,
  );
}

// "Default" leads (the bare-run default color), the rest follow the palette
// order in HIGHLIGHT_EMOJI -- the ONE source of truth for the color set, so a
// new palette color can't silently drift out of the menu. The Default row's
// aria-label carries the color name (computed at render) so tests/AT can
// address "Default (blue)".
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const ROWS: ReadonlyArray<{ color: HighlightColor; label: string }> = [
  { color: HIGHLIGHT_DEFAULT_COLOR, label: "Default" },
  ...HIGHLIGHT_EMOJI.filter((e) => e.color !== HIGHLIGHT_DEFAULT_COLOR).map(
    (e) => ({ color: e.color, label: capitalize(e.color) }),
  ),
];

const ROW_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground";

/**
 * The list itself: anchored below the run (pen click) or at the pointer
 * (right-click), clamped on screen, dismissed on outside pointerdown or
 * Escape -- TagColorMenu's mechanics on a Bear-shaped body.
 */
export function HighlightColorMenu({
  token,
  x,
  y,
  onPick,
  onClose,
}: {
  token: string;
  x: number;
  y: number;
  onPick: (color: HighlightColor | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const current = parseHighlight(token).color;
  useDismissable(ref, onClose);

  // Keep the menu on screen (~176px wide, ~290px tall).
  const left = Math.max(8, Math.min(x, window.innerWidth - 192));
  const top = Math.max(8, Math.min(y, window.innerHeight - 300));

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Highlight color"
      data-highlight-menu
      className="fixed z-50 flex w-44 flex-col rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left, top }}
    >
      {ROWS.map(({ color, label }) => (
        <button
          key={color}
          type="button"
          role="menuitemradio"
          aria-checked={current === color}
          aria-label={
            color === HIGHLIGHT_DEFAULT_COLOR ? `Default (${color})` : label
          }
          className={ROW_CLASS}
          onClick={() => onPick(color)}
        >
          <Check
            className={cn(
              "size-3.5 shrink-0",
              current !== color && "invisible",
            )}
          />
          {/* Soft theme `border` over the fill -- the tag color menu's swatch
              treatment; a `--tag-*-fg` ring reads too harsh at this size. */}
          <span
            aria-hidden="true"
            className="size-3.5 shrink-0 rounded-full border"
            style={{ background: `var(--tag-${color})` }}
          />
          {label}
        </button>
      ))}
      <div role="separator" className="my-1 h-px bg-border" />
      <button
        type="button"
        role="menuitem"
        aria-label="Remove highlight"
        className={cn(ROW_CLASS, "text-muted-foreground")}
        onClick={() => onPick(null)}
      >
        <Ban className="size-3.5 shrink-0" />
        Remove highlight
      </button>
    </div>,
    document.body,
  );
}
