import { Avatar } from "@base-ui/react/avatar";
import {
  ArrowShrinkIcon,
  ArrowExpandIcon,
  BubbleChatNotificationIcon,
  CheckmarkCircle01Icon,
  Copy01Icon,
  File01Icon,
  FocusIcon,
  Logout01Icon,
  Settings01Icon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { useUnseenReleaseCount } from "../data/changelog-cursor";
import { localDateKey } from "../data/date-links";
import { downloadTextFile } from "../data/download";
import { openFeedbackReport } from "../data/feedback";
import { flattenInline } from "../data/inline-text";
import { outlineToMarkdown } from "../data/markdown";
import { toggleCollapsed } from "../data/mutations";
import { exportOpml } from "../data/opml-export";
import { runStructural } from "../data/structural";
import { childrenOf } from "../data/tree";
import { getTreeIndex } from "../data/tree-store";
import { getViewRootId } from "../data/view-state";
import { signOutAndReload, useSession } from "../lib/auth-client";
import { usePluginChrome } from "../plugins/registry";
import { openChangelog } from "./changelog-opener";
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
 * GitHub's brand glyph (Simple Icons). lucide-react dropped its Github icon, so
 * we inline the mark here -- fill-based (not lucide's stroke), currentColor, and
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

/**
 * Copy the current view's subtree to the clipboard as a markdown bullet list.
 * Scope is the zoom root (read live at click time), or every top-level node at
 * home -- the header is contextual to the current zoom view. See ADR 0017.
 */
export async function copyOutlineAsMarkdown() {
  const index = getTreeIndex();
  const rootId = getViewRootId();
  const rootIds = rootId ? [rootId] : childrenOf(index, null).map((n) => n.id);
  const markdown = outlineToMarkdown(index, rootIds);
  if (!markdown) {
    toast("Nothing to copy");
    return;
  }
  try {
    await navigator.clipboard.writeText(markdown);
    toast.success("Copied as Markdown");
  } catch {
    toast.error("Couldn't copy to clipboard");
  }
}

/**
 * Download the current view as an OPML file (ADR 0037). Scope mirrors
 * `copyOutlineAsMarkdown`: the zoom root's subtree (root INCLUDED), or the
 * whole outline at home -- read live at click time. Serialization is entirely
 * the shared core (`exportOpml`); this shell only picks the scope, names the
 * file, and hands the string to the browser.
 *
 * Filename: `dotflowy-export-<YYYY-MM-DD>.opml` at home; a zoomed export
 * swaps `export` for a slug of the root's flattened text
 * (`dotflowy-<slug>-<date>.opml`). The date is the LOCAL calendar day
 * (`localDateKey`, never `toISOString` -- the daily-notes rule).
 */
export function exportOutlineAsOpml() {
  const index = getTreeIndex();
  const rootId = getViewRootId();
  const root = rootId ? (index.byId.get(rootId) ?? null) : null;
  const rootText = root ? flattenInline(root.text) : "";
  const slug = rootText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const date = localDateKey();
  const filename = slug
    ? `dotflowy-${slug}-${date}.opml`
    : `dotflowy-export-${date}.opml`;
  const opml = exportOpml(index, root ? root.id : null, {
    title: rootText || "dotflowy export",
  });
  downloadTextFile(filename, "text/x-opml;charset=utf-8", opml);
}

/**
 * Collect the collapsible nodes under the current view whose `collapsed` flag
 * needs to change to `collapsed`. Scope is the zoom root's subtree (read live at
 * click time), or the whole outline at home -- same contextual rule as
 * `copyOutlineAsMarkdown`. We seed the walk from the root's CHILDREN so the zoom
 * root itself is never collapsed (that would hide the whole view). Only nodes
 * that actually have children are collapsible; leaves are skipped. Already-in-
 * target-state nodes are filtered out so a bulk toggle ships no redundant PATCHes.
 * The walk descends through already-collapsed branches (the index is unaffected
 * by the flag), so "Expand all" reaches every nested node.
 */
function collapsibleTargets(collapsed: boolean) {
  const index = getTreeIndex();
  const rootId = getViewRootId();
  const targets: string[] = [];
  const seen = new Set<string>();
  const stack = childrenOf(index, rootId).map((n) => n.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const kids = childrenOf(index, id);
    if (kids.length === 0) continue;
    if ((index.byId.get(id)?.collapsed ?? false) !== collapsed)
      targets.push(id);
    for (const k of kids) stack.push(k.id);
  }
  return { ids: targets, rootId };
}

/**
 * Collapse or expand every collapsible node under the current view in ONE
 * atomic batch. Wrapped in `runStructural` so N `collapsed` field edits ship as
 * a single DO frame (one round-trip, one broadcast) instead of N PATCHes.
 * Browsing does not enter authoring history (ADR 0064). These are field edits,
 * not chain relinks, so the sibling chain is untouched.
 */
export function setViewCollapsed(collapsed: boolean) {
  const { ids } = collapsibleTargets(collapsed);
  if (ids.length === 0) {
    toast(collapsed ? "Already collapsed" : "Already expanded");
    return;
  }
  runStructural(() => {
    for (const id of ids) toggleCollapsed(id, collapsed);
  });
}

/** Current-view actions and display toggles, separate from account/help (ADR 0072). */
export function HeaderViewMenu() {
  const { globalActions } = usePluginChrome();
  const { showCompleted, setShowCompleted } = useShowCompleted();
  const spotlight = useSpotlightEnabled();

  return (
    <DropdownMenu title="View options">
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" title="View options">
            <HugeiconsIcon icon={SlidersHorizontalIcon} />
            <span className="sr-only">View options</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-44">
        <div
          role="presentation"
          className="px-1.5 py-1 text-xs font-medium text-muted-foreground"
        >
          This view
        </div>
        <DropdownMenuItem onClick={() => setViewCollapsed(true)}>
          <HugeiconsIcon icon={ArrowShrinkIcon} />
          Collapse all
        </DropdownMenuItem>

        <DropdownMenuItem onClick={() => setViewCollapsed(false)}>
          <HugeiconsIcon icon={ArrowExpandIcon} />
          Expand all
        </DropdownMenuItem>

        <DropdownMenuItem onClick={() => void copyOutlineAsMarkdown()}>
          <HugeiconsIcon icon={Copy01Icon} />
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
          <HugeiconsIcon icon={CheckmarkCircle01Icon} />
          Show completed
        </DropdownMenuCheckboxItem>

        <DropdownMenuCheckboxItem
          checked={spotlight}
          onCheckedChange={setSpotlightEnabled}
        >
          <HugeiconsIcon icon={FocusIcon} />
          Spotlight mode
        </DropdownMenuCheckboxItem>

        {globalActions
          .filter((action) => action.menuLabel && action.checked !== undefined)
          .map((action) => (
            <DropdownMenuCheckboxItem
              key={action.id}
              checked={action.checked}
              disabled={action.disabled}
              onCheckedChange={() => action.run()}
            >
              <action.icon />
              {action.menuLabel}
            </DropdownMenuCheckboxItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Account, help, and the unread-release signal live on the avatar (ADR 0072). */
export function HeaderAppMenu() {
  const navigate = useNavigate();
  const { data: session } = useSession();
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
            <Avatar.Root
              aria-hidden="true"
              className="inline-flex size-6 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground"
            >
              <Avatar.Fallback className="flex size-full items-center justify-center">
                {session?.user.email?.charAt(0).toUpperCase() || (
                  <HugeiconsIcon icon={UserIcon} />
                )}
              </Avatar.Fallback>
              <Avatar.Image
                src={session?.user.image ?? undefined}
                alt=""
                referrerPolicy="no-referrer"
                keepMounted
                className="absolute size-6 rounded-full object-cover data-error:invisible data-loading:invisible"
              />
            </Avatar.Root>
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
        <DropdownMenuItem onClick={() => void navigate({ to: "/settings" })}>
          <HugeiconsIcon icon={Settings01Icon} />
          Settings
        </DropdownMenuItem>

        {/* The permanent home for the changelog (ADR 0046). While releases
            are unread, it's emphasized -- bolder text + a solid count pill --
            so the eye lands here once the trigger's dot draws the menu open. */}
        <DropdownMenuItem
          onClick={() => openChangelog()}
          data-unseen={unseen > 0 ? "" : undefined}
          className={unseen > 0 ? "font-medium" : undefined}
        >
          <HugeiconsIcon icon={SparklesIcon} />
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

        <DropdownMenuItem onClick={() => openFeedbackReport()}>
          <HugeiconsIcon icon={BubbleChatNotificationIcon} />
          Report a bug
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
          <HugeiconsIcon icon={File01Icon} />
          Terms
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={() =>
            window.open("/privacy", "_blank", "noopener,noreferrer")
          }
        >
          <HugeiconsIcon icon={ShieldCheckIcon} />
          Privacy Policy
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          variant="destructive"
          onClick={() => signOutAndReload()}
        >
          <HugeiconsIcon icon={Logout01Icon} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
