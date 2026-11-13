import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import {
  BookmarkIcon,
  CircleCheckIcon,
  CollapseIcon,
  CopyIcon,
  DownloadIcon,
  ExpandIcon,
  ExternalLinkIcon,
  FileUploadIcon,
  FilterIcon,
  FocusIcon,
  LogoutIcon,
  MessageWarningIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  PlugIcon,
  PlusIcon,
  RedoIcon,
  SparklesIcon,
  SunIcon,
  TextSizeIcon,
  UndoIcon,
} from "@/lib/icons";

import type { CommandCenterAction } from "../data/command-center";

import { useEditorFeatures } from "../data/editor-features";
import { openFeedbackReport } from "../data/feedback";
import { useMembership } from "../data/membership";
import { toggleBookmark } from "../data/mutations";
import {
  copyOutlineAsMarkdown,
  exportOutlineAsOpml,
  setViewCollapsed,
} from "../data/outline-actions";
import { useTree } from "../data/useTree";
import { getViewRootId } from "../data/view-state";
import { signOutAndReload } from "../lib/auth-client";
import { usePluginChrome } from "../plugins/registry";
import { openChangelog } from "./changelog-opener";
import { COLOR_THEMES, setColorTheme, useColorTheme } from "./color-theme";
import { restoreHistory, useHistoryState } from "./history-restore";
import { openMembership } from "./membership-opener";
import { openOpmlImport } from "./opml-import-opener";
import { openFilterInput } from "./query-filter-nav";
import { openQuickAdd } from "./quick-add-opener";
import { openSettings } from "./settings-nav";
import { useShowCompleted } from "./show-completed-provider";
import { setSpotlightEnabled, useSpotlightEnabled } from "./spotlight-mode";
import { useTextSize, type TextSize } from "./text-size-provider";
import { useTheme } from "./theme-provider";

/**
 * The GLOBAL-scope half of the Cmd+K command center (ADR 0034): the header +
 * View and App menu actions re-expressed as flat `CommandCenterAction` rows. A hook, not
 * a module singleton, because it lives INSIDE the provider tree (the switcher is
 * mounted in `__root`, under ThemeProvider et al.) and reads those contexts
 * directly -- no bridge needed for globals.
 *
 * Duplication of the action definitions with `header-more-menu.tsx` is accepted
 * (ADR 0034: an action may live in several surfaces); the two NON-trivial ones
 * (Copy as Markdown, Collapse/Expand all) are reused from that module so their
 * logic isn't forked. Stateful multi-value settings (theme, text size) FLATTEN
 * into discrete rows here (keyboard-discoverable), alongside their controls in
 * Settings. Bookmark view is contextual -- present only when zoomed.
 */
