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

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Ban, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  buildHighlightRun,
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

// "Default" leads (the bare-run blue), the rest follow in palette order --
// aria-labels carry the color name so tests/AT can address "Default (blue)".
const ROWS: ReadonlyArray<{
  color: HighlightColor;
  label: string;
  ariaLabel: string;
}> = [
  { color: "blue", label: "Default", ariaLabel: "Default (blue)" },
  { color: "red", label: "Red", ariaLabel: "Red" },
  { color: "orange", label: "Orange", ariaLabel: "Orange" },
  { color: "amber", label: "Amber", ariaLabel: "Amber" },
  { color: "green", label: "Green", ariaLabel: "Green" },
  { color: "purple", label: "Purple", ariaLabel: "Purple" },
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

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the opening (click/contextmenu) event doesn't immediately close it.
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

  // Keep the menu on screen (~176px wide, ~290px tall).
  const left = Math.max(8, Math.min(x, window.innerWidth - 192));
  const top = Math.max(8, Math.min(y, window.innerHeight - 300));

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Highlight color"
      data-highlight-menu
      className="bg-popover text-popover-foreground fixed z-50 flex w-44 flex-col rounded-lg border p-1 shadow-md"
      style={{ left, top }}
    >
      {ROWS.map(({ color, label, ariaLabel }) => (
        <button
          key={color}
          type="button"
          role="menuitemradio"
          aria-checked={current === color}
          aria-label={ariaLabel}
          className={ROW_CLASS}
          onClick={() => onPick(color)}
        >
          <Check
            className={cn(
              "size-3.5 shrink-0",
              current !== color && "invisible",
            )}
          />
          <span
            aria-hidden="true"
            className="size-3.5 shrink-0 rounded-full border"
            style={{
              background: `var(--tag-${color})`,
              borderColor: `var(--tag-${color}-fg)`,
            }}
          />
          {label}
        </button>
      ))}
      <div role="separator" className="bg-border my-1 h-px" />
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
