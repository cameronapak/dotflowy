import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, lazy, Suspense, type ReactNode } from "react";

import type { PluginContext } from "../plugins/types";

import { useIsMobile } from "../hooks/use-mobile";
import { usePluginChrome } from "../plugins/registry";
import { HeaderAppMenu, HeaderViewMenu } from "./header-more-menu";
import { CommandCenterButton } from "./node-switcher";
import { FilterButton } from "./query-filter";
import { openQuickAdd } from "./quick-add-opener";
import { SpotlightIndicator } from "./spotlight-indicator";
import { Button } from "./ui/button";

const MobileNavigation = lazy(() => import("./MobileNavigation"));

/**
 * App header row: breadcrumb trail on the left (passed as children, since it's
 * owned by OutlineEditor's zoom logic), action cluster on the right (search +
 * plugin header slots, with page actions and display toggles in
 * the View and App menus). At Home the mobile breadcrumb is omitted; the dock
 * owns navigation. Desktop keeps its existing Home button (ADR 0076).
 *
 * Horizontal padding matches the outline content's `p-6` so the row aligns
 * with the bullets below it.
 *
 * `getCtx` is OutlineEditor's PluginContext factory, threaded down so plugin
 * header slots (Seam F-header) can act on the tree/nav -- the daily "Today"
 * button uses it to create-and-navigate. Optional so the header still renders
 * if ever mounted without an editor.
 */
export function Header({
  children,
  getCtx,
}: {
  children?: ReactNode;
  getCtx?: () => PluginContext;
}) {
  const mobile = useIsMobile();
  const { headerSlots } = usePluginChrome();
  return (
    <>
      <header className="outline-header border-b bg-background">
        {/* Border spans the full viewport; inner row is centered to match the
          720px outline content below. */}
        <div className="mx-auto flex max-w-[720px] items-center justify-between gap-3 px-6 py-3 max-sm:px-4">
          <div className="min-w-0 flex-1">{children}</div>
          {/* Narrow screens put destinations in the dock and actions here.
            Desktop retains the existing header controls (ADR 0076). */}
          <div className="flex shrink-0 items-center gap-1">
            <SpotlightIndicator />
            {getCtx &&
              headerSlots
                .filter((s) => !mobile || !s.mobileTab)
                .map((s) => <Fragment key={s.id}>{s.render(getCtx)}</Fragment>)}
            {!mobile && <FilterButton />}
            <CommandCenterButton mobile={mobile} />
            <HeaderViewMenu />
            <HeaderAppMenu />
            {mobile && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Quick add"
                onClick={openQuickAdd}
              >
                <span className="mobile-quick-add-glyph">
                  <HugeiconsIcon icon={PlusSignIcon} />
                </span>
              </Button>
            )}
          </div>
        </div>
      </header>
      {mobile && getCtx && (
        <Suspense fallback={null}>
          <MobileNavigation slots={headerSlots} getCtx={getCtx} />
        </Suspense>
      )}
    </>
  );
}
