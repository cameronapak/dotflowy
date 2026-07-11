import type { ReactNode } from "react";

import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import { AuthScreen } from "../components/auth-screen";
import { ChangelogDialog } from "../components/changelog-dialog";
import { DeleteConfirmDialog } from "../components/delete-confirm-dialog";
import { HistoryRestoreDialog } from "../components/history-restore";
import { MirrorPlaces } from "../components/mirror-places";
import { MoveDialog } from "../components/move-dialog";
import { NodeSwitcher } from "../components/node-switcher";
import { OpmlImportDialog } from "../components/opml-import-dialog";
import { ShowCompletedProvider } from "../components/show-completed-provider";
import { SpotlightController } from "../components/spotlight-mode";
import { TextSizeProvider } from "../components/text-size-provider";
import { ThemeProvider } from "../components/theme-provider";
import { Toaster } from "../components/ui/sonner";
import { UpdateAvailableToast } from "../components/update-available";
import { hardResetToRoot, useSession } from "../lib/auth-client";
import { FAVICON_DARK, FAVICON_LIGHT } from "../lib/favicon";
import {
  LEGACY_THEME_KEY,
  THEME_KEY,
  TEXT_SIZE_KEY,
} from "../lib/storage-keys";
import { TagColorStyles } from "../plugins/tags/tag-color-menu";
import "../styles.css";

// Runs before first paint so the page never flashes the wrong theme. Mirrors
// the resolution logic in theme-provider.tsx (same storage key).
const noFlashThemeScript = `
(function () {
  try {
    var key = '${THEME_KEY}';
    var legacy = '${LEGACY_THEME_KEY}';
    var t = localStorage.getItem(key);
    if (!t) {
      t = localStorage.getItem(legacy);
      if (t) {
        localStorage.setItem(key, t);
        localStorage.removeItem(legacy);
      }
    }
    t = t || 'system';
    var dark = t === 'dark' || (t === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
    var favicon = document.getElementById('dotflowy-favicon');
    if (favicon) favicon.href = dark ? '${FAVICON_DARK}' : '${FAVICON_LIGHT}';
  } catch (e) {}
})();
`;

// Runs before first paint so the outline never flashes the default reading size
// then resizes. Mirrors text-size-provider.tsx (same storage key + attribute).
const noFlashTextSizeScript = `
(function () {
  try {
    var s = localStorage.getItem('${TEXT_SIZE_KEY}');
    if (s === 'small' || s === 'large') {
      document.documentElement.setAttribute('data-text-size', s);
    }
  } catch (e) {}
})();
`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Dotflowy" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <ThemeProvider>
        <TextSizeProvider>
          <AuthGate>
            <ShowCompletedProvider>
              <Outlet />
              <NodeSwitcher />
              <MoveDialog />
              <OpmlImportDialog />
              <DeleteConfirmDialog />
              <HistoryRestoreDialog />
              <ChangelogDialog />
              <MirrorPlaces />
              <TagColorStyles />
              <SpotlightController />
              {/* A distinct mechanism from the changelog (ADR 0046): the
                  changelog says WHAT changed; this says THIS TAB is stale. */}
              <UpdateAvailableToast />
            </ShowCompletedProvider>
          </AuthGate>
        </TextSizeProvider>
        {/* Outside the gate so auth-screen errors can still toast. */}
        <Toaster />
      </ThemeProvider>
    </RootDocument>
  );
}

/**
 * Gate the whole app behind a Better Auth session. The shell is public so this
 * renders the login screen for signed-out visitors; only the editor (and the
 * data API it hits) require a session. While the session is still loading we
 * render nothing to avoid flashing the login screen at an authed user.
 */
/**
 * The user id this page's data-layer singletons first loaded under. A module
 * value (not a ref): it must survive the gate unmounting/remounting and be
 * remembered across an expiry (id → null → different id), where a previous-
 * render comparison would misread the new id as a fresh sign-in.
 */
let firstUserId: string | null = null;

function AuthGate({ children }: Readonly<{ children: ReactNode }>) {
  const { data: session, isPending } = useSession();
  if (isPending) return null;
  if (!session) return <AuthScreen />;
  // Identity guard: the per-call-site reloads (signOutAndReload, AuthScreen)
  // only fire in the tab where the auth action happened. If the account is
  // switched in ANOTHER tab, this tab's session store revalidates to the new
  // user while its singletons and /api/sync socket still belong to the old one
  // — truthiness alone would keep the gate open and route writes to the wrong
  // account. A different id here always means stale in-memory state: reload.
  if (firstUserId === null) {
    firstUserId = session.user.id;
  } else if (session.user.id !== firstUserId) {
    hardResetToRoot();
    return null;
  }
  return <>{children}</>;
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="[scrollbar-gutter:stable]">
      <head>
        <link
          rel="icon"
          type="image/svg+xml"
          href={FAVICON_LIGHT}
          id="dotflowy-favicon"
        />
        <script dangerouslySetInnerHTML={{ __html: noFlashThemeScript }} />
        <script dangerouslySetInnerHTML={{ __html: noFlashTextSizeScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
