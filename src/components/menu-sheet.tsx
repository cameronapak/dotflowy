import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { mergeProps, mergeRefs } from "@react-aria/utils";
import {
  cloneElement,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button as AriaButton } from "react-aria-components/Button";
import { Heading } from "react-aria-components/Dialog";
import {
  Sheet,
  SheetBackdrop,
  SheetContent,
  SheetOverlay,
} from "react-aria-components/Sheet";

import { Button } from "./ui/button";

/** Preserve the existing native-button/render API while letting RAC register
 * its press handlers and trigger ref on the actual button. */
export function MenuSheetButton({
  render,
  ...props
}: ComponentProps<"button"> & {
  render?: ReactElement<ComponentProps<"button">>;
}) {
  return (
    <AriaButton
      isDisabled={props.disabled}
      className={props.className ?? ""}
      render={(ariaProps) =>
        cloneElement(render ?? <button />, {
          ...mergeProps(render?.props ?? {}, props, ariaProps),
          ref: mergeRefs(render?.props.ref, props.ref, ariaProps.ref),
        })
      }
    >
      {props.children ?? render?.props.children}
    </AriaButton>
  );
}

/** React Aria owns gestures, keyboard geometry, focus and entry/exit. Keep the
 * destination sheet inside Quick-add's DOM focus boundary, not a foreign portal. */
export function MenuSheetContent({
  title,
  compact = false,
  children,
}: {
  title: string;
  compact?: boolean;
  children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const parentDialog = anchor?.closest<HTMLElement>('[role="dialog"]');
  return (
    <>
      <span ref={setAnchor} className="contents" />
      {anchor && (
        <SheetOverlay
          className="menu-sheet-overlay"
          data-nested={parentDialog ? "" : undefined}
          UNSTABLE_portalContainer={parentDialog ? anchor : undefined}
        >
          <SheetBackdrop
            className="menu-sheet-backdrop"
            swipeAnimation="sheet-backdrop"
          />
          <Sheet
            className="sheet-surface"
            data-compact={compact ? "" : undefined}
            overscrollPadding
            stackAnimation="sheet-scale-back"
          >
            <div className="sheet-handle" aria-hidden="true" />
            <SheetContent
              className="sheet-menu-content scroll-fade"
              render={(props) => (
                <section
                  {...props}
                  onFocus={(e) => {
                    props.onFocus?.(e);
                    if (e.target === e.currentTarget)
                      e.currentTarget
                        .querySelector<HTMLButtonElement>(
                          'button[role^="menuitem"]:not(:disabled)',
                        )
                        ?.focus({ preventScroll: true });
                  }}
                />
              )}
            >
              <div className="sheet-menu-header flex items-center justify-between gap-2">
                <Heading slot="title" className="font-medium">
                  {title}
                </Heading>
                <AriaButton
                  slot="close"
                  aria-label="Close"
                  render={(props) => (
                    <Button
                      {...props}
                      variant="ghost"
                      size="icon"
                      className="size-11"
                    />
                  )}
                >
                  <HugeiconsIcon icon={Cancel01Icon} aria-hidden="true" />
                </AriaButton>
              </div>
              <div className="sheet-menu-body">{children}</div>
            </SheetContent>
          </Sheet>
        </SheetOverlay>
      )}
    </>
  );
}
