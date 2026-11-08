import {
  Indent,
  Outdent,
  Redo2,
  SquareCheck,
  SquareSlash,
  Undo2,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

import { getOutlineScroller } from "../data/outline-scroll";
import { useCoarsePointer } from "../hooks/use-coarse-pointer";
import { useKeyboardViewport } from "../hooks/use-keyboard-viewport";
import { caretPosition } from "./caret-menu-utils";
import { useHistoryState } from "./history-restore";
import {
  FORMAT_BUTTONS,
  readFormatTarget,
  type SelectionFormatActions,
} from "./selection-format";
import {
  restoreSelection,
  type SelectionSnapshot,
  snapshotSelection,
} from "./wrap";

/**
 * The zero-arg command surface the bar drives. Each method resolves the focused
 * bullet internally (the facade `useMobileBarActions` in OutlineEditor), so the
 * bar itself stays dumb chrome — see ADR 0030.
 */
export interface MobileBarActions {
  outdent: () => void;
  indent: () => void;
  undo: () => void;
  redo: () => void;
  toggleComplete: () => void;
  /** Insert a literal "/" at the caret so the row's own detectSlash opens the
   *  command palette (insert-and-open, not a toggle). */
  insertSlash: () => void;
}

/**
 * DOM focus and a keyboard-sized viewport reduction are separate requirements:
 * dismissing the software keyboard need not blur its input. Never change the
 * editor's logical selection or blur an input just to hide this chrome.
 */
function useOutlineEditing(
  coarse: boolean,
  findFocusedId: () => string | null,
): boolean {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!coarse) return;
    // Iframes (the landing demo) have no distinct visual viewport. Preserve
    // their focus-only behavior rather than permanently hiding their actions.
    const viewport = window.top === window ? window.visualViewport : null;
    let raf = 0;
    let observed: HTMLElement | null = null;
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const observer = new MutationObserver(schedule);
    const update = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      const active = document.activeElement;
      const input =
        active instanceof HTMLElement &&
        active.isContentEditable &&
        findFocusedId() !== null
          ? active
          : null;
      if (input !== observed) {
        observer.disconnect();
        observed = input;
        if (input) {
          observer.observe(input, {
            attributes: true,
            attributeFilter: ["contenteditable"],
          });
          // WebKit does not emit blur when a virtualized focused row is removed.
          // Watch its ancestor chain, not the outline subtree or text mutations.
          for (
            let parent = input.parentElement;
            parent;
            parent = parent.parentElement
          ) {
            observer.observe(parent, { childList: true });
          }
        }
      }
      // Normalize pinch zoom so zoom alone cannot look like a keyboard. Ignore
      // small browser-chrome differences; viewport panning is not keyboard size.
      // Older engines without this API retain the focus-only fallback.
      const keyboard =
        !viewport ||
        window.innerHeight - viewport.height * viewport.scale > 100;
      setEditing(
        !!input && document.hasFocus() && !document.hidden && keyboard,
      );
    };
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", schedule);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    window.addEventListener("pageshow", update);
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", schedule);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      window.removeEventListener("pageshow", update);
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
    };
  }, [coarse, findFocusedId]);
  return coarse && editing;
}

function sameKeys(a: Set<string> | null, b: Set<string> | null): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && [...a].every((k) => b.has(k));
}

/**
 * The marker keys lit over the current selection, or null when there is no
 * formatting target (collapsed caret, cross-bullet range, a selected chip).
 * Non-null switches the bar into format mode (ADR 0069). Selection handles fire
 * `selectionchange` continuously while dragged, so reads are rAF-coalesced; the
 * bar sits at the keyboard, not over the text, so it can update live.
 */
