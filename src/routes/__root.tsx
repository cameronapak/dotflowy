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
import { useDbReady } from '../data/jazz'
import '../styles.css'

// Runs before first paint so the page never flashes the wrong theme. Mirrors
// the resolution logic in theme-provider.tsx (same storage key).
const noFlashThemeScript = `
(function () {
  try {
    var t = localStorage.getItem('dotflowy-oss:theme') || 'system';
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
      { title: 'Dotflowy OSS' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <ThemeProvider>
        <ShowCompletedProvider>
          <DbGate>
            <Outlet />
            <NodeSwitcher />
          </DbGate>
        </ShowCompletedProvider>
      </ThemeProvider>
    </RootDocument>
  )
}

/**
 * Holds back the data-reading UI until the Jazz runtime has loaded the local
 * document (WASM + OPFS startup). Without this gate the outline would flash
 * empty for a beat before the first subscription delta arrives. Observing
 * `useDbReady()` also kicks off the bootstrap on first mount. SPA-only: on the
 * prerendered server pass it is never ready, which is fine (no data there).
 */
function DbGate({ children }: { children: ReactNode }) {
  const ready = useDbReady()
  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">
        Loading your outline...
      </div>
    )
  }
  return <>{children}</>
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
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
