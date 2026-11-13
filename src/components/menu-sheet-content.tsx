import { Sheet } from "@onlymoein/liquidglass";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type ComponentProps,
} from "react";
import { OverlayTriggerStateContext } from "react-aria-components/Dialog";

import { useTheme } from "./theme-provider";

export default function MenuSheetContent({
  title,
  children,
  isOpen,
  onOpenChange,
  onAfterClose,
  detents,
}: {
  title: string;
  children: ReactNode;
  /** Omit both to follow the enclosing DialogTrigger. */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onAfterClose?: () => void;
  detents?: ComponentProps<typeof Sheet>["detents"];
}) {
  const trigger = useContext(OverlayTriggerStateContext);
  const { theme } = useTheme();
  const open = isOpen ?? trigger?.isOpen ?? false;
  const setOpen = onOpenChange ?? trigger?.setOpen;
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<"pointer" | "keyboard" | null>(null);
  const keyboardOpen = useRef(false);
  const afterClose = useRef(onAfterClose);
  useLayoutEffect(() => {
    afterClose.current = onAfterClose;
  }, [onAfterClose]);

  useEffect(() => {
    const dialog = host.current?.querySelector("dialog");
    if (!dialog) return;
    // Native close, not the start of exit: link edits and dialog handoffs must
    // wait until the top layer releases focus and makes the page interactive.
    const closed = () => {
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        focused.hasAttribute("data-sheet-trigger")
      ) {
        focused.toggleAttribute(
          "data-sheet-pointer-dismissed",
          input.current === "pointer",
        );
      }
      input.current = null;
      keyboardOpen.current = false;
      afterClose.current?.();
    };
    dialog.addEventListener("close", closed);
    return () => dialog.removeEventListener("close", closed);
  }, []);

  return (
    <div
      ref={host}
      className="contents"
      data-theme={theme === "system" ? undefined : theme}
      onPointerDownCapture={() => {
        input.current = "pointer";
      }}
      onKeyDownCapture={(event) => {
        input.current = "keyboard";
        // Base UI's parent dialog must not also handle this child's Escape.
        if (event.key === "Escape") event.stopPropagation();
      }}
      onFocusCapture={(event) => {
        if (
          event.relatedTarget instanceof HTMLElement &&
          event.relatedTarget.hasAttribute("data-sheet-trigger")
        ) {
          keyboardOpen.current = event.relatedTarget.hasAttribute(
            "data-sheet-keyboard-open",
          );
        }
        if (!(event.target instanceof HTMLDialogElement)) return;
        // Touch/mouse openings keep focus on the named dialog, not a menu row.
        // Requested form fields and keyboard/assistive openings still get a
        // useful initial control, without panning the native modal viewport.
        event.target
          .querySelector<HTMLElement>(
            keyboardOpen.current
              ? '[data-sheet-autofocus], [autofocus], button[role^="menuitem"]:not(:disabled)'
              : "[data-sheet-autofocus], [autofocus]",
          )
          ?.focus({ preventScroll: true });
      }}
    >
      <Sheet
        aria-label={title}
        open={open}
        onOpenChange={setOpen}
        detents={detents}
      >
        {children}
      </Sheet>
    </div>
  );
}
