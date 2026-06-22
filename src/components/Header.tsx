import type { ReactNode } from "react";
import { ModeToggle } from "./mode-toggle";
import { ShowCompletedToggle } from "./show-completed-toggle";

/**
 * App header row: breadcrumb trail on the left (passed as children, since it's
 * owned by OutlineEditor's zoom logic), theme switcher on the right. The
 * breadcrumb still renders its Home button at the top level, so the header is
 * present on every view including the home page.
 *
 * Horizontal padding matches the outline content's `p-6` so the row aligns
 * with the bullets below it.
 */
export function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="border-b">
      {/* Border spans the full viewport; inner row is centered to match the
          720px outline content below. */}
      <div className="mx-auto flex max-w-[720px] items-center justify-between gap-3 px-6 py-3">
        <div className="min-w-0 flex-1">{children}</div>
        <div className="flex shrink-0 items-center gap-1">
          <ShowCompletedToggle />
          <ModeToggle />
        </div>
      </div>
    </header>
  );
}
