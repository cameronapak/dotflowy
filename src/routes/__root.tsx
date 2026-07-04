import type { ReactNode } from 'react'
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from '@tanstack/react-router'
import { ThemeProvider } from '../components/theme-provider'
import { ShowCompletedProvider } from '../components/show-completed-provider'
import { NodeSwitcher } from '../components/node-switcher'
import { MoveDialog } from '../components/move-dialog'
import { MirrorPlaces } from '../components/mirror-places'
import { TagColorStyles } from '../plugins/tags/tag-color-menu'
import { PluginStyles } from '../components/plugin-styles'
import { Toaster } from '../components/ui/sonner'
import { AuthScreen } from '../components/auth-screen'
import { useSession } from '../lib/auth-client'
import { isDemoMode, installDemoBackend } from '../data/demo-backend'
import { FAVICON_DARK, FAVICON_LIGHT } from '../lib/favicon'
import { LEGACY_THEME_KEY, THEME_KEY } from '../lib/storage-keys'
import '../styles.css'

// Anonymous landing-demo mode (Approach B). Installed at MODULE LOAD — before
// React mounts and before the collection's first subscribe — so the in-memory
// fetch/WebSocket mock is in place by the time the editor connects. No-op unless
// the URL opted in (`?demo=1`); never runs server-side (guarded by window). See
// demo-backend.ts.
if (isDemoMode()) installDemoBackend()

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
`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Dotflowy' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <ThemeProvider>
        <AuthGate>
          <ShowCompletedProvider>
            <Outlet />
            <NodeSwitcher />
            <MoveDialog />
            <MirrorPlaces />
            <TagColorStyles />
            <PluginStyles />
          </ShowCompletedProvider>
        </AuthGate>
        {/* Outside the gate so auth-screen errors can still toast. */}
        <Toaster />
      </ThemeProvider>
    </RootDocument>
  )
}

/**
 * Gate the whole app behind a Better Auth session. The shell is public so this
 * renders the login screen for signed-out visitors; only the editor (and the
 * data API it hits) require a session. While the session is still loading we
 * render nothing to avoid flashing the login screen at an authed user.
 */
function AuthGate({ children }: Readonly<{ children: ReactNode }>) {
  // The anonymous landing demo runs entirely in-memory (demo-backend.ts) and
  // must NOT require — or touch — a real session, so it skips the session gate
  // entirely. Kept hook-free (the real gate is a separate component) so neither
  // branch conditionally calls a hook — the demo path can't take `useSession`,
  // whose stubbed `{ session: null }` would otherwise render the AuthScreen.
  if (isDemoMode()) return <>{children}</>
  return <SessionGate>{children}</SessionGate>
}

/** The real gate: render the editor only behind a Better Auth session, the
 *  login screen otherwise. Always calls `useSession` (never behind a branch). */
function SessionGate({ children }: Readonly<{ children: ReactNode }>) {
  const { data: session, isPending } = useSession()
  if (isPending) return null
  if (!session) return <AuthScreen />
  return <>{children}</>
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  // demo-embed (html.demo-embed in styles.css) makes the document
  // non-scrollable so the landing iframe never traps the visitor's scroll. It
  // must live HERE, in the React-rendered className — React's first commit
  // replaces the whole class attribute, so a pre-render classList.add from
  // demo-backend.ts gets wiped. isDemoMode() is latched at first read, so this
  // is stable for the page session.
  return (
    <html
      lang="en"
      className={`[scrollbar-gutter:stable]${isDemoMode() ? ' demo-embed' : ''}`}
    >
      <head>
        <link
          rel="icon"
          type="image/svg+xml"
          href={FAVICON_LIGHT}
          id="dotflowy-favicon"
        />
        <script dangerouslySetInnerHTML={{ __html: noFlashThemeScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