function useFormatSelection(enabled: boolean): Set<string> | null {
  const [active, setActive] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const recompute = () => {
      raf = 0;
      const next = readFormatTarget()?.active ?? null;
      // Handles fire selectionchange every frame while dragged; re-render
      // only when the mode or the lit set actually changes.
      setActive((prev) => (sameKeys(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(recompute);
    };
    schedule();
    document.addEventListener("selectionchange", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("selectionchange", schedule);
      // The next editing session starts in edit mode, never on a stale set.
      setActive(null);
    };
  }, [enabled]);
  return enabled ? active : null;
}

/** Finger travel (px) past which a press is a scroll, not a tap. The pill is
 *  `overflow-x-auto`, so a horizontal drag to scroll it must NOT fire an action
 *  — mirrors the bullet-dot drag/click split (use-drag-reorder.ts). */
const TAP_MOVE_THRESHOLD = 10;

/**
 * One toolbar button. `onPointerDown` + `preventDefault` keeps the caret and
 * keyboard alive across the tap (a plain click would blur the span and drop the
 * button's target) — EVERY button does this now; there is no blur/dismiss button,
 * since iOS's own "Done" and Android's back gesture already dismiss the keyboard
 * (ADR 0030). `scale(0.96)` on press gives the tap tactile feedback.
 *
 * The action fires on `pointerup`, and ONLY if the finger stayed within
 * `TAP_MOVE_THRESHOLD` of where it landed — firing on `pointerdown` meant a
 * horizontal scroll of the pill triggered the button under your finger. The
 * `preventDefault` stays on `pointerdown` (that's what preserves focus; it does
 * NOT block the overflow scroll, which is governed by `touch-action`).
 */
function BarButton({
  label,
  onRun,
  children,
  disabled = false,
  active,
}: {
  label: string;
  onRun: () => void;
  children: ReactNode;
  disabled?: boolean;
  /** A format button's lit state; undefined for the plain action buttons. */
  active?: boolean;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-active={active || undefined}
      disabled={disabled}
      className={cn(
        "flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-foreground/80",
        "transition-transform duration-100 ease-out active:scale-[0.96]",
        "active:bg-accent active:text-accent-foreground",
        // Lit = re-press removes it (ADR 0069), so it must clear 3:1 on the glass.
        "data-[active]:bg-foreground data-[active]:text-background",
        "disabled:opacity-35 disabled:active:scale-100",
      )}
      onPointerDown={(e) => {
        // Keep focus on the contentEditable — see the component doc.
        e.preventDefault();
        start.current = { x: e.clientX, y: e.clientY };
        moved.current = false;
      }}
      onPointerMove={(e) => {
        if (!start.current || moved.current) return;
        if (
          Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) >
          TAP_MOVE_THRESHOLD
        ) {
          moved.current = true;
        }
      }}
      onPointerUp={() => {
        if (!disabled && start.current && !moved.current) onRun();
        start.current = null;
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-6 w-px shrink-0 bg-border/60" aria-hidden />;
}

/**
 * Mobile-only, keyboard-anchored action strip (ADR 0030). Mounts ONLY on a coarse
 * pointer and shows ONLY while an editable bullet has DOM focus and the software
 * keyboard reduces the visual viewport. Position still follows useKeyboardViewport.
 *
 * Styled as a floating frosted-glass CAPSULE, not a full-width edge bar, so it
 * reads as a sibling of iOS's own keyboard accessory pill (which the web can't
 * remove) rather than a second bar fighting it: same shape grammar (inset, big
 * radius, translucent, soft shadow), our app-action tier above their system tier.
 * We match the FAMILY, not iOS's exact tokens (those drift per OS version).
 */
export function MobileActionsBar({
  actions,
  formatActions,
  findFocusedId,
}: {
  actions: MobileBarActions;
  formatActions: SelectionFormatActions;
  findFocusedId: () => string | null;
}) {
  const coarse = useCoarsePointer();
  const editing = useOutlineEditing(coarse, findFocusedId);
  const { height, offsetTop } = useKeyboardViewport();
  const barRef = useRef<HTMLDivElement | null>(null);
  const reconcileCaret = useRef<(() => void) | null>(null);
  const history = useHistoryState();
  // Format mode (ADR 0069): a text selection inside one bullet swaps the node
  // actions for the formatting set. Never both — every node action targets the
  // whole bullet, and a lit format button re-pressed is the format's undo.
  const liveFormat = useFormatSelection(coarse && editing);
  // The selection as the finger landed, restored before the action runs.
  const pressSnapshot = useRef<SelectionSnapshot | null>(null);
  // Format mode holds for the length of a press. If WebKit drops the range
  // under the finger, the live read flips to edit mode before pointerup; the
  // button the finger is on must not unmount (or become Outdent) mid-tap.
  const [held, setHeld] = useState<Set<string> | null>(null);
  const formatActive = liveFormat ?? held;
  useEffect(() => {
    // Window bubble phase runs after the button's own pointerup, and still
    // fires when the finger lifts off the bar. Remove both listeners together
    // on unmount rather than leaving the unused one behind after every tap.
    const release = () => setHeld(null);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  // Run only once the toolbar exists: keyboard opening can otherwise reveal
  // against an empty frame and leave the caret underneath the newly mounted bar.
  useEffect(() => {
    const bar = barRef.current;
    const frame = bar?.parentElement;
    if (!editing || !bar || !frame) return;
    const scroller = getOutlineScroller()!;
    const viewport = window.top === window ? window.visualViewport : null;
    let raf = 0;
    let following = false;
    let observed: HTMLElement | null = null;
    const reveal = () => {
      raf = 0;
      if ((viewport?.scale ?? 1) > 1) return;
      // Today can focus an offscreen last child while deliberately showing the
      // day's title. The stream hands ownership to the caret on the first edit.
      if (document.querySelector(".outline-chrome[data-title-anchored]"))
        return;
      const el = document.activeElement;
      const selection = window.getSelection();
      if (
        !(el instanceof HTMLElement && el.isContentEditable) ||
        findFocusedId() === null ||
        !selection?.isCollapsed ||
        !selection.rangeCount ||
        !el.contains(selection.anchorNode)
      ) {
        following = false;
        return;
      }
      if (el !== observed) {
        if (observed) observer.unobserve(observed);
        observed = el;
        observer.observe(el);
      }
      const frameRect = frame.getBoundingClientRect();
      // Scrolling can pan Safari's visual viewport before the fixed frame's
      // React commit. Wait for that commit rather than chase stale geometry.
      if (
        viewport &&
        (Math.abs(parseFloat(frame.style.top) - viewport.offsetTop) > 1 ||
          Math.abs(frameRect.height - viewport.height) > 1)
      )
        return;
      // Safari can report offsetTop in layout coordinates while client rects
      // are relative to the visible band. Keep both bounds in rendered coords.
      let bottom = Math.min(frameRect.bottom, bar.getBoundingClientRect().top);
      let top = Math.max(
        frameRect.top,
        document.querySelector(".outline-chrome")?.getBoundingClientRect()
          .bottom ?? 0,
      );
      const { y } = caretPosition(el);
      const caretHeight =
        selection.getRangeAt(0).getBoundingClientRect().height ||
        parseFloat(getComputedStyle(el).lineHeight) ||
        24;
      // A landscape Safari keyboard can leave barely one line above the bar.
      // Reduce breathing room before giving up on revealing that line.
      const gap = Math.min(8, Math.max(0, (bottom - top - caretHeight) / 2));
      top += gap;
      bottom -= gap;
      // The last row needs real scroll range, not just a scroll request. Keep
      // the reservation for this editing session so Safari cannot clamp it away.
      scroller.style.setProperty(
        "--outline-keyboard-space",
        `${Math.max(0, scroller.getBoundingClientRect().bottom - bottom)}px`,
      );
      if (bottom - top < caretHeight) return;
      const delta =
        y > bottom
          ? y - bottom
          : y - caretHeight < top
            ? y - caretHeight - top
            : 0;
      if (Math.abs(delta) >= 1)
        scroller.scrollBy({ top: delta, behavior: "instant" });
    };
    const schedule = () => {
      following = true;
      if (!raf) raf = requestAnimationFrame(reveal);
    };
    const cancel = () => {
      following = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    // Follow late decoration and virtual-list measurements after an edit, not
    // just the first scroll. A reading/selection gesture releases that hold.
    const observer = new ResizeObserver((entries) => {
      if (following || entries.some((entry) => entry.target === frame))
        schedule();
    });
    reconcileCaret.current = () => {
      if (following) schedule();
    };
    observer.observe(frame);
    observer.observe(scroller);
    // The viewport stays fixed-height; late row measurements resize its content.
    observer.observe(scroller.firstElementChild!);
    schedule();
    document.addEventListener("input", schedule);
    document.addEventListener("compositionend", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("pointerdown", cancel);
    document.addEventListener("keydown", cancel);
    document.addEventListener("touchstart", cancel, { passive: true });
    document.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("resize", schedule);
    return () => {
      cancel();
      reconcileCaret.current = null;
      observer.disconnect();
      scroller.style.removeProperty("--outline-keyboard-space");
      document.removeEventListener("input", schedule);
      document.removeEventListener("compositionend", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("pointerdown", cancel);
      document.removeEventListener("keydown", cancel);
      document.removeEventListener("touchstart", cancel);
      document.removeEventListener("wheel", cancel);
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
    };
  }, [editing, findFocusedId]);
  useLayoutEffect(() => {
    reconcileCaret.current?.();
  }, [height, offsetTop]);

  // Presence gate: a mouse user never mounts the bar. Visibility gate: no bar
  // without a focused bullet, so every action has a valid target by construction.
  if (!coarse || !editing) return null;

  return (
    // A fixed frame fits the visible viewport; the pill sits at its bottom.
    // Only the pill takes pointer events, so the frame never blocks the editor.
    // Follow viewport changes directly, without a second CSS animation lagging
    // behind the keyboard's own animation.
    <div
      className="pointer-events-none fixed inset-x-0 z-40 flex items-end justify-center px-3"
      style={{
        top: offsetTop,
        height,
        paddingLeft: "max(12px, env(safe-area-inset-left))",
        paddingRight: "max(12px, env(safe-area-inset-right))",
        paddingBottom:
          height + offsetTop >= window.innerHeight
            ? "env(safe-area-inset-bottom)"
            : undefined,
      }}
    >
      <div
        ref={barRef}
        role="toolbar"
        aria-label={formatActive ? "Format selection" : "Editing actions"}
        data-mobile-bar
        data-mode={formatActive ? "format" : "edit"}
        onPointerDownCapture={() => {
          pressSnapshot.current = formatActive ? snapshotSelection() : null;
          setHeld(formatActive);
        }}
        className={cn(
          // max-w-full + overflow-x-auto: on a narrow / browser-zoomed viewport the
          // pill can't outgrow the padded outer (the outer's px-3 keeps it off the
          // screen edges), and if the buttons don't fit it scrolls horizontally
          // instead of clipping. Buttons are shrink-0, so they keep their 44px
          // targets and the strip scrolls rather than squashing; justify-start (the
          // flex default) keeps the leftmost button reachable when it does scroll.
          "pointer-events-auto flex max-w-full scroll-fade-x items-center gap-1 overflow-x-auto rounded-full px-1.5 py-1",
          // Frosted-glass material: translucent, blurred, hairline edge + soft
          // shadow (depth from shadow, not a hard border) — the iOS accessory
          // pill's grammar, resolved through our own theme tokens so it adapts to
          // light/dark. A more see-through now (/50). mb-1.5 floats it off
          // the very bottom edge.
          "mb-1.5 border border-border/50 bg-background/50 shadow-lg backdrop-blur-xl",
          "ring-1 ring-black/5 dark:ring-white/10",
        )}
      >
        {formatActive ? (
          FORMAT_BUTTONS.map((btn, i) => {
            const run = btn.action(formatActions);
            if (!run) return null;
            return (
              <Fragment key={btn.key}>
                {i > 0 && FORMAT_BUTTONS[i - 1]?.group !== btn.group && (
                  <Divider />
                )}
                <BarButton
                  label={btn.label}
                  active={btn.marker ? formatActive.has(btn.key) : undefined}
                  onRun={() => {
                    restoreSelection(pressSnapshot.current);
                    run();
                  }}
                >
                  <btn.Icon className="size-5" />
                </BarButton>
              </Fragment>
            );
          })
        ) : (
          <>
            <BarButton label="Outdent" onRun={actions.outdent}>
              <Outdent className="size-5" />
            </BarButton>
            <BarButton label="Indent" onRun={actions.indent}>
              <Indent className="size-5" />
            </BarButton>
            <Divider />
            <BarButton
              label={history.undoLabel}
              onRun={actions.undo}
              disabled={!history.canUndo}
            >
              <Undo2 className="size-5" />
            </BarButton>
            <BarButton
              label={history.redoLabel}
              onRun={actions.redo}
              disabled={!history.canRedo}
            >
              <Redo2 className="size-5" />
            </BarButton>
            <Divider />
            {/* A boxed check, deliberately NOT a bare ✓ — iOS's accessory pill shows a
              bare "Done" check right below, and two identical checks that mean
              different things (complete-bullet vs dismiss-keyboard) read as a bug. */}
            <BarButton label="Toggle complete" onRun={actions.toggleComplete}>
              <SquareCheck className="size-5" />
            </BarButton>
            <BarButton label="Command menu" onRun={actions.insertSlash}>
              <SquareSlash className="size-5" />
            </BarButton>
          </>
        )}
      </div>
    </div>
  );
}
