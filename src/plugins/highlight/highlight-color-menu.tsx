// The highlight recolor menu (ADR 0035): a swatch row opened by right-clicking
// a highlight run (the tags color picker's shape, through the same thin
// ctx.openOverlay host). Picking a color REWRITES THE SOURCE -- the color
// emoji is spliced in or out of the run's text -- because a highlight's color
// lives in `node.text`, not a side-collection (that's what keeps the markdown
// self-describing when pasted elsewhere). The leading Ban swatch removes the
// highlight entirely (fences + emoji stripped, interior kept).
//
// Write-back is verbatim-match-or-drop (spliceHighlightRun): the menu captures
// the run at open time; if the line was edited underneath it, the pick drops
// instead of corrupting the line -- the Edit Link popover's contract. A mirror
// row edits its SOURCE node (`mirrorOf`), matching where the text lives.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Ban } from "lucide-react";
import { Button } from "@/plugins/kit";
import { cn } from "@/lib/utils";
import {
  buildHighlightRun,
  HIGHLIGHT_EMOJI,
  parseHighlight,
  spliceHighlightRun,
  type HighlightColor,
} from "../../data/highlight";
import { getTreeIndex } from "../../data/tree-store";
import type { NodeCommands } from "../../components/OutlineNode";
import type { PluginContext } from "../types";

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
  if (newRun === oldRun) return;
  const index = getTreeIndex();
  const clicked = index.byId.get(nodeId);
  if (!clicked) return;
  const targetId = clicked.mirrorOf ?? nodeId;
  const current = index.byId.get(targetId)?.text;
  if (current == null) return;
  const next = spliceHighlightRun(current, oldRun, newRun);
  if (next != null && next !== current) mutations.onTextChange(targetId, next);
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

/**
 * The swatch row itself: remove-highlight, then the six palette colors, the
 * current one ringed. Anchored at the pointer, clamped on screen, dismissed on
 * outside pointerdown or Escape -- TagColorMenu's mechanics verbatim.
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

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the opening (contextmenu) event doesn't immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Keep the popover on screen (it's ~220px wide, ~44px tall).
  const left = Math.min(x, window.innerWidth - 228);
  const top = Math.min(y, window.innerHeight - 56);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Highlight color"
      data-highlight-menu
      className="bg-popover fixed z-50 flex items-center gap-1 rounded-lg border p-1.5 shadow-md"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
    >
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        role="menuitem"
        aria-label="Remove highlight"
        title="Remove highlight"
        className="text-muted-foreground"
        onClick={() => onPick(null)}
      >
        <Ban />
      </Button>
      {HIGHLIGHT_EMOJI.map(({ color }) => (
        <Button
          key={color}
          type="button"
          variant="outline"
          size="icon-xs"
          role="menuitemradio"
          aria-checked={current === color}
          aria-label={color}
          title={color}
          className={cn(
            current === color &&
              "ring-2 ring-ring ring-offset-1 ring-offset-popover",
          )}
          style={{ background: `var(--tag-${color})` }}
          onClick={() => onPick(color)}
        >
          <span style={{ color: `var(--tag-${color}-fg)` }}>a</span>
        </Button>
      ))}
    </div>,
    document.body,
  );
}
