import { mergeProps, mergeRefs } from "@react-aria/utils";
import {
  cloneElement,
  lazy,
  Suspense,
  type ComponentProps,
  type ReactElement,
} from "react";
import { Button as AriaButton } from "react-aria-components/Button";

const Content = lazy(() => import("./menu-sheet-content"));

/** Register the actual button with React Aria's trigger state, without mounting
 * a second overlay, focus trap, or gesture engine around the native Sheet. */
export function MenuSheetButton({
  render,
  ...props
}: ComponentProps<"button"> & {
  render?: ReactElement<ComponentProps<"button">>;
}) {
  return (
    <AriaButton
      isDisabled={props.disabled}
      data-sheet-trigger=""
      onPressStart={({ target, pointerType }) =>
        target.toggleAttribute(
          "data-sheet-keyboard-open",
          pointerType === "keyboard" || pointerType === "virtual",
        )
      }
      onKeyDown={(event) =>
        event.currentTarget.removeAttribute("data-sheet-pointer-dismissed")
      }
      onBlur={(event) =>
        event.currentTarget.removeAttribute("data-sheet-pointer-dismissed")
      }
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

/** Keep Liquidglass off the wide desktop's initial editor graph. */
export function MenuSheetContent(props: ComponentProps<typeof Content>) {
  return (
    <Suspense fallback={null}>
      <Content {...props} />
    </Suspense>
  );
}
