import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Indent,
  Outdent,
  Redo2,
  Slash,
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
  /** Blur the focused span to dismiss the software keyboard. */
  dismiss: () => void;
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
 * button's target). The dismiss button reuses this and its `run` is the lone
 * `el.blur()` — the preventDefault still fires, so the tap is deterministic.
 */
function BarButton({
  label,
  onRun,
  children,
  className,
}: {
  label: string;
  onRun: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-foreground/80",
        "active:bg-accent active:text-accent-foreground",
        className,
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
  return <span className="mx-0.5 h-6 w-px shrink-0 bg-border" aria-hidden />;
}

/**
 * Mobile-only, keyboard-anchored action strip (ADR 0030). Mounts ONLY on a coarse
 * pointer and shows ONLY while a bullet is focused; rides above the software
 * keyboard via visualViewport. Presence = pointer, visibility = focus, position =
 * viewport — three orthogonal signals, kept separate on purpose.
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

  // Presence gate: a mouse user never mounts the bar (the CSS @media below is a
  // second line of defense). Visibility gate: no bar without a focused bullet, so
  // every action has a valid target by construction.
  if (!coarse || !editing) return null;

  return (
    <div
      role="toolbar"
      aria-label="Editing actions"
      data-mobile-bar
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 flex items-center gap-1 overflow-x-auto",
        "border-t border-border bg-background/95 px-2 py-1 backdrop-blur",
        "transition-transform duration-200 ease-out",
      )}
      style={{
        transform: `translateY(-${keyboardOffset}px)`,
        // Only pad for the home-indicator safe area when the bar sits at the real
        // bottom (no keyboard shrinking the viewport); when lifted above the
        // keyboard the keyboard itself covers that inset.
        paddingBottom:
          keyboardOffset === 0 ? "env(safe-area-inset-bottom)" : undefined,
      }}
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
      <BarButton label="Toggle complete" onRun={actions.toggleComplete}>
        <Check className="size-5" />
      </BarButton>
      <BarButton label="Command menu" onRun={actions.insertSlash}>
        <Slash className="size-5" />
      </BarButton>
      {/* Dismiss is pushed to the far right so a mistap doesn't land on it and
          collapse the keyboard mid-edit. */}
      <BarButton
        label="Close keyboard"
        onRun={actions.dismiss}
        className="ms-auto"
      >
        <ChevronDown className="size-5" />
      </BarButton>
    </div>
  );
}
