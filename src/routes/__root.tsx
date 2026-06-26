import { Outlet, createRootRoute } from '@tanstack/react-router'
import { ThemeProvider } from '../components/theme-provider'
import { ShowCompletedProvider } from '../components/show-completed-provider'
import { NodeSwitcher } from '../components/node-switcher'
import { MoveDialog } from '../components/move-dialog'
import { TagColorStyles } from '../plugins/tags/tag-color-menu'
import { PluginStyles } from '../components/plugin-styles'
import { Toaster } from '../components/ui/sonner'
import { AuthGate } from '../components/auth-gate'
import { RootDocument } from '../components/root-document'
import '../styles.css'

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
