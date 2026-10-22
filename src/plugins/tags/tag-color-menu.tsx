import { Ban } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { Button } from "@/plugins/kit";

import { useDismissable } from "../../components/use-dismissable";
import {
  TAG_COLORS,
  clearTagColor,
  setTagColor,
  tagColorPaletteCss,
  tagColorsCss,
  useTagColor,
  useTagColorRows,
} from "../../data/tag-colors";

/**
 * Named tag color pairs + per-tag overrides. Mounted once in __root__. Palette
 * custom properties and generated `[data-tag]` rules live here so the tags
 * plugin owns all tag paint CSS; surfaces use Tailwind for the neutral default.
 */
export function TagColorStyles() {
  const rows = useTagColorRows();
  const overrides = tagColorsCss(rows);
  return (
    <>
      <style data-tag-palette>{tagColorPaletteCss}</style>
      <style data-tag-colors>{overrides}</style>
    </>
  );
}

/**
 * The tag color picker: a "clear" (Auto) swatch then the named palette. Opened
 * by right-clicking an inline tag chip (the tags plugin's Seam-B
 * interaction routes it through ctx.openOverlay); picking applies to every
 * instance of the tag. Anchored at the pointer, dismissed on outside click or
 * Escape. See docs/adr/0007-custom-tag-colors.md.
 */
export function TagColorMenu({
  tag,
  x,
  y,
  onClose,
}: {
  tag: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const current = useTagColor(tag);
  useDismissable(ref, onClose);

  // Keep the popover on screen (it's ~248px wide, ~44px tall).
  const left = Math.min(x, window.innerWidth - 256);
  const top = Math.min(y, window.innerHeight - 56);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`Color for #${tag}`}
      className="fixed z-50 flex items-center gap-1 rounded-lg border bg-popover p-1.5 shadow-md"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
    >
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        role="menuitemradio"
        aria-checked={current === null}
        aria-label="No color"
        title="No color"
        className={cn(
          "text-muted-foreground",
          current === null &&
            "ring-2 ring-ring ring-offset-1 ring-offset-popover",
        )}
        onClick={() => {
          clearTagColor(tag);
          onClose();
        }}
      >
        <Ban />
      </Button>
      {TAG_COLORS.map((color) => (
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
          style={{
            background: `var(--tag-${color})`,
          }}
          onClick={() => {
            setTagColor(tag, color);
            onClose();
          }}
        >
          <span style={{ color: `var(--tag-${color}-fg)` }}>#</span>
        </Button>
      ))}
    </div>,
    document.body,
  );
}
