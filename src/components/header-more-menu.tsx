import type { ComponentProps, ReactElement } from "react";

import { Avatar } from "@base-ui/react/avatar";
import { useNavigate, useParams } from "@tanstack/react-router";

import {
  BookmarkIcon,
  CircleCheckIcon,
  CollapseIcon,
  CopyIcon,
  ExpandIcon,
  FileIcon,
  FocusIcon,
  LogoutIcon,
  MessageWarningIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SlidersIcon,
  SparklesIcon,
  UserIcon,
} from "@/lib/icons";

import { useUnseenReleaseCount } from "../data/changelog-cursor";
import { openFeedbackReport } from "../data/feedback";
import { useMembership } from "../data/membership";
import { toggleBookmark } from "../data/mutations";
import {
  copyOutlineAsMarkdown,
  setViewCollapsed,
} from "../data/outline-actions";
import { PLAN_LABELS } from "../data/plans";
import { useTree } from "../data/useTree";
import { getViewRootId } from "../data/view-state";
import { useIsMobile } from "../hooks/use-mobile";
import { signOutAndReload, useSession } from "../lib/auth-client";
import { usePluginChrome } from "../plugins/registry";
import { openChangelog } from "./changelog-opener";
import { openMembership } from "./membership-opener";
import { openFilterInput } from "./query-filter-nav";
import { useShowCompleted } from "./show-completed-provider";
import { setSpotlightEnabled, useSpotlightEnabled } from "./spotlight-mode";
import { Button } from "./ui/button";
import {
  ResponsiveMenu as DropdownMenu,
  ResponsiveMenuCheckboxItem as DropdownMenuCheckboxItem,
  ResponsiveMenuContent as DropdownMenuContent,
  ResponsiveMenuItem as DropdownMenuItem,
  ResponsiveMenuSeparator as DropdownMenuSeparator,
  ResponsiveMenuTrigger as DropdownMenuTrigger,
} from "./ui/responsive-menu";

/**
 * GitHub's brand glyph (Simple Icons), preserved separately from UI icons.
 * The mark is fill-based, currentColor, and
 * left unsized so the menu item's `[&_svg]:size-4` rule matches it to the rest.
 */
function GitHubIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

/** Current-view actions and display toggles, separate from account/help (ADR 0072). */
function ViewMenuItems() {
  const mobile = useIsMobile();
  const { globalActions } = usePluginChrome();
  const { showCompleted, setShowCompleted } = useShowCompleted();
  const spotlight = useSpotlightEnabled();
  const { index } = useTree();
  const rootId = useParams({ strict: false }).nodeId ?? null;
  const current = rootId ? index.byId.get(rootId) : null;

  return (
    <>
      <div
        role="presentation"
        className="px-1.5 py-1 text-xs font-medium text-muted-foreground"
      >
        This view
      </div>
      {mobile && (
        <DropdownMenuItem onAfterClose={openFilterInput}>
          <SearchIcon />
          Filter this view
        </DropdownMenuItem>
      )}
      {current && (
        <DropdownMenuCheckboxItem
          checked={current.bookmarkedAt != null}
          onCheckedChange={(checked) => toggleBookmark(current.id, checked)}
        >
          <BookmarkIcon />
          Bookmark this page
        </DropdownMenuCheckboxItem>
      )}

      <DropdownMenuItem onClick={() => setViewCollapsed(getViewRootId(), true)}>
        <CollapseIcon />
        Collapse all
      </DropdownMenuItem>

      <DropdownMenuItem
        onClick={() => setViewCollapsed(getViewRootId(), false)}
      >
        <ExpandIcon />
        Expand all
      </DropdownMenuItem>

      <DropdownMenuItem
        onClick={() => void copyOutlineAsMarkdown(getViewRootId())}
      >
        <CopyIcon />
        Copy as Markdown
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <div
        role="presentation"
        className="px-1.5 py-1 text-xs font-medium text-muted-foreground"
      >
        Display
      </div>
      <DropdownMenuCheckboxItem
        checked={showCompleted}
        onCheckedChange={setShowCompleted}
      >
        <CircleCheckIcon />
        Show completed
      </DropdownMenuCheckboxItem>

      <DropdownMenuCheckboxItem
        checked={spotlight}
        onCheckedChange={setSpotlightEnabled}
      >
        <FocusIcon />
        Spotlight mode
      </DropdownMenuCheckboxItem>

      {globalActions
        .filter(
          (action) => action.menuLabel && (action.available?.(rootId) ?? true),
        )
        .map((action) =>
          action.checked === undefined ? (
            <DropdownMenuItem
              key={action.id}
              disabled={action.disabled}
              onAfterClose={() => action.run(rootId)}
            >
              <action.icon />
              {action.menuLabel}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuCheckboxItem
              key={action.id}
              checked={action.checked}
              disabled={action.disabled}
              onCheckedChange={() => action.run(rootId)}
            >
              <action.icon />
              {action.menuLabel}
            </DropdownMenuCheckboxItem>
          ),
        )}
    </>
  );
}