export function useGlobalActions(opts: {
  openConnect: () => void;
}): CommandCenterAction[] {
  const { openConnect } = opts;
  const { globalActions } = usePluginChrome();
  const { daily } = useEditorFeatures();
  const { theme, setTheme } = useTheme();
  const colorTheme = useColorTheme();
  const { plan, state: membershipState, legacyLeaf } = useMembership();
  const paid = plan !== null && plan !== "free";
  const { textSize, setTextSize } = useTextSize();
  const { showCompleted, setShowCompleted } = useShowCompleted();
  const spotlight = useSpotlightEnabled();
  const { index } = useTree();
  const rootId = useParams({ strict: false }).nodeId ?? null;
  const rootNode = rootId ? (index.byId.get(rootId) ?? null) : null;
  const history = useHistoryState();

  return useMemo(() => {
    const a: CommandCenterAction[] = [
      {
        id: "g:undo",
        label: history.undoLabel,
        description: "Undo your last outline edit",
        icon: UndoIcon,
        scope: "global",
        keywords: ["undo", "history"],
        hotkey: ["⌘", "Z"],
        disabled: !history.canUndo,
        run: () => restoreHistory("undo"),
      },
      {
        id: "g:redo",
        label: history.redoLabel,
        description: "Redo your last undone edit",
        icon: RedoIcon,
        scope: "global",
        keywords: ["redo", "history"],
        hotkey: ["⌘", "⇧", "Z"],
        disabled: !history.canRedo,
        run: () => restoreHistory("redo"),
      },
      {
        id: "g:quick-add",
        label: "Quick add",
        description: daily
          ? "Capture a thought to Today without leaving where you are"
          : "Capture a thought to the top level without leaving where you are",
        icon: PlusIcon,
        scope: "global",
        keywords: [
          "quick",
          "add",
          "capture",
          "new",
          "inbox",
          "note",
          ...(daily ? ["today"] : []),
        ],
        run: () => openQuickAdd(),
      },
      {
        id: "g:copy-md",
        label: "Copy as Markdown",
        description: "Copy the current view as a markdown list",
        icon: CopyIcon,
        scope: "global",
        keywords: ["copy", "markdown", "export", "clipboard"],
        run: () => {
          void copyOutlineAsMarkdown(getViewRootId());
        },
      },
      {
        id: "g:import-opml",
        label: "Import OPML…",
        description: "Import a Workflowy OPML export",
        icon: FileUploadIcon,
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
        run: () => exportOutlineAsOpml(getViewRootId()),
      },
      {
        id: "g:collapse-all",
        label: "Collapse all",
        description: "Fold every bullet in the current view",
        icon: CollapseIcon,
        scope: "global",
        keywords: ["collapse", "fold", "all"],
        run: () => setViewCollapsed(getViewRootId(), true),
      },
      {
        id: "g:expand-all",
        label: "Expand all",
        description: "Unfold every bullet in the current view",
        icon: ExpandIcon,
        scope: "global",
        keywords: ["expand", "unfold", "all"],
        run: () => setViewCollapsed(getViewRootId(), false),
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
        executionPhase: "after-editor-restore",
        label: spotlight ? "Turn off spotlight mode" : "Spotlight mode",
        description: "Dim everything but the focused bullet",
        icon: FocusIcon,
        scope: "global",
        keywords: ["spotlight", "focus", "dim", "zen"],
        run: () => setSpotlightEnabled(!spotlight),
      },
      {
        id: "g:filter",
        label: "Filter this view",
        description: "Filter by #tag, is:todo, has:link, text, and more",
        icon: FilterIcon,
        scope: "global",
        keywords: ["filter", "search", "query", "find", "tag", "todo"],
        // The opener defers focus so it wins the modal restoration race.
        run: () => openFilterInput(),
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
          toggleBookmark(rootNode.id, !isBookmarked);
        },
      });
    }

    const themes: {
      value: "light" | "dark" | "system";
      label: string;
      icon: typeof SunIcon;
    }[] = [
      { value: "light", label: "Light", icon: SunIcon },
      { value: "dark", label: "Dark", icon: MoonIcon },
      { value: "system", label: "System", icon: MonitorIcon },
    ];
    // Color themes (ADR 0082), then the light/dark Mode.
    for (const t of COLOR_THEMES) {
      const locked =
        plan === "free" &&
        t.id !== "default" &&
        !(legacyLeaf && t.id === "leaf");
      a.push({
        id: `g:color-theme-${t.id}`,
        label: `Theme: ${t.label}`,
        description:
          colorTheme === t.id
            ? "Current theme"
            : locked
              ? "Preview. Keep it with Pro or Founding."
              : `Switch to the ${t.label} theme`,
        disabled: membershipState !== "ready",
        icon: PaletteIcon,
        scope: "global",
        keywords: [
          "theme",
          "color",
          "appearance",
          "palette",
          t.label.toLowerCase(),
        ],
        run: () => {
          if (locked) openSettings("appearance");
          setColorTheme(t.id);
        },
      });
    }
    for (const t of themes) {
      a.push({
        id: `g:theme-${t.value}`,
        label: `Mode: ${t.label}`,
        description:
          theme === t.value
            ? "Current mode"
            : `Switch to ${t.label.toLowerCase()} mode`,
        icon: t.icon,
        scope: "global",
        keywords: [
          "theme",
          "mode",
          "appearance",
          "dark",
          "light",
          t.label.toLowerCase(),
        ],
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
          textSize === s
            ? "Current text size"
            : `Use ${label.toLowerCase()} text`,
        icon: TextSizeIcon,
        scope: "global",
        keywords: ["text", "size", "font", "zoom", s],
        run: () => setTextSize(s),
      });
    }

    a.push(
      {
        id: "g:mcp",
        label: "Connect apps (MCP)",
        description: paid
          ? "Connect an AI agent to your outline"
          : "Included with Pro",
        disabled: membershipState !== "ready",
        icon: PlugIcon,
        scope: "global",
        keywords: ["mcp", "connect", "apps", "agent", "ai", "claude"],
        run: () => (paid ? openConnect() : openMembership("connections")),
      },
      {
        id: "g:changelog",
        label: "What's new",
        description: "Every change to Dotflowy, newest first",
        icon: SparklesIcon,
        scope: "global",
        keywords: ["changelog", "release", "version", "news", "updates"],
        run: () => openChangelog(),
      },
      {
        id: "g:feedback",
        label: paid ? "Send feedback" : "Report a bug",
        description: "Send a private note to Cam without leaving Dotflowy",
        icon: MessageWarningIcon,
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
          window.open(
            "https://git.new/dotflowy",
            "_blank",
            "noopener,noreferrer",
          ),
      },
      {
        id: "g:signout",
        label: "Sign out",
        description: "Sign out of your account",
        icon: LogoutIcon,
        scope: "global",
        keywords: ["sign out", "logout", "log out", "exit"],
        run: () => {
          signOutAndReload();
        },
      },
    );

    return [
      ...a,
      ...globalActions
        .filter((action) => action.available?.(rootId) ?? true)
        .map((action) => ({
          ...action,
          scope: "global" as const,
          run: () => action.run(rootId),
        })),
    ];
  }, [
    globalActions,
    plan,
    paid,
    membershipState,
    legacyLeaf,
    history,
    theme,
    setTheme,
    colorTheme,
    textSize,
    setTextSize,
    showCompleted,
    setShowCompleted,
    spotlight,
    rootId,
    rootNode,
    openConnect,
    daily,
  ]);
}
