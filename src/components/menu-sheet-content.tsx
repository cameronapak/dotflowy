import { Sheet } from "@onlymoein/liquidglass";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { OverlayTriggerStateContext } from "react-aria-components/Dialog";

import { useTheme } from "./theme-provider";

export default function MenuSheetContent({
  title,
  children,
  isOpen,
  onOpenChange,
  onAfterClose,
}: {
  title: string;
  children: ReactNode;
  /** Omit both to follow the enclosing DialogTrigger. */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onAfterClose?: () => void;
}) {
  const trigger = useContext(OverlayTriggerStateContext);
  const { theme } = useTheme();
  const open = isOpen ?? trigger?.isOpen ?? false;
  const setOpen = onOpenChange ?? trigger?.setOpen;
  const host = useRef<HTMLDivElement>(null);
  const input = useRef<"pointer" | "keyboard" | null>(null);
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
        if (!(event.target instanceof HTMLDialogElement)) return;
        // The package focuses its dialog after showModal. Focus the existing
        // form's requested field, or the first menu item, without page panning.
        event.target
          .querySelector<HTMLElement>(
            '[data-sheet-autofocus], [autofocus], button[role^="menuitem"]:not(:disabled)',
          )
          ?.focus({ preventScroll: true });
      }}
    >
      <Sheet aria-label={title} open={open} onOpenChange={setOpen}>
        {children}
      </Sheet>
    </div>
  );
}
