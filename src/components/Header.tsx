import { Fragment, type ReactNode } from "react";

import type { PluginContext } from "../plugins/types";

import { headerSlots } from "../plugins/registry";
import { AgentPresenceChip } from "./add-agent";
import { BookmarkStar } from "./bookmarks";
import { HeaderMoreMenu } from "./header-more-menu";
import { CommandCenterButton } from "./node-switcher";
import { FilterButton } from "./query-filter";
import { SpotlightIndicator } from "./spotlight-indicator";

/**
 * App header row: breadcrumb trail on the left (passed as children, since it's
 * owned by OutlineEditor's zoom logic), action cluster on the right (search +
 * the contextual bookmark star + plugin header slots, with secondary actions in
 * the "More" overflow menu). The breadcrumb still renders its Home button at the
 * top level, so the header is present on every view including the home page.
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
      <div className="mx-auto flex max-w-[720px] items-center justify-between gap-3 px-6 py-3 max-sm:px-4">
        <div className="min-w-0 flex-1">{children}</div>
        {/* Right cluster: spotlight (ADR 0033), BYOA presence chip when live
            (ADR 0059), plugin header slots (Today), BookmarkStar, filter +
            Cmd+K, More (Add agent entry + unread changelog dot). */}
        <div className="flex shrink-0 items-center gap-1">
          <SpotlightIndicator />
          <AgentPresenceChip />
          {getCtx &&
            headerSlots.map((s) => (
              <Fragment key={s.id}>{s.render(getCtx)}</Fragment>
            ))}
          <BookmarkStar />
          <FilterButton />
          <CommandCenterButton />
          <HeaderMoreMenu />
        </div>
      </div>
    </header>
  );
}
