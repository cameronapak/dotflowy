import { useState } from "react";
import {
  ALargeSmallIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CircleCheckIcon,
  ClipboardCopyIcon,
  FocusIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PlugZapIcon,
  SunIcon,
  SunMoonIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { McpConnectDialog } from "./mcp-connect-dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { signOut } from "../lib/auth-client";
import { useShowCompleted } from "./show-completed-provider";
import {
  setSpotlightEnabled,
  useSpotlightEnabled,
} from "./spotlight-mode";
import { useTheme } from "./theme-provider";
import { useTextSize, type TextSize } from "./text-size-provider";
import { outlineToMarkdown } from "../data/markdown";
import { getTreeIndex } from "../data/tree-store";
import { getViewRootId } from "../data/view-state";
import { childrenOf } from "../data/tree";
import { toggleCollapsed } from "../data/mutations";
import { runStructural } from "../data/structural";
import { capture } from "../data/history";

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
function collapsibleTargets(collapsed: boolean): {
  ids: string[];
  rootId: string | null;
} {
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
    if ((index.byId.get(id)?.collapsed ?? false) !== collapsed) targets.push(id);
    for (const k of kids) stack.push(k.id);
  }
  return { ids: targets, rootId };
}

/**
 * Collapse or expand every collapsible node under the current view in ONE
 * atomic batch. Wrapped in `runStructural` so N `collapsed` field edits ship as
 * a single DO frame (one round-trip, one broadcast) instead of N PATCHes, and a
 * single `capture` before the batch makes it one undo step -- mirroring how the
 * per-row `onToggleCollapsed` command captures once. `runStructural` is generic
 * over any `nodesCollection` write; these are field edits, not chain relinks, so
 * the sibling chain is untouched.
 */
export function setViewCollapsed(collapsed: boolean) {
  const { ids, rootId } = collapsibleTargets(collapsed);
  if (ids.length === 0) {
    toast(collapsed ? "Already collapsed" : "Already expanded");
    return;
  }
  capture(getTreeIndex(), rootId);
  runStructural(() => {
    for (const id of ids) toggleCollapsed(id, collapsed);
  });
}

/**
 * Header overflow ("More") menu. Holds the secondary, set-once controls --
 * theme, text size (ADR 0029), show-completed, sign out -- so the header bar
 * keeps only the primary, frequently reached actions (search, the contextual
 * bookmark star, plugin header slots).
 *
 * This is the static v1 of the header-action overflow: the pinned/overflow
 * split is a fixed default. User-customizable pinning (Chrome-extension style)
 * is the planned v2 and will land with its own ADR + a per-user pin collection.
 *
 * Each control is re-expressed in its native menu idiom (theme = radio submenu,
 * show-completed = checkbox item) so its on/off state still reads from inside
 * the menu, not just as a bar button.
 */
export function HeaderMoreMenu() {
  const { theme, setTheme } = useTheme();
  const { textSize, setTextSize } = useTextSize();
  const { showCompleted, setShowCompleted } = useShowCompleted();
  const spotlight = useSpotlightEnabled();
  // The connect dialog is a sibling of the menu (not nested in its content) so
  // it survives the menu closing on item select.
  const [connectOpen, setConnectOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" title="More">
              <MoreHorizontalIcon />
              <span className="sr-only">More actions</span>
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onClick={copyOutlineAsMarkdown}>
            <ClipboardCopyIcon />
            Copy as Markdown
          </DropdownMenuItem>

          <DropdownMenuItem onClick={() => setConnectOpen(true)}>
            <PlugZapIcon />
            Connect apps (MCP)
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

          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={() => setViewCollapsed(true)}>
            <ChevronsDownUpIcon />
            Collapse all
          </DropdownMenuItem>

          <DropdownMenuItem onClick={() => setViewCollapsed(false)}>
            <ChevronsUpDownIcon />
            Expand all
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SunMoonIcon />
              Theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={theme}
                onValueChange={(value) =>
                  setTheme(value as "light" | "dark" | "system")
                }
              >
                <DropdownMenuRadioItem value="light">
                  <SunIcon />
                  Light
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">
                  <MoonIcon />
                  Dark
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">
                  <MonitorIcon />
                  System
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ALargeSmallIcon />
              Text size
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={textSize}
                onValueChange={(value) => setTextSize(value as TextSize)}
              >
                <DropdownMenuRadioItem value="small">
                  Small
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="default">
                  Default
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="large">
                  Large
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

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

          <DropdownMenuSeparator />

          <DropdownMenuItem variant="destructive" onClick={() => signOut()}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <McpConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </>
  );
}
