// Route Bible plugin (ADR 0001). A Scripture reference in `node.text` -> a
// clickable chip that opens route.bible. Seam A (the chip render) + Seam B (the
// delegated open) -- the same two seams the `links` plugin uses, minus the fold.
//
// Detection is liberal-regex-PROPOSES (BIBLE_REF_PATTERN) /
// grab-bcv-parser-DISPOSES (resolveBibleRef returns null -> the core renders raw
// text). The chip is an ATOMIC WIDGET (ADR 0006): Seam A's React mode, so the
// chip is REAL TSX (BibleChip -- lucide icons + Tailwind classes) mounted inside
// a `<dotflowy-widget>` atom, with NO plugin CSS. The atom carries its source in
// `data-src`, so `readSource`/the caret math treat it as one opaque unit (the
// caret jumps over it). The pure layer (pattern + parse + URL) lives in ./bible.ts.

import { BIBLE_REF_PATTERN, resolveBibleRef } from "./bible";
import { BibleChip } from "./chip";
import { getViewRootId } from "../../data/view-state";
import { openBiblePassageEditPopover } from "./passage-edit-popover";
import { definePlugin, type WidgetEl } from "../types";

const LONG_PRESS_MS = 550;
const longPressTimers = new WeakMap<HTMLElement, number>();
const longPressed = new WeakSet<HTMLElement>();

// The chip is a `<dotflowy-widget>` atom mounting BibleChip (ADR 0006). `source`
// is the verbatim reference ("Jn 3:16") -- the atom's source text AND the
// component's label. `data-bible-ref` + `data-href` are the Seam-B interaction
// hooks (the click handler reads them off the element); the core adds
// `data-src`/`contenteditable`.
function bibleRefWidget(tok: string, url: string): WidgetEl {
  return {
    kind: "widget",
    source: tok,
    attrs: { "data-bible-ref": true, "data-href": url },
  };
}

function clearLongPress(el: HTMLElement): void {
  const timer = longPressTimers.get(el);
  if (timer != null) window.clearTimeout(timer);
  longPressTimers.delete(el);
}

function openEditForChip(
  el: HTMLElement,
  ctx: Parameters<typeof openBiblePassageEditPopover>[1],
): void {
  const token = el.getAttribute("data-src") ?? "";
  const nodeId =
    el.closest<HTMLElement>("[data-node-id]")?.getAttribute("data-node-id") ??
    getViewRootId();
  if (!token || !nodeId) return;
  const focusTarget = el.closest<HTMLElement>(".node-text");
  const rect = el.getBoundingClientRect();
  openBiblePassageEditPopover(
    {
      nodeId,
      token,
      focusTarget,
      x: rect.left,
      y: rect.bottom + 6,
    },
    ctx,
  );
}

export default definePlugin({
  id: "route-bible",
  tokens: [
    {
      id: "bible-ref",
      pattern: BIBLE_REF_PATTERN,
      // After links (0) and code (10): a reference inside a `[label](url)` or a
      // `code` run stays owned by those. The widget is an atom (data-src), but
      // NOT folding -- it never reveals raw markdown on caret, it's always the
      // chip; `folds` stays off so the reveal fast path skips bible-only lines.
      precedence: 15,
      // The component the `<dotflowy-widget data-widget="bible-ref">` atom mounts.
      component: BibleChip,
      render: (tok) => {
        const ref = resolveBibleRef(tok);
        // Regex proposes, parser disposes: a non-reference ("Hello 3") falls
        // through to plain text, never a chip.
        return ref ? bibleRefWidget(tok, ref.url) : tok;
      },
    },
  ],

  // Seam B: click/tap keeps the fast route.bible open path; editing is an
  // intentional secondary gesture (long-press or context menu), so the common
  // interaction stays simple.
  interactions: [
    {
      selector: "[data-bible-ref]",
      blockCaretOnMouseDown: true,
      onClick: (el, ctx, e) => {
        const href = el.dataset.href;
        if (!href) return;
        e.preventDefault();
        e.stopPropagation();
        clearLongPress(el);
        if (e.source === "keyboard" && e.key === " ") {
          openEditForChip(el, ctx);
          return;
        }
        if (longPressed.has(el)) {
          longPressed.delete(el);
          return;
        }
        window.open(href, "_blank", "noopener,noreferrer");
      },
      onPointerDown: (el, ctx, e) => {
        clearLongPress(el);
        const timer = window.setTimeout(() => {
          longPressed.add(el);
          e.preventDefault();
          e.stopPropagation();
          openEditForChip(el, ctx);
        }, LONG_PRESS_MS);
        longPressTimers.set(el, timer);
      },
      onPointerUp: (el) => clearLongPress(el),
      onPointerCancel: (el) => clearLongPress(el),
      onContextMenu: (el, ctx, e) => {
        clearLongPress(el);
        e.preventDefault();
        e.stopPropagation();
        openEditForChip(el, ctx);
      },
    },
  ],
});
