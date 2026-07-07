import { useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import {
  ALargeSmallIcon,
  BookmarkIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CircleCheckIcon,
  ClipboardCopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileUpIcon,
  FocusIcon,
  LogOutIcon,
  MessageSquareWarningIcon,
  MonitorIcon,
  MoonIcon,
  PlugZapIcon,
  SunIcon,
} from "lucide-react";
import type { CommandCenterAction } from "../data/command-center";
import { useTree } from "../data/useTree";
import { toggleBookmark } from "../data/mutations";
import { capture } from "../data/history";
import { signOut } from "../lib/auth-client";
import { useShowCompleted } from "./show-completed-provider";
import { setSpotlightEnabled, useSpotlightEnabled } from "./spotlight-mode";
import { useTheme } from "./theme-provider";
import { useTextSize, type TextSize } from "./text-size-provider";
import {
  copyOutlineAsMarkdown,
  exportOutlineAsOpml,
  setViewCollapsed,
} from "./header-more-menu";
import { openOpmlImport } from "./opml-import-opener";
import { openFeedbackReport } from "../data/feedback";

/**
 * The GLOBAL-scope half of the Cmd+K command center (ADR 0034): the header +
 * More-menu actions re-expressed as flat `CommandCenterAction` rows. A hook, not
 * a module singleton, because it lives INSIDE the provider tree (the switcher is
 * mounted in `__root`, under ThemeProvider et al.) and reads those contexts
 * directly -- no bridge needed for globals.
 *
 * Duplication of the action definitions with `header-more-menu.tsx` is accepted
 * (ADR 0034: an action may live in several surfaces); the two NON-trivial ones
 * (Copy as Markdown, Collapse/Expand all) are reused from that module so their
 * logic isn't forked. Stateful multi-value settings (theme, text size) FLATTEN
 * into discrete rows here (keyboard-discoverable) while the More menu keeps its
 * radio submenus. Bookmark view is contextual -- present only when zoomed.
 */
export function useGlobalActions(opts: {
  openConnect: () => void;
}): CommandCenterAction[] {
  const { openConnect } = opts;
  const { theme, setTheme } = useTheme();
  const { textSize, setTextSize } = useTextSize();
  const { showCompleted, setShowCompleted } = useShowCompleted();
  const spotlight = useSpotlightEnabled();
  const { index } = useTree();
  const rootId = useParams({ strict: false }).nodeId ?? null;
  const rootNode = rootId ? (index.byId.get(rootId) ?? null) : null;

  return useMemo(() => {
    const a: CommandCenterAction[] = [
      {
        id: "g:copy-md",
        label: "Copy as Markdown",
        description: "Copy the current view as a markdown list",
        icon: ClipboardCopyIcon,
        scope: "global",
        keywords: ["copy", "markdown", "export", "clipboard"],
        run: () => {
          void copyOutlineAsMarkdown();
        },
      },
      {
        id: "g:import-opml",
        label: "Import OPML…",
        description: "Import a Workflowy OPML export",
        icon: FileUpIcon,
        scope: "global",
        keywords: ["import", "opml", "workflowy", "migrate", "file"],
        run: () => openOpmlImport(),
      },
      {
        id: "g:export-opml",
        label: "Export OPML",
        description: "Download the current view as an OPML file",
        icon: DownloadIcon,
        scope: "global",
        keywords: ["export", "opml", "download", "file", "workflowy", "backup"],
        run: exportOutlineAsOpml,
      },
      {
        id: "g:collapse-all",
        label: "Collapse all",
        description: "Fold every bullet in the current view",
        icon: ChevronsDownUpIcon,
        scope: "global",
        keywords: ["collapse", "fold", "all"],
        run: () => setViewCollapsed(true),
      },
      {
        id: "g:expand-all",
        label: "Expand all",
        description: "Unfold every bullet in the current view",
        icon: ChevronsUpDownIcon,
        scope: "global",
        keywords: ["expand", "unfold", "all"],
        run: () => setViewCollapsed(false),
      },
      {
        id: "g:show-completed",
        label: showCompleted ? "Hide completed" : "Show completed",
        description: "Toggle completed bullets in the view",
        icon: CircleCheckIcon,
        scope: "global",
        keywords: ["completed", "done", "hide", "show", "filter"],
        run: () => setShowCompleted(!showCompleted),
      },
      {
        id: "g:spotlight",
        label: spotlight ? "Turn off spotlight mode" : "Spotlight mode",
        description: "Dim everything but the focused bullet",
        icon: FocusIcon,
        scope: "global",
        keywords: ["spotlight", "focus", "dim", "zen"],
        run: () => setSpotlightEnabled(!spotlight),
      },
    ];

    if (rootNode) {
      const isBookmarked = rootNode.bookmarkedAt != null;
      a.push({
        id: "g:bookmark",
        label: isBookmarked ? "Remove bookmark" : "Bookmark view",
        description: "Save (or unsave) this zoom view",
        icon: BookmarkIcon,
        scope: "global",
        keywords: ["bookmark", "save", "pin", "star"],
        run: () => {
          capture(index, null);
          toggleBookmark(rootNode.id, !isBookmarked);
        },
      });
    }

    const themes: { value: "light" | "dark" | "system"; label: string; icon: typeof SunIcon }[] = [
      { value: "light", label: "Light", icon: SunIcon },
      { value: "dark", label: "Dark", icon: MoonIcon },
      { value: "system", label: "System", icon: MonitorIcon },
    ];
    for (const t of themes) {
      a.push({
        id: `g:theme-${t.value}`,
        label: `Theme: ${t.label}`,
        description:
          theme === t.value ? "Current theme" : `Switch to the ${t.label.toLowerCase()} theme`,
        icon: t.icon,
        scope: "global",
        keywords: ["theme", "appearance", "dark", "light", t.label.toLowerCase()],
        run: () => setTheme(t.value),
      });
    }

    const sizes: TextSize[] = ["small", "default", "large"];
    for (const s of sizes) {
      const label = s.charAt(0).toUpperCase() + s.slice(1);
      a.push({
        id: `g:text-${s}`,
        label: `Text size: ${label}`,
        description:
          textSize === s ? "Current text size" : `Use ${label.toLowerCase()} text`,
        icon: ALargeSmallIcon,
        scope: "global",
        keywords: ["text", "size", "font", "zoom", s],
        run: () => setTextSize(s),
      });
    }

    a.push(
      {
        id: "g:mcp",
        label: "Connect apps (MCP)",
        description: "Connect an AI agent to your outline",
        icon: PlugZapIcon,
        scope: "global",
        keywords: ["mcp", "connect", "apps", "agent", "ai", "claude"],
        run: openConnect,
      },
      {
        id: "g:feedback",
        label: "Report a bug",
        description: "Open a pre-filled GitHub issue",
        icon: MessageSquareWarningIcon,
        scope: "global",
        keywords: ["feedback", "bug", "report", "issue", "problem", "github"],
        run: () => openFeedbackReport(),
      },
      {
        id: "g:github",
        label: "GitHub",
        description: "Open the dotflowy repository",
        icon: ExternalLinkIcon,
        scope: "global",
        keywords: ["github", "source", "code", "repo"],
        run: () =>
          window.open("https://git.new/dotflowy", "_blank", "noopener,noreferrer"),
      },
      {
        id: "g:signout",
        label: "Sign out",
        description: "Sign out of your account",
        icon: LogOutIcon,
        scope: "global",
        keywords: ["sign out", "logout", "log out", "exit"],
        run: () => {
          void signOut();
        },
      },
    );

    return a;
  }, [
    theme,
    setTheme,
    textSize,
    setTextSize,
    showCompleted,
    setShowCompleted,
    spotlight,
    rootNode,
    index,
    openConnect,
  ]);
}
