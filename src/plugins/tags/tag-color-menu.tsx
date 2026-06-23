import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TAG_COLORS,
  clearTagColor,
  setTagColor,
  tagColorsCss,
  useTagColor,
  useTagColorRows,
} from "../../data/tag-colors";

/**
 * The generated override stylesheet -- one rule per colored tag, keyed by
 * `data-tag`. Mounted once (in __root). A color change updates this single
 * stylesheet, so every chip/pill/menu-row of that tag repaints with no React
 * re-render. See docs/adr/0016. Owned by the tags plugin (ADR 0018 Seam E).
 */
export function TagColorStyles() {
  const rows = useTagColorRows();
  const css = useMemo(() => tagColorsCss(rows), [rows]);
  return <style data-tag-colors>{css}</style>;
}

/**
 * The tag color picker: a "clear" (Auto) swatch then the named palette. Opened
 * by right-clicking a tag chip or filter pill (the tags plugin's Seam-B
 * interaction routes it through ctx.openOverlay); picking applies to every
 * instance of the tag. Anchored at the pointer, dismissed on outside click or
 * Escape. See docs/adr/0016 and ADR 0018.
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

  // Keep the popover on screen (it's ~248px wide, ~44px tall).
  const left = Math.min(x, window.innerWidth - 256);
  const top = Math.min(y, window.innerHeight - 56);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`Color for #${tag}`}
      className="bg-popover fixed z-50 flex items-center gap-1 rounded-lg border p-1.5 shadow-md"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={current === null}
        aria-label="No color"
        title="No color"
        className={cn(
          "flex size-6 items-center justify-center rounded-md border text-muted-foreground",
          current === null &&
            "ring-2 ring-ring ring-offset-1 ring-offset-popover",
        )}
        onClick={() => {
          clearTagColor(tag);
          onClose();
        }}
      >
        <Ban className="size-3.5" />
      </button>
      {TAG_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="menuitemradio"
          aria-checked={current === color}
          aria-label={color}
          title={color}
          className={cn(
            "size-6 rounded-md border",
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
          <span
            style={{
              color: `var(--tag-${color}-fg)`,
            }}
          >
            #
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
