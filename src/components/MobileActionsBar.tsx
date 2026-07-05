import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  Indent,
  Outdent,
  Redo2,
  SquareCheck,
  SquareSlash,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useKeyboardViewport } from "../hooks/use-keyboard-viewport";

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

/** A coarse pointer ("this is a finger"). Mirrors use-mobile.ts's store shape. */
function subscribeCoarse(onChange: () => void) {
  const mql = window.matchMedia("(pointer: coarse)");
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeCoarse,
    () => window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );
}

/**
 * Whether an outline contentEditable span is currently focused (keyboard-up
 * state). `findFocusedId()` is non-null exactly when the active element is a
 * registered outline span, so it doubles as the "is editing" probe (ADR 0030).
 * focusout fires BEFORE the next focusin when moving between bullets, so we
 * re-check on the next frame to avoid a flicker when focus hops span-to-span.
 */
function useOutlineEditing(findFocusedId: () => string | null): boolean {
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const update = () => setEditing(findFocusedId() !== null);
    const onFocusOut = () => requestAnimationFrame(update);
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [findFocusedId]);
  return editing;
}

/**
 * One toolbar button. `onPointerDown` + `preventDefault` keeps the caret and
 * keyboard alive across the tap (a plain click would blur the span and drop the
 * button's target) — EVERY button does this now; there is no blur/dismiss button,
 * since iOS's own "Done" and Android's back gesture already dismiss the keyboard
 * (ADR 0030). `scale(0.96)` on press gives the tap tactile feedback.
 */
function BarButton({
  label,
  onRun,
  children,
}: {
  label: string;
  onRun: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-foreground/80",
        "transition-transform duration-100 ease-out active:scale-[0.96]",
        "active:bg-accent active:text-accent-foreground",
      )}
      onPointerDown={(e) => {
        // Keep focus on the contentEditable — see the component doc.
        e.preventDefault();
        onRun();
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
 * pointer and shows ONLY while a bullet is focused; rides above the software
 * keyboard via visualViewport. Presence = pointer, visibility = focus, position =
 * viewport — three orthogonal signals, kept separate on purpose.
 *
 * Styled as a floating frosted-glass CAPSULE, not a full-width edge bar, so it
 * reads as a sibling of iOS's own keyboard accessory pill (which the web can't
 * remove) rather than a second bar fighting it: same shape grammar (inset, big
 * radius, translucent, soft shadow), our app-action tier above their system tier.
 * We match the FAMILY, not iOS's exact tokens (those drift per OS version).
 */
export function MobileActionsBar({
  actions,
  findFocusedId,
}: {
  actions: MobileBarActions;
  findFocusedId: () => string | null;
}) {
  const coarse = useCoarsePointer();
  const editing = useOutlineEditing(findFocusedId);
  const keyboardOffset = useKeyboardViewport();

  // Presence gate: a mouse user never mounts the bar. Visibility gate: no bar
  // without a focused bullet, so every action has a valid target by construction.
  if (!coarse || !editing) return null;

  return (
    // Outer layer owns positioning: fixed to the bottom, lifted above the software
    // keyboard by the visualViewport gap, and the safe-area pad when it sits at the
    // real bottom (no keyboard). The pill inside centers within this.
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 transition-transform duration-200 ease-out"
      style={{
        transform: `translateY(-${keyboardOffset}px)`,
        paddingBottom:
          keyboardOffset === 0 ? "env(safe-area-inset-bottom)" : undefined,
      }}
    >
      <div
        role="toolbar"
        aria-label="Editing actions"
        data-mobile-bar
        className={cn(
          // max-w-full + overflow-x-auto: on a narrow / browser-zoomed viewport the
          // pill can't outgrow the padded outer (the outer's px-3 keeps it off the
          // screen edges), and if the buttons don't fit it scrolls horizontally
          // instead of clipping. Buttons are shrink-0, so they keep their 44px
          // targets and the strip scrolls rather than squashing; justify-start (the
          // flex default) keeps the leftmost button reachable when it does scroll.
          "flex max-w-full items-center gap-1 overflow-x-auto rounded-full px-1.5 py-1",
          // Frosted-glass material: translucent, blurred, hairline edge + soft
          // shadow (depth from shadow, not a hard border) — the iOS accessory
          // pill's grammar, resolved through our own theme tokens so it adapts to
          // light/dark. A more see-through now (/50). mb-1.5 floats it off
          // the very bottom edge.
          "mb-1.5 border border-border/50 bg-background/50 shadow-lg backdrop-blur-xl",
          "ring-1 ring-black/5 dark:ring-white/10",
        )}
      >
        <BarButton label="Outdent" onRun={actions.outdent}>
          <Outdent className="size-5" />
        </BarButton>
        <BarButton label="Indent" onRun={actions.indent}>
          <Indent className="size-5" />
        </BarButton>
        <Divider />
        <BarButton label="Undo" onRun={actions.undo}>
          <Undo2 className="size-5" />
        </BarButton>
        <BarButton label="Redo" onRun={actions.redo}>
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
      </div>
    </div>
  );
}
