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
import { TagColorStyles } from '../components/tag-color-menu'
import { Toaster } from '../components/ui/sonner'
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
          <Outlet />
          <NodeSwitcher />
          <MoveDialog />
          <TagColorStyles />
          <Toaster />
        </ShowCompletedProvider>
      </ThemeProvider>
    </RootDocument>
  )
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
