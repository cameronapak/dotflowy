import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  BoldIcon,
  HighlighterIcon,
  ItalicIcon,
  LinkIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  detectMarkerWrap,
  type MarkerPair,
  readActiveSelectionSource,
} from "./wrap";

/**
 * The zero-arg command surface the desktop formatting toolbar drives (ADR 0036).
 * The facade `useSelectionFormatActions` in OutlineEditor resolves the focused
 * (mirror-aware) content node internally, so the toolbar stays dumb chrome over
 * the existing emphasis/highlight/link machinery — no new mutation path, same
 * runStructural/field-edit semantics as the keymap.
 */
export interface SelectionFormatActions {
  /** Toggle an emphasis marker (`**`, `*`, `~~`, `~`) over the selection. */
  toggleMarker: (marker: MarkerPair) => void;
  /** Toggle a default-blue highlight over the selection. */
  toggleHighlight: () => void;
  /** Wrap the selection in a link + open the edit popover, or null when the
   *  links plugin isn't loaded. */
  createLink: (() => void) | null;
}

const BOLD: MarkerPair = { pre: "**", post: "**" };
const ITALIC: MarkerPair = { pre: "*", post: "*" };
const STRIKE: MarkerPair = { pre: "~~", post: "~~" };
const UNDER: MarkerPair = { pre: "~", post: "~" };
const HIGHLIGHT: MarkerPair = { pre: "==", post: "==" };

/** The five togglable markers, in button order, for the active-state read. Link
 *  is create-only (no lit state), so it isn't here. */
const MARKERS: ReadonlyArray<[key: string, marker: MarkerPair]> = [
  ["bold", BOLD],
  ["italic", ITALIC],
  ["strike", STRIKE],
  ["underline", UNDER],
  ["highlight", HIGHLIGHT],
];

/** A coarse pointer never gets this toolbar — that's the mobile actions bar's
 *  world (ADR 0030). We gate on `(pointer: fine)`, the inverse seam. One shared
 *  MediaQueryList (the value only flips on hardware/OS change), so the
 *  selection-tick re-renders don't each allocate a fresh matchMedia. */
const fineMql =
  typeof window === "undefined" ? null : window.matchMedia("(pointer: fine)");
function subscribeFine(onChange: () => void) {
  fineMql?.addEventListener("change", onChange);
  return () => fineMql?.removeEventListener("change", onChange);
}
function useFinePointer(): boolean {
  return useSyncExternalStore(
    subscribeFine,
    () => fineMql?.matches ?? false,
    () => false,
  );
}

/** The `.node-text` contentEditable containing a DOM node, or null. Both an
 *  outline bullet and the zoomed title carry `.node-text`, so this is the honest
 *  "the selection is inside one editable outline span" test. */
function outlineSpanOf(node: Node): HTMLElement | null {
  const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  return el?.closest<HTMLElement>(".node-text") ?? null;
}

interface SelectionInfo {
  rect: DOMRect;
  /** The marker keys already wrapping the selection (lit buttons). */
  active: Set<string>;
}

/** The current selection as a formatting target, or null when it isn't one: no
 *  selection, collapsed, or spanning more than one bullet (a cross-bullet range
 *  can't be wrapped in source, so we don't offer to). */
function computeSelection(): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const host = outlineSpanOf(range.startContainer);
  if (!host || !host.isContentEditable) return null;
  if (outlineSpanOf(range.endContainer) !== host) return null;

  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;

  const active = new Set<string>();
  const src = readActiveSelectionSource();
  if (src) {
    for (const [key, m] of MARKERS) {
      if (detectMarkerWrap(src.source, src.start, src.end, m)) active.add(key);
    }
  }
  return { rect, active };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

/** One toolbar button. `preventDefault` on `pointerdown` keeps the outline
 *  selection alive across the press (a plain click would blur the span and
 *  collapse the range, dropping the action's target) — the mobile bar's trick
 *  (ADR 0030), here to preserve a text selection rather than a caret. Runs on
 *  press; there's no scroll to distinguish from a tap on a fine pointer. */