export function HeaderViewMenu() {
  return (
    <DropdownMenu title="View options">
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" title="View options">
            <SlidersIcon />
            <span className="sr-only">View options</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-52">
        <ViewMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The signed-in person's photo, email initial, or a user glyph (ADR 0072). */
function AccountAvatar() {
  const { data: session } = useSession();
  return (
    <Avatar.Root
      aria-hidden="true"
      className="inline-flex size-6 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground"
    >
      <Avatar.Fallback className="flex size-full items-center justify-center">
        {session?.user.email?.charAt(0).toUpperCase() || <UserIcon />}
      </Avatar.Fallback>
      <Avatar.Image
        src={session?.user.image ?? undefined}
        alt=""
        referrerPolicy="no-referrer"
        keepMounted
        className="absolute size-6 rounded-full object-cover data-error:invisible data-loading:invisible"
      />
    </Avatar.Root>
  );
}

function AppMenuItems() {
  const navigate = useNavigate();
  const unseen = useUnseenReleaseCount();
  const { plan } = useMembership();
  const paid = plan !== null && plan !== "free";
  return (
    <>
      <DropdownMenuItem
        onAfterClose={() =>
          plan === "free"
            ? openMembership()
            : void navigate({ to: "/settings", hash: "billing" })
        }
      >
        <SparklesIcon />
        {paid ? `${PLAN_LABELS[plan]} member` : "Membership"}
        {!paid && plan === "free" && (
          <span className="ml-auto text-xs text-muted-foreground">Free</span>
        )}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onAfterClose={() => void navigate({ to: "/settings" })}>
        <SettingsIcon />
        Settings
      </DropdownMenuItem>

      {/* The permanent home for the changelog (ADR 0046). While releases
        are unread, it's emphasized -- bolder text + a solid count pill --
        so the eye lands here once the trigger's dot draws the menu open. */}
      <DropdownMenuItem
        onAfterClose={openChangelog}
        data-unseen={unseen > 0 ? "" : undefined}
        className={unseen > 0 ? "font-medium" : undefined}
      >
        <SparklesIcon />
        What's new
        {unseen > 0 && (
          // `text-primary-foreground!` is deliberate: the DropdownMenuItem's
          // `focus:**:text-accent-foreground` recolors EVERY descendant on
          // hover, which would flip this number to near-white on the near-
          // white pill (an unreadable white circle). The bang shields it so
          // the chip stays legible at rest and on hover, both themes.
          <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground! tabular-nums">
            {unseen}
          </span>
        )}
      </DropdownMenuItem>

      <DropdownMenuItem onAfterClose={() => openFeedbackReport()}>
        <MessageWarningIcon />
        {paid ? "Send feedback" : "Report a bug"}
      </DropdownMenuItem>

      <DropdownMenuItem
        onClick={() =>
          window.open(
            "https://git.new/dotflowy",
            "_blank",
            "noopener,noreferrer",
          )
        }
      >
        <GitHubIcon />
        GitHub
      </DropdownMenuItem>

      {/* Legal pages (#285/#286): read-only links, so they live with the
        other link items (What's new, GitHub) rather than /settings. */}
      <DropdownMenuItem
        onClick={() => window.open("/terms", "_blank", "noopener,noreferrer")}
      >
        <FileIcon />
        Terms
      </DropdownMenuItem>

      <DropdownMenuItem
        onClick={() => window.open("/privacy", "_blank", "noopener,noreferrer")}
      >
        <ShieldCheckIcon />
        Privacy Policy
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <DropdownMenuItem
        variant="destructive"
        onClick={() => signOutAndReload()}
      >
        <LogoutIcon />
        Sign out
      </DropdownMenuItem>
    </>
  );
}

/** Account, help, and the unread-release signal live on the avatar (ADR 0072). */
export function HeaderAppMenu() {
  const unseen = useUnseenReleaseCount();

  return (
    <DropdownMenu title="Account and help">
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            title="Account and help"
            aria-label={
              unseen > 0
                ? "Account and help (new releases available)"
                : "Account and help"
            }
            className="relative rounded-full"
          >
            <AccountAvatar />
            {unseen > 0 && (
              <span
                data-changelog-dot=""
                aria-hidden="true"
                className="absolute top-0 right-0 size-2 rounded-full bg-primary ring-2 ring-background"
              />
            )}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-44">
        <AppMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Narrow screens: View options and Account and help share one More menu, as in
 * iOS toolbars, so the parent page name keeps its room (ADR 0076). Desktop
 * keeps the two separate menus (ADR 0072).
 */
export function HeaderMoreMenu({
  trigger,
}: {
  trigger: ReactElement<ComponentProps<"button">>;
}) {
  return (
    <DropdownMenu title="More">
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="end" className="min-w-52">
        <ViewMenuItems />
        <DropdownMenuSeparator />
        <div
          role="presentation"
          className="px-1.5 py-1 text-xs font-medium text-muted-foreground"
        >
          Account and help
        </div>
        <AppMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
