import { CopyPlus } from "lucide-react";

import { openMirrorPlaces } from "./mirror-places-opener";

/**
 * The "appears in N places" chip (ADR 0022, slice 1d). Shown on a mirror's
 * SOURCE and on every INSTANCE / capped row -- they share the source's content
 * id, so the count is the same everywhere -- in both the list-row and the
 * zoomed-title paths. Clicking it opens the places list ({@link MirrorPlaces})
 * to jump to any occurrence.
 *
 * `count` is the number of mirror INSTANCES; the content appears in `count + 1`
 * places total (the source plus each mirror). The caller renders this only when
 * `count > 0` AND the mirrors flag is on, so a mirror-free outline never mounts
 * it.
 */
export function MirrorBadge({
  sourceId,
  count,
}: {
  sourceId: string;
  count: number;
}) {
  const places = count + 1;
  const label = `Appears in ${places} places`;
  return (
    <button
      type="button"
      className="mirror-badge inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border/60 bg-muted/60 px-1.5 text-[10px] leading-4 font-medium text-muted-foreground transition-colors select-none hover:bg-muted hover:text-foreground"
      title={label}
      aria-label={label}
      // Don't let a click bubble to the bullet (which would zoom) or place a
      // caret in the contentEditable text next to it.
      onClick={(e) => {
        e.stopPropagation();
        openMirrorPlaces(sourceId);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      tabIndex={-1}
    >
      <CopyPlus size={11} strokeWidth={2.5} aria-hidden="true" />
      {places}
    </button>
  );
}
