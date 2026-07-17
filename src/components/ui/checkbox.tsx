import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/*
 * NOTE: shadcn ships this with `after:absolute after:-inset-x-3 after:-inset-y-2`
 * -- an invisible ::after that inflates the 16px box to 40x32 for touch. It is
 * deliberately REMOVED here, and a re-sync from upstream must not bring it back.
 *
 * In the outline, the checkbox is a gutter control with only 6px of clearance to
 * the text on its right (`.row-body > :not(.node-text)`'s margin) and 6px to the
 * bullet on its left (`.outline-row`'s gap). A 12px-per-side ::after overshoots
 * both by 6px; the right arm lands on the first characters of the text and eats
 * clicks meant to place a caret or start a selection, toggling the task instead.
 *
 * Touch sizing is `touch-hitbox`'s job instead (see styles.css): it expands the
 * target vertically only, and widens by an explicit opt-in per control that has
 * room -- which is what keeps neighbouring controls from refighting for taps.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input transition-colors outline-none group-has-disabled/field:opacity-50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
