import { useState } from "react";
import {
  ALargeSmallIcon,
  CircleCheckIcon,
  ClipboardCopyIcon,
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
import { useTheme } from "./theme-provider";
import { useTextSize, type TextSize } from "./text-size-provider";
import { outlineToMarkdown } from "../data/markdown";
import { getTreeIndex } from "../data/tree-store";
import { getViewRootId } from "../data/view-state";
import { childrenOf } from "../data/tree";

/**
 * Copy the current view's subtree to the clipboard as a markdown bullet list.
 * Scope is the zoom root (read live at click time), or every top-level node at
 * home -- the header is contextual to the current zoom view. See ADR 0017.
 */
async function copyOutlineAsMarkdown() {
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
