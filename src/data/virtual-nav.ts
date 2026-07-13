/**
 * Event-time bridge to the windowed list's virtualizer (Phase B, ADR 0019).
 *
 * The editor's command/focus closures are referentially stable (ADR 0014) and
 * read live state through module getters, never this render's values. Focusing a
 * node that has scrolled out of the window needs the virtualizer (to scroll it
 * back in) and the flat-list index of the id -- neither of which a stable
 * closure can capture. So the editor mirrors both here in an effect, exactly as
 * `view-state.ts` mirrors the zoom root, and the closures read them at call time.
 *
 * Inactive (returns false / no-op) while no editor is mounted, so callers can
 * branch on {@link isVirtualNavActive} and fall back to the direct
 * `refs.get(id)` focus.
 */

interface VirtualNav {
  scrollToIndex: (
    index: number,
    opts?: { align?: "start" | "center" | "end" | "auto" },
  ) => void;
  indexOf: (id: string) => number;
  /**
   * Measured (or estimated) start/size for a flat-list index. `start` is in
   * DOCUMENT space: the window virtualizer folds `scrollMargin` into every
   * measurement (the first item starts at paddingStart + scrollMargin), which
   * is why the render subtracts it (`translateY(start - scrollMargin)`,
   * OutlineRow). Consumers must NOT add scrollMargin again.
   */
  measurementAt: (index: number) => { start: number; size: number } | undefined;
}

let nav: VirtualNav | null = null;

/** Editor wires this each render (cheap; the virtualizer instance is stable). */
export function setVirtualNav(next: VirtualNav | null) {
  nav = next;
}

export function isVirtualNavActive(): boolean {
  return nav !== null;
}

/**
 * The viewport rect (top/height) of a visible row from the virtualizer's
 * measurements, NOT the DOM -- so an off-screen drop target during a drag still
 * has geometry (estimated until it renders). `scrollY` is passed so the caller
 * controls when it's read (auto-scroll re-projects). Null when virtual nav is
 * inactive or the id isn't a visible row. See use-drag-reorder.ts (ADR 0019).
 */
export function virtualRowRect(
  id: string,
  scrollY: number,
): { top: number; height: number } | null {
  if (!nav) return null;
  const i = nav.indexOf(id);
  if (i < 0) return null;
  const m = nav.measurementAt(i);
  if (!m) return null;
  return { top: m.start - scrollY, height: m.size };
}

/**
 * Scroll the row for `id` into view if the windowed list is active. Returns true
 * when a scroll was issued (the caller then defers focus to the row's mount
 * claim via pendingFocus); false when virtual nav is inactive or the id isn't a
 * visible row (caller focuses directly).
 */
export function scrollRowIntoView(
  id: string,
  align: "start" | "center" | "end" | "auto" = "center",
): boolean {
  if (!nav) return false;
  const i = nav.indexOf(id);
  if (i < 0) return false;
  nav.scrollToIndex(i, { align });
  return true;
}
