import { Fragment, lazy, Suspense, type ReactNode } from "react";

import type { PluginContext } from "../plugins/types";

import { useIsMobile } from "../hooks/use-mobile";
import { usePluginChrome } from "../plugins/registry";
import { HeaderAppMenu, HeaderViewMenu } from "./header-more-menu";
import { CommandCenterButton } from "./node-switcher";
import { FilterButton } from "./query-filter";
import { SpotlightIndicator } from "./spotlight-indicator";

const MobileNavigation = lazy(() => import("./MobileNavigation"));
const MobileGlassHeader = lazy(() => import("./MobileGlassHeader"));

/**
 * App header row: breadcrumb trail on the left (passed as children, since it's
 * owned by OutlineEditor's zoom logic), action cluster on the right (search +
 * plugin header slots, with page actions and display toggles in
 * the View and App menus). Below 768px the glass toolbar and the dock replace
 * this row (ADR 0076); desktop keeps it.
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
      {mobile ? (
        // One boundary for the toolbar and the dock, so they reveal together
        // instead of React throttling a second reveal on a timer.
        <Suspense fallback={<div className="h-15" />}>
          <MobileGlassHeader
            leading={children}
            slots={headerSlots}
            getCtx={getCtx}
          />
          {getCtx && <MobileNavigation slots={headerSlots} getCtx={getCtx} />}
        </Suspense>
      ) : (
        <header className="outline-header border-b bg-background">
          {/* Border spans the full viewport; inner row is centered to match the
            720px outline content below. */}
          <div className="mx-auto flex max-w-[720px] items-center justify-between gap-3 px-6 py-3">
            <div className="min-w-0 flex-1">{children}</div>
            <div className="flex shrink-0 items-center gap-1">
              <SpotlightIndicator />
              {getCtx &&
                headerSlots.map((s) => (
                  <Fragment key={s.id}>{s.render(getCtx)}</Fragment>
                ))}
              <FilterButton />
              <CommandCenterButton />
              <HeaderViewMenu />
              <HeaderAppMenu />
            </div>
          </div>
        </header>
      )}
    </>
  );
}
