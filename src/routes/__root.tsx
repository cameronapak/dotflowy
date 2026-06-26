import { useEffect, type ReactNode } from 'react'
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
import { TagColorStyles } from '../plugins/tags/tag-color-menu'
import { PluginStyles } from '../components/plugin-styles'
import { Toaster } from '../components/ui/sonner'
import { AuthScreen } from '../components/auth-screen'
import { useSession } from '../lib/auth-client'
import { clearIdentity, initClientLog, setIdentity } from '../lib/log'
import { LEGACY_THEME_KEY, THEME_KEY } from '../lib/storage-keys'
import '../styles.css'

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
  // Start the SPA logger once, in the browser (effects don't run at prerender).
  useEffect(() => {
    initClientLog()
  }, [])

  return (
    <RootDocument>
      <ThemeProvider>
        <AuthGate>
          <ShowCompletedProvider>
            <Outlet />
            <NodeSwitcher />
            <MoveDialog />
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
  const { data: session, isPending } = useSession()

  // Stamp the signed-in user onto every client log so per-user bugs are
  // traceable; clear it on sign-out.
  const userId = session?.user.id ?? null
  useEffect(() => {
    if (userId) setIdentity({ userId })
    else clearIdentity()
  }, [userId])

  if (isPending) return null
  if (!session) return <AuthScreen />
  return <>{children}</>
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="[scrollbar-gutter:stable]">
      <head>
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