function ToolbarButton({
  label,
  active,
  onRun,
  children,
}: {
  label: string;
  active?: boolean;
  onRun: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-active={active || undefined}
      className={cn(
        "flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md text-foreground/80",
        "transition-colors hover:bg-accent hover:text-accent-foreground",
        "data-[active]:bg-accent data-[active]:text-accent-foreground",
      )}
      onPointerDown={(e) => {
        e.preventDefault();
        onRun();
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-border/60" aria-hidden />;
}

/**
 * Desktop selection formatting toolbar (ADR 0036). A floating capsule that
 * appears above a text selection inside one outline bullet/title and toggles
 * bold / italic / strike / underline / highlight, plus create-link.
 *
 * Three gates, all orthogonal: presence = `(pointer: fine)` (the inverse of the
 * mobile bar's coarse seam), visibility = a non-collapsed single-span selection,
 * position = the selection's bounding rect. It never coexists with the mobile
 * bar (opposite pointer) or node multi-selection (which has no caret/selection).
 *
 * Dumb chrome: every button routes through `actions` (the OutlineEditor facade)
 * into the same emphasis/highlight/link paths the keyboard uses, so it inherits
 * their atomicity + protection guards and adds no mutation path.
 */
export function SelectionFormatToolbar({
  actions,
}: {
  actions: SelectionFormatActions;
}) {
  const fine = useFinePointer();
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  // Track the selection while on a fine pointer. Suppress the toolbar during an
  // active mouse drag-select (it would jump around under the cursor); recompute
  // on release. A keyboard selection (Shift+arrows) has no pointerdown, so it
  // updates live. A press that starts ON the toolbar must NOT count as a drag,
  // or the button press would hide the toolbar before its action runs.
  useEffect(() => {
    if (!fine) {
      setInfo(null);
      return;
    }
    let raf = 0;
    let dragging = false;
    const recompute = () => {
      raf = 0;
      setInfo(dragging ? null : computeSelection());
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(recompute);
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      dragging = true;
      setInfo(null);
    };
    const onUp = () => {
      dragging = false;
      schedule();
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
    };
  }, [fine]);

  // Measure so we can center + clamp + flip above/below without guessing width.
  useLayoutEffect(() => {
    if (!info || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    if (r.width !== box.w || r.height !== box.h)
      setBox({ w: r.width, h: r.height });
  }, [info, box.w, box.h]);

  if (!fine || !info) return null;

  const gap = 8;
  const half = box.w / 2;
  const centerX = clamp(
    info.rect.left + info.rect.width / 2,
    half + 8,
    window.innerWidth - half - 8,
  );
  const above = info.rect.top - box.h - gap >= 8;
  const top = above ? info.rect.top - gap : info.rect.bottom + gap;

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Format selection"
      data-format-toolbar
      className={cn(
        "fixed z-40 flex items-center gap-0.5 rounded-lg px-1 py-1",
        "border border-border/60 bg-popover shadow-md",
      )}
      style={{
        left: centerX,
        top,
        transform: `translate(-50%, ${above ? "-100%" : "0"})`,
        // Hide until measured so the first (unclamped) paint doesn't flash.
        visibility: box.w ? "visible" : "hidden",
      }}
    >
      <ToolbarButton
        label="Bold"
        active={info.active.has("bold")}
        onRun={() => actions.toggleMarker(BOLD)}
      >
        <BoldIcon className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Italic"
        active={info.active.has("italic")}
        onRun={() => actions.toggleMarker(ITALIC)}
      >
        <ItalicIcon className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Strikethrough"
        active={info.active.has("strike")}
        onRun={() => actions.toggleMarker(STRIKE)}
      >
        <StrikethroughIcon className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Underline"
        active={info.active.has("underline")}
        onRun={() => actions.toggleMarker(UNDER)}
      >
        <UnderlineIcon className="size-4" />
      </ToolbarButton>
      <Divider />
      <ToolbarButton
        label="Highlight"
        active={info.active.has("highlight")}
        onRun={actions.toggleHighlight}
      >
        <HighlighterIcon className="size-4" />
      </ToolbarButton>
      {actions.createLink && (
        <ToolbarButton label="Link" onRun={actions.createLink}>
          <LinkIcon className="size-4" />
        </ToolbarButton>
      )}
    </div>
  );
}
