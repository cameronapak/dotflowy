import { Fragment, type ReactNode } from "react";
import { AccountMenu } from "./account-menu";
import { BookmarkStar } from "./bookmarks";
import { ModeToggle } from "./mode-toggle";
import { NodeSearchButton } from "./node-switcher";
import { ShowCompletedToggle } from "../plugins/todos/show-completed-toggle";
import { headerSlots } from "../plugins/registry";
import type { PluginContext } from "../plugins/types";

/**
 * App header row: breadcrumb trail on the left (passed as children, since it's
 * owned by OutlineEditor's zoom logic), theme switcher on the right. The
 * breadcrumb still renders its Home button at the top level, so the header is
 * present on every view including the home page.
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
  return (
    <header className="border-b bg-background">
      {/* Border spans the full viewport; inner row is centered to match the
          720px outline content below. */}
      <div className="mx-auto flex max-w-[720px] items-center justify-between gap-3 px-6 py-3">
        <div className="min-w-0 flex-1">{children}</div>
        {/* Right cluster: plugin header slots lead (the daily Today button),
            then the focused-node action (BookmarkStar renders itself + its
            trailing divider only when zoomed), then the global actions. */}
        <div className="flex shrink-0 items-center gap-1">
          {getCtx &&
            headerSlots.map((s) => (
              <Fragment key={s.id}>{s.render(getCtx)}</Fragment>
            ))}
          <BookmarkStar />
          <NodeSearchButton />
          <ShowCompletedToggle />
          <ModeToggle />
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
